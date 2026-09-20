import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defaultDbPath, openDb } from "../store/db.ts";
import { walkFiles } from "../adapters/base.ts";

/** How stale a source can be relative to its ingest cursor before doctor calls it stalled. */
const DEFAULT_STALL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface AdapterHealth {
  agent: "claude-code" | "codex" | "opencode";
  source: string;
  readable: boolean;
  /** File count for the two log-tailing adapters, row count for opencode's DB. */
  itemCount: number | null;
  lastModified: number | null;
  lastIngestAt: number | null;
  stalled: boolean;
  note: string | null;
}

export interface DoctorReport {
  dbPath: string;
  reachable: boolean;
  counts: { events: number; observations: number; sessions: number } | null;
  adapters: AdapterHealth[];
  stalled: boolean;
  stalledAgents: string[];
}

/**
 * Counts files matching `matches` under `dir` and tracks the newest mtime. `matches` receives
 * the full path (like `walkFiles`'s predicate, which this reuses for the recursive directory walk).
 */
function walkCount(dir: string, matches: (path: string) => boolean): { count: number; lastModified: number | null } {
  const files = walkFiles(dir, matches);
  let lastModified: number | null = null;
  for (const file of files) {
    try {
      const mtimeMs = statSync(file).mtimeMs;
      if (lastModified === null || mtimeMs > lastModified) lastModified = mtimeMs;
    } catch {
      // Unreadable file mid-walk; skip it, keep counting the rest.
    }
  }
  return { count: files.length, lastModified };
}

function lastIngestAt(db: Database, agent: string): number | null {
  const row = db
    .query("SELECT MAX(updated_at) as t FROM ingest_cursors WHERE agent = ?")
    .get(agent) as { t: number | null } | undefined;
  return row?.t ?? null;
}

function checkLogDirAdapter(
  db: Database,
  agent: "claude-code" | "codex",
  dir: string,
  matches: (path: string) => boolean,
  stallThresholdMs: number,
): AdapterHealth {
  if (!existsSync(dir)) {
    return {
      agent,
      source: dir,
      readable: false,
      itemCount: null,
      lastModified: null,
      lastIngestAt: lastIngestAt(db, agent),
      stalled: false,
      note: "directory not found",
    };
  }

  const { count, lastModified } = walkCount(dir, matches);
  const ingestAt = lastIngestAt(db, agent);
  const hasData = count > 0;
  const stalled = hasData && (ingestAt === null || (lastModified !== null && lastModified - ingestAt > stallThresholdMs));

  return {
    agent,
    source: dir,
    readable: true,
    itemCount: count,
    lastModified,
    lastIngestAt: ingestAt,
    stalled,
    note: hasData && ingestAt === null ? "has data, never ingested" : null,
  };
}

function checkOpencodeAdapter(db: Database, dbPath: string, stallThresholdMs: number): AdapterHealth {
  const agent = "opencode" as const;
  if (!existsSync(dbPath)) {
    return {
      agent,
      source: dbPath,
      readable: false,
      itemCount: null,
      lastModified: null,
      lastIngestAt: lastIngestAt(db, agent),
      stalled: false,
      note: "db file not found",
    };
  }

  const lastModified = statSync(dbPath).mtimeMs;
  let messageCount: number | null = null;
  let sessionCount: number | null = null;
  let readable = true;
  let note: string | null = null;
  try {
    const src = new Database(dbPath, { readonly: true });
    try {
      messageCount = (src.query("SELECT COUNT(*) as c FROM message").get() as { c: number } | undefined)?.c ?? null;
      sessionCount = (src.query("SELECT COUNT(*) as c FROM session").get() as { c: number } | undefined)?.c ?? null;
    } finally {
      src.close();
    }
  } catch (err) {
    readable = false;
    note = `unreadable or unexpected schema: ${(err as Error).message}`;
  }

  const ingestAt = lastIngestAt(db, agent);
  const hasData = readable && (messageCount ?? 0) > 0;
  const stalled = hasData && (ingestAt === null || lastModified - ingestAt > stallThresholdMs);
  if (readable && note === null) {
    note = `sessions=${sessionCount ?? "?"} messages=${messageCount ?? "?"}`;
  }

  return {
    agent,
    source: dbPath,
    readable,
    itemCount: messageCount,
    lastModified,
    lastIngestAt: ingestAt,
    stalled,
    note,
  };
}

/** Computes the full health report against an already-open DB. Never throws; adapter failures degrade to `readable: false`. */
export function buildReport(
  db: Database,
  opts: { claudeDir?: string; codexDir?: string; opencodeDbPath?: string; stallThresholdMs?: number } = {},
): DoctorReport {
  const stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude", "projects");
  const codexDir = opts.codexDir ?? join(homedir(), ".codex", "sessions");
  const opencodeDbPath = opts.opencodeDbPath ?? join(homedir(), ".local", "share", "opencode", "opencode.db");

  const counts = {
    events: (db.query("SELECT COUNT(*) as c FROM events").get() as { c: number }).c,
    observations: (db.query("SELECT COUNT(*) as c FROM observations").get() as { c: number }).c,
    sessions: (db.query("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c,
  };

  const adapters: AdapterHealth[] = [
    checkLogDirAdapter(db, "claude-code", claudeDir, (path) => path.endsWith(".jsonl"), stallThresholdMs),
    checkLogDirAdapter(
      db,
      "codex",
      codexDir,
      (path) => basename(path).startsWith("rollout-") && path.endsWith(".jsonl"),
      stallThresholdMs,
    ),
    checkOpencodeAdapter(db, opencodeDbPath, stallThresholdMs),
  ];

  const stalledAgents = adapters.filter((a) => a.stalled).map((a) => a.agent);

  return {
    dbPath: defaultDbPath(),
    reachable: true,
    counts,
    adapters,
    stalled: stalledAgents.length > 0,
    stalledAgents,
  };
}

function fmtTime(ms: number | null): string {
  return ms === null ? "never" : new Date(ms).toISOString();
}

function renderHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`recall doctor — db: ${report.dbPath}`);
  lines.push(`  events=${report.counts?.events} observations=${report.counts?.observations} sessions=${report.counts?.sessions}`);
  lines.push("");
  lines.push("adapters:");
  for (const a of report.adapters) {
    const flag = a.stalled ? " *** STALLED ***" : a.readable ? "ok" : "n/a";
    const items = a.itemCount === null ? "n/a" : String(a.itemCount);
    lines.push(
      `  ${a.agent.padEnd(11)} ${a.source}\n` +
        `    items=${items} last_modified=${fmtTime(a.lastModified)} last_ingest=${fmtTime(a.lastIngestAt)} ${flag}` +
        (a.note ? ` (${a.note})` : ""),
    );
  }
  lines.push("");
  lines.push(
    report.stalled
      ? `*** STATUS: STALLED — capture is behind for: ${report.stalledAgents.join(", ")} ***`
      : "STATUS: ok — no adapter is behind its cursor",
  );
  return lines.join("\n");
}

/** `recall doctor [--json]` */
export function run(args: string[]): void {
  const json = args.includes("--json");

  let db: Database;
  try {
    db = openDb();
  } catch (err) {
    const message = `recall doctor: database unreachable at ${defaultDbPath()}: ${(err as Error).message}`;
    if (json) {
      console.log(JSON.stringify({ dbPath: defaultDbPath(), reachable: false, error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    const report = buildReport(db);
    console.log(json ? JSON.stringify(report, null, 2) : renderHuman(report));
    process.exit(report.stalled ? 1 : 0);
  } finally {
    db.close();
  }
}
