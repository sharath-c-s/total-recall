import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { contentHash, getCursor, insertEvent, insertSession, openDb, search, upsertCursor } from "../src/store/db.ts";

const DB_PATH = "/tmp/total-recall-test-db.sqlite";

let db: Database;

beforeEach(() => {
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  db = openDb(DB_PATH);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
});

describe("schema", () => {
  test("applies idempotently", () => {
    // Re-opening the same path re-runs applySchema(); IF NOT EXISTS DDL must not throw.
    const again = openDb(DB_PATH);
    const tables = again
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("events");
    expect(tables.map((t) => t.name)).toContain("observations");
    again.close();
  });
});

describe("sessions + events", () => {
  test("insert and search roundtrip finds content via FTS", () => {
    const sessionId = insertSession(db, {
      agent: "claude-code",
      project: "total-recall",
      cwd: "/tmp/total-recall",
      gitBranch: "main",
      startedAt: 1_700_000_000,
      endedAt: null,
      sourcePath: "/fake/session-1.jsonl",
    });

    const hash = contentHash("assistant", "fixed the bigquery column position mismatch");
    const result = insertEvent(db, {
      sessionId,
      agent: "claude-code",
      project: "total-recall",
      ts: 1_700_000_100,
      role: "assistant",
      tool: null,
      text: "fixed the bigquery column position mismatch",
      toolInput: null,
      toolOutput: null,
      toolOutputBytes: null,
      contentHash: hash,
    });
    expect(result.inserted).toBe(true);

    const hits = search(db, "bigquery column");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("events");
    expect(hits[0].snippet).toContain("bigquery");
  });

  test("insertEvent dedupes by content_hash", () => {
    const sessionId = insertSession(db, {
      agent: "codex",
      project: "p",
      cwd: null,
      gitBranch: null,
      startedAt: null,
      endedAt: null,
      sourcePath: "/fake/session-2.jsonl",
    });
    const hash = contentHash("user", "same prompt twice");
    const e = {
      sessionId,
      agent: "codex" as const,
      project: "p",
      ts: 1,
      role: "user" as const,
      tool: null,
      text: "same prompt twice",
      toolInput: null,
      toolOutput: null,
      toolOutputBytes: null,
      contentHash: hash,
    };
    const first = insertEvent(db, e);
    const second = insertEvent(db, e);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe("ingest_cursors", () => {
  test("upsertCursor then getCursor roundtrip", () => {
    expect(getCursor(db, "claude-code", "/fake/a.jsonl")).toBeNull();
    upsertCursor(db, "claude-code", "/fake/a.jsonl", "1024");
    expect(getCursor(db, "claude-code", "/fake/a.jsonl")).toBe("1024");
    upsertCursor(db, "claude-code", "/fake/a.jsonl", "2048");
    expect(getCursor(db, "claude-code", "/fake/a.jsonl")).toBe("2048");
  });
});
