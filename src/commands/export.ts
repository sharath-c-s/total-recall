import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildWhere, openDb } from "../store/db.ts";
import type { Event, Observation, SessionRow } from "../types.ts";

export interface ExportFilters {
  agent?: string;
  project?: string;
  since?: number;
}

export interface ExportData {
  exportedAt: number;
  filters: ExportFilters;
  sessions: SessionRow[];
  events: Event[];
  observations: Observation[];
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as number,
    agent: r.agent as SessionRow["agent"],
    project: r.project as string | null,
    cwd: r.cwd as string | null,
    gitBranch: r.git_branch as string | null,
    startedAt: r.started_at as number | null,
    endedAt: r.ended_at as number | null,
    sourcePath: r.source_path as string,
  };
}

function rowToEvent(r: Record<string, unknown>): Event {
  return {
    id: r.id as number,
    sessionId: r.session_id as number,
    agent: r.agent as Event["agent"],
    project: r.project as string | null,
    ts: r.ts as number,
    role: r.role as Event["role"],
    tool: r.tool as string | null,
    text: r.text as string | null,
    toolInput: r.tool_input as string | null,
    toolOutput: r.tool_output as string | null,
    toolOutputBytes: r.tool_output_bytes as number | null,
    contentHash: r.content_hash as string,
  };
}

function rowToObservation(r: Record<string, unknown>): Observation {
  return {
    id: r.id as number,
    memorySessionId: r.memory_session_id as string,
    project: r.project as string,
    text: r.text as string | null,
    type: r.type as string,
    title: r.title as string | null,
    subtitle: r.subtitle as string | null,
    facts: r.facts as string | null,
    narrative: r.narrative as string | null,
    concepts: r.concepts as string | null,
    filesRead: r.files_read as string | null,
    filesModified: r.files_modified as string | null,
    promptNumber: r.prompt_number as number | null,
    discoveryTokens: r.discovery_tokens as number | null,
    createdAt: r.created_at as string,
    createdAtEpoch: r.created_at_epoch as number,
    contentHash: r.content_hash as string | null,
    generatedByModel: r.generated_by_model as string | null,
    relevanceCount: r.relevance_count as number | null,
    mergedIntoProject: r.merged_into_project as string | null,
    agentType: r.agent_type as string | null,
    agentId: r.agent_id as string | null,
    metadata: r.metadata as string | null,
    syncedAt: r.synced_at as number | null,
    originDeviceId: r.origin_device_id as string | null,
    originLocalId: r.origin_local_id as string | null,
    syncRev: r.sync_rev as string,
  };
}

/** Reads observations + events (and the sessions events belong to) into one portable, tool-independent snapshot. */
export function buildExportData(db: Database, filters: ExportFilters = {}): ExportData {
  const eventWhere = buildWhere([
    { column: "agent", value: filters.agent },
    { column: "project", value: filters.project },
    { column: "ts", op: ">=", value: filters.since },
  ]);
  const eventWhereSql = eventWhere.clause ? `WHERE ${eventWhere.clause}` : "";
  const eventRows = db.query(`SELECT * FROM events ${eventWhereSql} ORDER BY ts ASC`).all(...eventWhere.params) as Array<
    Record<string, unknown>
  >;
  const events = eventRows.map(rowToEvent);

  const sessionIds = [...new Set(events.map((e) => e.sessionId))];
  const sessions: SessionRow[] = sessionIds.length
    ? (
        db
          .query(`SELECT * FROM sessions WHERE id IN (${sessionIds.map(() => "?").join(",")})`)
          .all(...sessionIds) as Array<Record<string, unknown>>
      ).map(rowToSession)
    : [];

  const obsWhere = buildWhere([
    { column: "agent_type", value: filters.agent },
    { column: "project", value: filters.project },
    { column: "created_at_epoch", op: ">=", value: filters.since },
  ]);
  const obsWhereSql = obsWhere.clause ? `WHERE ${obsWhere.clause}` : "";
  const obsRows = db
    .query(`SELECT * FROM observations ${obsWhereSql} ORDER BY created_at_epoch ASC`)
    .all(...obsWhere.params) as Array<Record<string, unknown>>;
  const observations = obsRows.map(rowToObservation);

  return { exportedAt: Date.now(), filters, sessions, events, observations };
}

/** Writes the portable JSON archive; returns the path written to (or "-" for stdout). */
export function writeJsonExport(data: ExportData, outPath?: string): string {
  const json = JSON.stringify(data, null, 2);
  if (!outPath) {
    console.log(json);
    return "-";
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json, "utf8");
  return outPath;
}

function isoOrNa(ms: number | null): string {
  return ms === null ? "n/a" : new Date(ms).toISOString();
}

function renderSessionMarkdown(session: SessionRow, events: Event[]): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id} — ${session.agent} — ${session.project ?? "unknown project"}`);
  lines.push("");
  lines.push(`- cwd: ${session.cwd ?? "n/a"}`);
  lines.push(`- git branch: ${session.gitBranch ?? "n/a"}`);
  lines.push(`- started: ${isoOrNa(session.startedAt)}`);
  lines.push(`- ended: ${isoOrNa(session.endedAt)}`);
  lines.push(`- source: ${session.sourcePath}`);
  lines.push("");
  lines.push("## Events");
  lines.push("");
  for (const e of events) {
    const heading = e.tool ? `${isoOrNa(e.ts)} · ${e.role} · ${e.tool}` : `${isoOrNa(e.ts)} · ${e.role}`;
    lines.push(`### ${heading}`);
    lines.push("");
    if (e.text) {
      lines.push(e.text);
      lines.push("");
    }
    if (e.toolInput) {
      lines.push("**tool_input:**");
      lines.push("```");
      lines.push(e.toolInput);
      lines.push("```");
      lines.push("");
    }
    if (e.toolOutput) {
      lines.push("**tool_output:**");
      lines.push("```");
      lines.push(e.toolOutput);
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function renderObservationsDayMarkdown(day: string, observations: Observation[]): string {
  const lines: string[] = [`# Observations — ${day}`, ""];
  for (const o of observations) {
    lines.push(`## ${o.title ?? o.type} (${o.agentType ?? "unknown agent"} / ${o.project})`);
    lines.push("");
    lines.push(`- created: ${o.createdAt}`);
    lines.push(`- type: ${o.type}`);
    lines.push("");
    if (o.narrative) {
      lines.push(o.narrative);
      lines.push("");
    } else if (o.text) {
      lines.push(o.text);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

/** Writes one Markdown file per session under `<outDir>/sessions/` and one per day of observations under `<outDir>/observations/`. */
export function writeMarkdownExport(data: ExportData, outDir: string): string[] {
  const written: string[] = [];
  const eventsBySession = new Map<number, Event[]>();
  for (const e of data.events) {
    const list = eventsBySession.get(e.sessionId) ?? [];
    list.push(e);
    eventsBySession.set(e.sessionId, list);
  }

  if (data.sessions.length > 0) {
    const sessionsDir = join(outDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    for (const session of data.sessions) {
      const events = eventsBySession.get(session.id) ?? [];
      const path = join(sessionsDir, `session-${session.id}-${session.agent}.md`);
      writeFileSync(path, renderSessionMarkdown(session, events), "utf8");
      written.push(path);
    }
  }

  if (data.observations.length > 0) {
    const obsDir = join(outDir, "observations");
    mkdirSync(obsDir, { recursive: true });
    const byDay = new Map<string, Observation[]>();
    for (const o of data.observations) {
      const day = dayKey(o.createdAtEpoch);
      const list = byDay.get(day) ?? [];
      list.push(o);
      byDay.set(day, list);
    }
    for (const [day, obsList] of byDay) {
      const path = join(obsDir, `${day}.md`);
      writeFileSync(path, renderObservationsDayMarkdown(day, obsList), "utf8");
      written.push(path);
    }
  }

  return written;
}

/** `recall export --json|--md [--out PATH] [--agent] [--project] [--since]` */
export function run(args: string[]): void {
  let format: "json" | "md" | null = null;
  let outPath: string | undefined;
  const filters: ExportFilters = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        format = "json";
        break;
      case "--md":
        format = "md";
        break;
      case "--out":
        outPath = args[++i];
        break;
      case "--agent":
        filters.agent = args[++i];
        break;
      case "--project":
        filters.project = args[++i];
        break;
      case "--since":
        filters.since = Number(args[++i]);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  if (!format) {
    console.error("Usage: recall export --json|--md [--out PATH] [--agent] [--project] [--since]");
    process.exit(1);
  }

  const db = openDb();
  try {
    const data = buildExportData(db, filters);
    if (format === "json") {
      const path = writeJsonExport(data, outPath);
      if (path !== "-") console.log(`Wrote JSON export (${data.events.length} events, ${data.observations.length} observations) to ${path}`);
    } else {
      const dir = outPath ?? "./recall-export";
      const written = writeMarkdownExport(data, dir);
      console.log(`Wrote ${written.length} Markdown file(s) to ${dir}`);
    }
  } finally {
    db.close();
  }
}
