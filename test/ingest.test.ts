import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/commands/ingest.ts";

const CC_ROOT = "/tmp/total-recall-test-ingest-cc-projects";
const DB_PATH = "/tmp/total-recall-test-ingest.sqlite";

function rmrf(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function writeSession(file: string, opts: { bigOutput?: boolean } = {}): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const bigContent = opts.bigOutput ? "A".repeat(5000) + "MIDDLE-MARKER" + "B".repeat(5000) : "small output";
  const lines = [
    { type: "user", message: { role: "user", content: "a fixture prompt" }, uuid: "u1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/fake/project", sessionId: "s1", gitBranch: "main" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "a fixture reply" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] },
      uuid: "a1",
      timestamp: "2024-01-01T00:00:01.000Z",
      cwd: "/fake/project",
      sessionId: "s1",
      gitBranch: "main",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: bigContent }] },
      uuid: "u2",
      timestamp: "2024-01-01T00:00:02.000Z",
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
  for (const suffix of ["", "-wal", "-shm"]) rmrf(DB_PATH + suffix);
  process.env.CLAUDE_CODE_PROJECTS_DIR = CC_ROOT;
  process.env.CODEX_SESSIONS_DIR = "/tmp/total-recall-test-ingest-codex-empty";
  process.env.OPENCODE_DB_PATH = "/tmp/total-recall-test-ingest-opencode-missing.db";
  process.env.TOTAL_RECALL_DB = DB_PATH;
});

afterEach(() => {
  rmrf(CC_ROOT);
  for (const suffix of ["", "-wal", "-shm"]) rmrf(DB_PATH + suffix);
  delete process.env.CLAUDE_CODE_PROJECTS_DIR;
  delete process.env.CODEX_SESSIONS_DIR;
  delete process.env.OPENCODE_DB_PATH;
  delete process.env.TOTAL_RECALL_DB;
});

describe("recall ingest", () => {
  test("--backfill inserts events, capping the large tool_output and recording its true byte size", () => {
    const file = join(CC_ROOT, "-fake-project", "session-1.jsonl");
    writeSession(file, { bigOutput: true });

    run(["--agent", "claude-code", "--backfill"]);
    expect(countEvents()).toBe(4);

    const db = new Database(DB_PATH, { readonly: true });
    const row = db
      .query("SELECT tool_output, tool_output_bytes FROM events WHERE tool_output IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { tool_output: string; tool_output_bytes: number };
    db.close();
    const bigContentBytes = Buffer.byteLength("A".repeat(5000) + "MIDDLE-MARKER" + "B".repeat(5000), "utf8");
    expect(row.tool_output_bytes).toBe(bigContentBytes);
    expect(row.tool_output.length).toBeLessThan(bigContentBytes);
    expect(row.tool_output).not.toContain("MIDDLE-MARKER");
    expect(row.tool_output).toContain("elided");
  });

  test("re-running with the stored cursor adds zero new events (resume, no duplicates)", () => {
    const file = join(CC_ROOT, "-fake-project", "session-1.jsonl");
    writeSession(file);

    run(["--agent", "claude-code", "--backfill"]);
    const firstCount = countEvents();
    expect(firstCount).toBeGreaterThan(0);

    run(["--agent", "claude-code"]);
    expect(countEvents()).toBe(firstCount);
  });

  test("with no cursor and no flags, ingest establishes a baseline cursor but inserts nothing", () => {
    const file = join(CC_ROOT, "-fake-project", "session-1.jsonl");
    writeSession(file);

    run(["--agent", "claude-code"]);
    expect(countEvents()).toBe(0);

    const db = new Database(DB_PATH, { readonly: true });
    const cursor = db.query("SELECT cursor FROM ingest_cursors WHERE agent = 'claude-code'").get() as { cursor: string } | undefined;
    db.close();
    expect(cursor).toBeDefined();
    expect(Number(cursor?.cursor)).toBeGreaterThan(0);
  });

  test("--since only keeps events at or after the threshold", () => {
    const file = join(CC_ROOT, "-fake-project", "session-1.jsonl");
    writeSession(file);

    // All fixture events are from 2024-01-01; a --since far in the future keeps none.
    run(["--agent", "claude-code", "--since", "2099-01-01T00:00:00.000Z"]);
    expect(countEvents()).toBe(0);
  });

  test("opencode: parts sharing an identical time_created split across two ingest runs are neither lost nor duplicated (MAJOR regression)", () => {
    const ocDbPath = "/tmp/total-recall-test-ingest-opencode.db";
    for (const suffix of ["", "-wal", "-shm"]) rmrf(ocDbPath + suffix);
    process.env.OPENCODE_DB_PATH = ocDbPath;

    const src = new Database(ocDbPath, { create: true });
    src.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    src.query("INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)").run("ses1", "/fake/oc-project", 5000);
    src.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "m1", "ses1", 5000, 5000, JSON.stringify({ role: "user" }),
    );
    src.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "p1", "m1", "ses1", 5000, 5000, JSON.stringify({ type: "text", text: "first prompt at t=5000" }),
    );
    src.close();

    run(["--agent", "opencode", "--backfill"]);
    expect(countEvents()).toBe(1);

    // A second part lands with the exact same time_created as the first (coarse ms clock).
    const src2 = new Database(ocDbPath);
    src2.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "p2", "m1", "ses1", 5000, 5000, JSON.stringify({ type: "text", text: "second prompt also at t=5000" }),
    );
    src2.close();

    run(["--agent", "opencode"]);
    // Both parts present (none lost); the re-seen boundary row was not re-inserted (none duplicated).
    expect(countEvents()).toBe(2);

    for (const suffix of ["", "-wal", "-shm"]) rmrf(ocDbPath + suffix);
  });

  test("--dry-run never inserts events, sessions, or cursors", () => {
    const file = join(CC_ROOT, "-fake-project", "session-1.jsonl");
    writeSession(file);

    run(["--agent", "claude-code", "--backfill", "--dry-run"]);
    // openDb() itself creates the (empty-schema) file; dry-run must still write no rows to it.
    expect(countEvents()).toBe(0);

    const db = new Database(DB_PATH, { readonly: true });
    const sessions = db.query("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
    const cursors = db.query("SELECT COUNT(*) as c FROM ingest_cursors").get() as { c: number };
    db.close();
    expect(sessions.c).toBe(0);
    expect(cursors.c).toBe(0);
  });
});
