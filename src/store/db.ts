import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Event, Observation, SearchFilters, SearchHit, SessionRow } from "../types.ts";

const SCHEMA_VERSION = 1;
const SCHEMA_PATH = join(import.meta.dir, "schema.sql");

/** Default DB path is `~/.total-recall/recall.db`; `TOTAL_RECALL_DB` overrides it. */
export function defaultDbPath(): string {
  return process.env.TOTAL_RECALL_DB ?? join(homedir(), ".total-recall", "recall.db");
}

/** sha256 hex digest, used as the dedup key for events and (when missing) observations. */
export function contentHash(...parts: Array<string | null | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex");
}

export function openDb(path: string = defaultDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  return db;
}

/**
 * Applies schema.sql once per schema_versions bump. Re-running is a no-op (all DDL is IF NOT EXISTS).
 * This only covers additive changes (new tables/indexes); a non-additive migration (column rename/drop,
 * type change) needs its own explicit ALTER step here, not just a SCHEMA_VERSION bump, since IF NOT EXISTS
 * DDL will silently no-op against an already-existing, differently-shaped table.
 */
function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = (db.query("SELECT MAX(version) as v FROM schema_versions").get() as { v: number | null })?.v;
  if (applied !== null && applied !== undefined && applied >= SCHEMA_VERSION) {
    return;
  }
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.query("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(
    SCHEMA_VERSION,
    Date.now(),
  );
}

export function insertSession(db: Database, s: Omit<SessionRow, "id">): number {
  const row = db
    .query(
      `INSERT INTO sessions (agent, project, cwd, git_branch, started_at, ended_at, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET ended_at = excluded.ended_at
       RETURNING id`,
    )
    .get(s.agent, s.project, s.cwd, s.gitBranch, s.startedAt, s.endedAt, s.sourcePath) as { id: number };
  return row.id;
}

export interface InsertEventResult {
  inserted: boolean;
  id: number | null;
}

/** Inserts one event, deduped by content_hash. Returns inserted=false on a duplicate (no-op). */
export function insertEvent(db: Database, e: Omit<Event, "id">): InsertEventResult {
  const existing = db.query("SELECT id FROM events WHERE content_hash = ?").get(e.contentHash) as
    | { id: number }
    | undefined;
  if (existing) {
    return { inserted: false, id: existing.id };
  }
  const row = db
    .query(
      `INSERT INTO events (session_id, agent, project, ts, role, tool, text, tool_input, tool_output, tool_output_bytes, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      e.sessionId,
      e.agent,
      e.project,
      e.ts,
      e.role,
      e.tool,
      e.text,
      e.toolInput,
      e.toolOutput,
      e.toolOutputBytes,
      e.contentHash,
    ) as { id: number };
  return { inserted: true, id: row.id };
}

export function getCursor(db: Database, agent: string, sourcePath: string): string | null {
  const row = db
    .query("SELECT cursor FROM ingest_cursors WHERE agent = ? AND source_path = ?")
    .get(agent, sourcePath) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

export function upsertCursor(db: Database, agent: string, sourcePath: string, cursor: string): void {
  db.query(
    `INSERT INTO ingest_cursors (agent, source_path, cursor, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent, source_path) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).run(agent, sourcePath, cursor, Date.now());
}

export interface InsertObservationResult {
  inserted: boolean;
  id: number | null;
}

/** Inserts one observation, deduped by content_hash (computed from identity fields if the source left it null). */
export function insertObservation(db: Database, o: Omit<Observation, "id">): InsertObservationResult {
  const hash = o.contentHash ?? contentHash(o.memorySessionId, o.project, o.type, o.title, o.text, String(o.createdAtEpoch));
  const existing = db.query("SELECT id FROM observations WHERE content_hash = ?").get(hash) as
    | { id: number }
    | undefined;
  if (existing) {
    return { inserted: false, id: existing.id };
  }
  const row = db
    .query(
      `INSERT INTO observations (
         memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch,
         content_hash, generated_by_model, relevance_count, merged_into_project, agent_type, agent_id,
         metadata, synced_at, origin_device_id, origin_local_id, sync_rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      o.memorySessionId,
      o.project,
      o.text,
      o.type,
      o.title,
      o.subtitle,
      o.facts,
      o.narrative,
      o.concepts,
      o.filesRead,
      o.filesModified,
      o.promptNumber,
      o.discoveryTokens,
      o.createdAt,
      o.createdAtEpoch,
      hash,
      o.generatedByModel,
      o.relevanceCount,
      o.mergedIntoProject,
      o.agentType,
      o.agentId,
      o.metadata,
      o.syncedAt,
      o.originDeviceId,
      o.originLocalId,
      o.syncRev,
    ) as { id: number };
  return { inserted: true, id: row.id };
}

/**
 * Escapes a raw user query for FTS5 MATCH by quoting each whitespace-separated
 * token as a literal FTS5 string (embedded `"` doubled, per FTS5's own escaping
 * rule). This makes every token match literally instead of being parsed as FTS5
 * query syntax, so a `:`, a leading `-`, an unbalanced `"`, or a bare
 * AND/OR/NOT/NEAR keyword in user input is searched for as text, not a query
 * operator, and never throws a MATCH syntax error.
 */
export function escapeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

interface WhereCondition {
  column: string;
  op?: "=" | ">=";
  value: SQLQueryBindings | undefined | null;
}

/**
 * Builds a `col op ? AND col op ? ...` fragment (no leading AND/WHERE) plus its
 * bound params, skipping any condition whose value is null/undefined. Shared by
 * `search()`, `buildExportData()`, and the MCP `timeline` tool so the
 * agent/project/since/type filter logic lives in one place.
 */
export function buildWhere(conditions: WhereCondition[]): { clause: string; params: SQLQueryBindings[] } {
  const parts: string[] = [];
  const params: SQLQueryBindings[] = [];
  for (const c of conditions) {
    if (c.value === undefined || c.value === null || c.value === "") continue;
    parts.push(`${c.column} ${c.op ?? "="} ?`);
    params.push(c.value);
  }
  return { clause: parts.join(" AND "), params };
}

interface EventSearchRow {
  id: number;
  agent: string;
  project: string | null;
  ts: number;
  title: string;
  snippet: string;
  rank: number;
}

interface ObservationSearchRow {
  id: number;
  agent: string | null;
  project: string;
  ts: number;
  title: string | null;
  snippet: string;
  rank: number;
}

/**
 * Searches events_fts and observations_fts with bm25() ranking, merges, applies
 * filters, and returns a unified list. The query is escaped (see
 * `escapeFtsQuery`) before being bound to MATCH, and each MATCH query is
 * wrapped in try/catch: any FTS5 syntax error degrades that table to no hits
 * instead of throwing and crashing the caller (CLI `recall search`, the MCP
 * `search` tool).
 */
export function search(db: Database, query: string, filters: SearchFilters = {}): SearchHit[] {
  const limit = filters.limit ?? 20;
  const matchQuery = escapeFtsQuery(query);
  const hits: SearchHit[] = [];

  const eventWhere = buildWhere([
    { column: "e.agent", value: filters.agent },
    { column: "e.project", value: filters.project },
    { column: "e.ts", op: ">=", value: filters.since },
    // `type` maps to event role for events_fts (no separate type column on events).
    { column: "e.role", value: filters.type },
  ]);
  try {
    const eventRows = db
      .query(
        `SELECT e.id as id, e.agent as agent, e.project as project, e.ts as ts, e.role as title,
                snippet(events_fts, -1, '[', ']', '...', 10) as snippet,
                bm25(events_fts) as rank
         FROM events_fts
         JOIN events e ON e.id = events_fts.rowid
         WHERE events_fts MATCH ? ${eventWhere.clause ? `AND ${eventWhere.clause}` : ""}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(matchQuery, ...eventWhere.params, limit) as EventSearchRow[];
    for (const r of eventRows) {
      hits.push({ source: "events", id: r.id, agent: r.agent, project: r.project, ts: r.ts, title: r.title, snippet: r.snippet, rank: r.rank });
    }
  } catch {
    // Invalid/unsupported FTS5 query syntax: no event hits rather than a crash.
  }

  const obsWhere = buildWhere([
    { column: "o.agent_type", value: filters.agent },
    { column: "o.project", value: filters.project },
    { column: "o.created_at_epoch", op: ">=", value: filters.since },
    { column: "o.type", value: filters.type },
  ]);
  try {
    const obsRows = db
      .query(
        `SELECT o.id as id, o.agent_type as agent, o.project as project, o.created_at_epoch as ts, o.title as title,
                snippet(observations_fts, -1, '[', ']', '...', 10) as snippet,
                bm25(observations_fts) as rank
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ? ${obsWhere.clause ? `AND ${obsWhere.clause}` : ""}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(matchQuery, ...obsWhere.params, limit) as ObservationSearchRow[];
    for (const r of obsRows) {
      hits.push({ source: "observations", id: r.id, agent: r.agent, project: r.project, ts: r.ts, title: r.title, snippet: r.snippet, rank: r.rank });
    }
  } catch {
    // Invalid/unsupported FTS5 query syntax: no observation hits rather than a crash.
  }

  hits.sort((a, b) => a.rank - b.rank);
  return hits.slice(0, limit);
}
