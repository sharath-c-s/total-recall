import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildExportData, writeJsonExport, writeMarkdownExport } from "../src/commands/export.ts";
import { contentHash, insertEvent, insertObservation, insertSession, openDb } from "../src/store/db.ts";

const DB_PATH = "/tmp/total-recall-test-export.sqlite";
const OUT_DIR = "/tmp/total-recall-test-export-out";
const OUT_JSON = "/tmp/total-recall-test-export-out.json";

let db: Database;

beforeEach(() => {
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  db = openDb(DB_PATH);

  const sessionId = insertSession(db, {
    agent: "claude-code",
    project: "total-recall",
    cwd: "/tmp/total-recall",
    gitBranch: "main",
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_500,
    sourcePath: "/fake/export-session.jsonl",
  });

  insertEvent(db, {
    sessionId,
    agent: "claude-code",
    project: "total-recall",
    ts: 1_700_000_100,
    role: "user",
    tool: null,
    text: "fix the bigquery column position mismatch",
    toolInput: null,
    toolOutput: null,
    toolOutputBytes: null,
    contentHash: contentHash("user", "fix the bigquery column position mismatch"),
  });
  insertEvent(db, {
    sessionId,
    agent: "claude-code",
    project: "total-recall",
    ts: 1_700_000_200,
    role: "tool",
    tool: "bash",
    text: null,
    toolInput: "SELECT * FROM bigquery_table",
    toolOutput: "42 rows",
    toolOutputBytes: 7,
    contentHash: contentHash("tool", "SELECT * FROM bigquery_table"),
  });

  insertObservation(db, {
    memorySessionId: "sess-1",
    project: "total-recall",
    text: "resolved the bigquery mismatch",
    type: "insight",
    title: "BigQuery column fix",
    subtitle: null,
    facts: null,
    narrative: "Renamed the column to match the destination schema.",
    concepts: null,
    filesRead: null,
    filesModified: null,
    promptNumber: null,
    discoveryTokens: null,
    createdAt: new Date(1_700_000_300 * 1000).toISOString(),
    createdAtEpoch: 1_700_000_300,
    contentHash: null,
    generatedByModel: null,
    relevanceCount: null,
    mergedIntoProject: null,
    agentType: "claude-code",
    agentId: null,
    metadata: null,
    syncedAt: null,
    originDeviceId: null,
    originLocalId: null,
    syncRev: "1",
  });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
  rmSync(OUT_DIR, { recursive: true, force: true });
  if (existsSync(OUT_JSON)) rmSync(OUT_JSON);
});

describe("export: buildExportData", () => {
  test("reads sessions, events, and observations", () => {
    const data = buildExportData(db);
    expect(data.sessions.length).toBe(1);
    expect(data.events.length).toBe(2);
    expect(data.observations.length).toBe(1);
  });

  test("applies project filter", () => {
    const data = buildExportData(db, { project: "no-such-project" });
    expect(data.events.length).toBe(0);
    expect(data.observations.length).toBe(0);
  });
});

describe("export: JSON", () => {
  test("writes valid, parseable JSON with the expected shape", () => {
    const data = buildExportData(db);
    const path = writeJsonExport(data, OUT_JSON);
    expect(path).toBe(OUT_JSON);
    const parsed = JSON.parse(readFileSync(OUT_JSON, "utf8"));
    expect(parsed.events.length).toBe(2);
    expect(parsed.observations.length).toBe(1);
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0].sourcePath).toBe("/fake/export-session.jsonl");
  });
});

describe("export: Markdown", () => {
  test("writes one session file and one observations-by-day file, both readable", () => {
    const data = buildExportData(db);
    const written = writeMarkdownExport(data, OUT_DIR);
    expect(written.length).toBe(2);

    const sessionFile = written.find((p) => p.includes("sessions/"))!;
    const sessionMd = readFileSync(sessionFile, "utf8");
    expect(sessionMd).toContain("# Session");
    expect(sessionMd).toContain("bigquery column position mismatch");
    expect(sessionMd).toContain("SELECT * FROM bigquery_table");

    const obsFile = written.find((p) => p.includes("observations/"))!;
    const obsMd = readFileSync(obsFile, "utf8");
    expect(obsMd).toContain("BigQuery column fix");
    expect(obsMd).toContain("Renamed the column to match the destination schema.");
  });

  test("writes nothing for an empty export", () => {
    const empty = { exportedAt: Date.now(), filters: {}, sessions: [], events: [], observations: [] };
    const written = writeMarkdownExport(empty, join(OUT_DIR, "empty"));
    expect(written.length).toBe(0);
  });
});
