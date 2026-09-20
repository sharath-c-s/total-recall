import { basename, join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type { Adapter, IterEventsResult, RawEvent, SessionRef } from "./base.ts";

const SOURCE_PREFIX = "opencode:";

/** Default path to opencode's SQLite store; `OPENCODE_DB_PATH` overrides for tests. */
export function defaultOpencodeDbPath(): string {
  return process.env.OPENCODE_DB_PATH ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
}

interface ToolPartState {
  status?: string;
  input?: unknown;
  output?: unknown;
}

interface PartData {
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolPartState;
}

interface MessageData {
  role?: string;
}

/** Opens opencode's own store read-only; never returns null unless the file is missing or unreadable. */
function openReadonly(dbPath: string): Database | null {
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null; // opencode not installed, or the DB doesn't exist yet
  }
}

function outputToText(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  return typeof output === "string" ? output : JSON.stringify(output);
}

export const opencodeAdapter: Adapter = {
  name: "opencode",

  discoverSessions(_db: Database): SessionRef[] {
    const dbPath = defaultOpencodeDbPath();
    const source = openReadonly(dbPath);
    if (!source) return [];
    try {
      const rows = source
        .query("SELECT id, directory, time_created FROM session")
        .all() as Array<{ id: string; directory: string; time_created: number }>;
      return rows.map(
        (row) =>
          ({
            agent: "opencode",
            sourcePath: `${SOURCE_PREFIX}${row.id}`,
            cursorPath: dbPath,
            cwd: row.directory ?? null,
            project: row.directory ? basename(row.directory) : null,
            gitBranch: null, // not tracked in opencode's schema
            startedAt: row.time_created ?? null,
          }) satisfies SessionRef,
      );
    } catch {
      return []; // schema drift (see PLAN.md risk #2): fail soft, don't crash the whole ingest run
    } finally {
      source.close();
    }
  },

  iterEvents(session: SessionRef, fromCursor: string | null): IterEventsResult {
    const fromTs = fromCursor ? Number(fromCursor) : 0;
    const nativeId = session.sourcePath.slice(SOURCE_PREFIX.length);
    const dbPath = defaultOpencodeDbPath();
    const source = openReadonly(dbPath);
    if (!source) return { events: [], newCursor: String(fromTs) };

    const events: RawEvent[] = [];
    let maxTs = fromTs;
    try {
      // `time_created` is coarse (ms) and multiple parts can share the cursor's max value,
      // so a strict `>` would silently drop same-timestamp siblings of the boundary row on
      // the next run. `>=` re-includes that boundary row; that's safe (not a duplicate)
      // because insertEvent() dedupes by content_hash downstream, so a re-seen row is
      // never inserted twice. A per-row composite (time_created, id) cursor was considered
      // but rejected: opencode shares one cursor across every session in its DB (see
      // discoverSessions/cursorPath), and ingest.ts's cross-session cursor merge only
      // reasons about a single numeric high-water mark, not a composite key.
      const rows = source
        .query(
          `SELECT part.data as pdata, part.time_created as pts, message.data as mdata
           FROM part
           JOIN message ON message.id = part.message_id
           WHERE part.session_id = ? AND part.time_created >= ?
           ORDER BY part.time_created ASC, part.id ASC`,
        )
        .all(nativeId, fromTs) as Array<{ pdata: string; pts: number; mdata: string }>;

      for (const row of rows) {
        maxTs = Math.max(maxTs, row.pts);
        let part: PartData;
        let message: MessageData;
        try {
          part = JSON.parse(row.pdata) as PartData;
          message = JSON.parse(row.mdata) as MessageData;
        } catch {
          continue; // malformed row: skip, don't crash
        }

        if (part.type === "text" && typeof part.text === "string") {
          const role = message.role === "user" ? "user" : "assistant";
          events.push({ ts: row.pts, role, tool: null, text: part.text, toolInput: null, toolOutput: null });
        } else if (part.type === "tool") {
          events.push({
            ts: row.pts,
            role: "tool",
            tool: part.tool ?? null,
            text: null,
            toolInput: part.state?.input ?? null,
            toolOutput: outputToText(part.state?.output),
          });
        }
        // reasoning, step-start, step-finish, patch: not answer-bearing on their own, skip.
      }
    } catch {
      return { events: [], newCursor: String(fromTs) }; // schema drift: fail soft
    } finally {
      source.close();
    }

    return { events, newCursor: String(maxTs) };
  },
};
