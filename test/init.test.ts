import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands/init.ts";

const CC_ROOT = "/tmp/total-recall-test-init-cc-projects";
const DB_PATH = "/tmp/total-recall-test-init.sqlite";
const CLAUDE_CONFIG = "/tmp/total-recall-test-init-claude.json";

function rmrf(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function writeFixtureSession(file: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const lines = [
    {
      type: "user",
      message: { role: "user", content: "a fixture prompt" },
      uuid: "u1",
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd: "/fake/project",
      sessionId: "s1",
      gitBranch: "main",
    },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function countEvents(): number {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.query("SELECT COUNT(*) as c FROM events").get() as { c: number };
  db.close();
  return row.c;
}

beforeEach(() => {
  rmrf(CC_ROOT);
  rmrf(CLAUDE_CONFIG);
  for (const suffix of ["", "-wal", "-shm"]) rmrf(DB_PATH + suffix);
  process.env.CLAUDE_CODE_PROJECTS_DIR = CC_ROOT;
  process.env.CODEX_SESSIONS_DIR = "/tmp/total-recall-test-init-codex-empty";
  process.env.OPENCODE_DB_PATH = "/tmp/total-recall-test-init-opencode-missing.db";
  process.env.TOTAL_RECALL_DB = DB_PATH;
  process.env.TOTAL_RECALL_CLAUDE_CONFIG = CLAUDE_CONFIG;
});

afterEach(() => {
  rmrf(CC_ROOT);
  rmrf(CLAUDE_CONFIG);
  for (const suffix of ["", "-wal", "-shm"]) rmrf(DB_PATH + suffix);
  delete process.env.CLAUDE_CODE_PROJECTS_DIR;
  delete process.env.CODEX_SESSIONS_DIR;
  delete process.env.OPENCODE_DB_PATH;
  delete process.env.TOTAL_RECALL_DB;
  delete process.env.TOTAL_RECALL_CLAUDE_CONFIG;
});

describe("recall init --backfill (MAJOR regression: was a dead/misleading stub)", () => {
  test("does not print the old 'not yet available' message", () => {
    writeFixtureSession(join(CC_ROOT, "-fake-project", "session-1.jsonl"));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      run(["--agents", "claude-code", "--no-hooks", "--backfill"]);
    } finally {
      console.log = originalLog;
    }
    const output = logs.join("\n");
    expect(output).not.toContain("not yet available");
    expect(output).not.toContain("cursors were not seeded");
  });

  test("actually runs an ingest backfill: events land in the store and a cursor is seeded", () => {
    writeFixtureSession(join(CC_ROOT, "-fake-project", "session-1.jsonl"));

    run(["--agents", "claude-code", "--no-hooks", "--backfill"]);

    expect(countEvents()).toBeGreaterThan(0);
    const db = new Database(DB_PATH, { readonly: true });
    const cursor = db.query("SELECT cursor FROM ingest_cursors WHERE agent = 'claude-code'").get() as
      | { cursor: string }
      | undefined;
    db.close();
    expect(cursor).toBeDefined();
    expect(Number(cursor?.cursor)).toBeGreaterThan(0);
  });

  test("without --backfill, init does not touch the event store", () => {
    writeFixtureSession(join(CC_ROOT, "-fake-project", "session-1.jsonl"));

    run(["--agents", "claude-code", "--no-hooks"]);

    // openDb() is never called by init's config-merge path when --backfill is absent.
    expect(existsSync(DB_PATH)).toBe(false);
  });
});
