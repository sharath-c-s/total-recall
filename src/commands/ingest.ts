import type { Database } from "bun:sqlite";
import { getCursor, insertEvent, insertSession, openDb, upsertCursor } from "../store/db.ts";
import { claudeCodeAdapter } from "../adapters/claude-code.ts";
import { codexAdapter } from "../adapters/codex.ts";
import { opencodeAdapter } from "../adapters/opencode.ts";
import { normalizeEvent } from "../normalize.ts";
import type { Adapter, SessionRef } from "../adapters/base.ts";

const ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, opencodeAdapter];

interface Options {
  agent: string | null;
  sinceEpochMs: number | null;
  backfill: boolean;
  dryRun: boolean;
}

function parseArgs(args: string[]): Options {
  const opts: Options = { agent: null, sinceEpochMs: null, backfill: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent":
        opts.agent = args[++i] ?? null;
        break;
      case "--since":
        opts.sinceEpochMs = parseSince(args[++i]);
        break;
      case "--backfill":
        opts.backfill = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

/** Accepts a relative duration ("7d", "24h", "30m") or an ISO 8601 timestamp. */
function parseSince(value: string | undefined): number {
  if (!value) {
    console.error("--since requires a value (e.g. 7d, 24h, or an ISO timestamp)");
    process.exit(1);
  }
  const m = /^(\d+)(d|h|m)$/.exec(value);
  if (m) {
    const amount = Number(m[1]);
    const unitMs = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
    return Date.now() - amount * unitMs;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid --since value: ${value}`);
    process.exit(1);
  }
  return parsed;
}

interface AgentSummary {
  filesScanned: number;
  eventsAdded: number;
  skippedDupes: number;
}

function wouldDuplicate(db: Database, hash: string): boolean {
  return db.query("SELECT id FROM events WHERE content_hash = ?").get(hash) !== null;
}

function maxCursorValue(a: string, b: string): string {
  return String(Math.max(Number(a) || 0, Number(b) || 0));
}

interface KeepDecision {
  hadStoredCursor: boolean;
  backfill: boolean;
  sinceEpochMs: number | null;
}

/**
 * Resuming (a stored cursor already existed for this source) always keeps
 * everything read back — it is strictly new content. For a source with no
 * stored cursor yet: keep everything with `--backfill`, keep only events at
 * or after `--since`, or (no flags at all) keep nothing and just record the
 * current tail position as the starting baseline ("start from now").
 */
function shouldKeep(ts: number, d: KeepDecision): boolean {
  if (d.hadStoredCursor) return true;
  if (d.sinceEpochMs !== null) return ts >= d.sinceEpochMs;
  return d.backfill;
}

function ingestAdapter(db: Database, adapter: Adapter, opts: Options): AgentSummary {
  const summary: AgentSummary = { filesScanned: 0, eventsAdded: 0, skippedDupes: 0 };
  const sessions = adapter.discoverSessions(db);

  // Group by cursorPath: 1:1 for claude-code/codex (one file, one cursor);
  // many-to-1 for opencode (every session shares the DB's single cursor).
  const groups = new Map<string, SessionRef[]>();
  for (const session of sessions) {
    const group = groups.get(session.cursorPath) ?? [];
    group.push(session);
    groups.set(session.cursorPath, group);
  }

  for (const [cursorPath, group] of groups) {
    summary.filesScanned++;
    const storedCursor = getCursor(db, adapter.name, cursorPath);
    const readFrom = opts.backfill ? "0" : storedCursor ?? "0";
    const decision: KeepDecision = { hadStoredCursor: storedCursor !== null, backfill: opts.backfill, sinceEpochMs: opts.sinceEpochMs };

    let maxNewCursor = readFrom;
    for (const session of group) {
      const { events, newCursor } = adapter.iterEvents(session, readFrom);
      maxNewCursor = maxCursorValue(maxNewCursor, newCursor);

      const keep = events.filter((raw) => shouldKeep(raw.ts, decision));
      if (keep.length === 0) continue;

      if (opts.dryRun) {
        for (const raw of keep) {
          const normalized = normalizeEvent(raw, { agent: session.agent, project: session.project, sourceKey: session.sourcePath });
          if (wouldDuplicate(db, normalized.contentHash)) summary.skippedDupes++;
          else summary.eventsAdded++;
        }
        continue;
      }

      const sessionId = insertSession(db, {
        agent: session.agent,
        project: session.project,
        cwd: session.cwd,
        gitBranch: session.gitBranch,
        startedAt: session.startedAt,
        endedAt: null,
        sourcePath: session.sourcePath,
      });

      for (const raw of keep) {
        const normalized = normalizeEvent(raw, { agent: session.agent, project: session.project, sourceKey: session.sourcePath });
        const result = insertEvent(db, { ...normalized, sessionId });
        if (result.inserted) summary.eventsAdded++;
        else summary.skippedDupes++;
      }
    }

    if (!opts.dryRun) upsertCursor(db, adapter.name, cursorPath, maxNewCursor);
  }

  return summary;
}

/** `recall ingest [--agent claude-code|codex|opencode] [--since <iso|dur>] [--backfill] [--dry-run]` */
export function run(args: string[]): void {
  const opts = parseArgs(args);
  const adapters = opts.agent ? ADAPTERS.filter((a) => a.name === opts.agent) : ADAPTERS;
  if (opts.agent && adapters.length === 0) {
    console.error(`Unknown agent: ${opts.agent}`);
    process.exit(1);
  }

  const db = openDb();
  try {
    for (const adapter of adapters) {
      const summary = ingestAdapter(db, adapter, opts);
      console.log(
        `${adapter.name}: ${summary.filesScanned} file(s)/source(s) scanned, ${summary.eventsAdded} event(s) added, ${summary.skippedDupes} duplicate(s) skipped${opts.dryRun ? " (dry run)" : ""}.`,
      );
    }
  } finally {
    db.close();
  }
}
