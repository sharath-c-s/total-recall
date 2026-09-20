import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { claudeCodeAdapter, defaultClaudeCodeRoot } from "../src/adapters/claude-code.ts";
import { codexAdapter, defaultCodexRoot } from "../src/adapters/codex.ts";
import { opencodeAdapter, defaultOpencodeDbPath } from "../src/adapters/opencode.ts";
import { tailJsonl, walkFiles } from "../src/adapters/base.ts";
import { capToolOutput, normalizeEvent } from "../src/normalize.ts";

const CC_ROOT = "/tmp/total-recall-test-cc-projects";
const CODEX_ROOT = "/tmp/total-recall-test-codex-sessions";
const OC_DB = "/tmp/total-recall-test-opencode.db";
const SCRATCH_DB = "/tmp/total-recall-test-adapters-scratch.sqlite";

function rmrf(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

let db: Database;

beforeEach(() => {
  rmrf(CC_ROOT);
  rmrf(CODEX_ROOT);
  rmrf(OC_DB);
  rmrf(SCRATCH_DB);
  process.env.CLAUDE_CODE_PROJECTS_DIR = CC_ROOT;
  process.env.CODEX_SESSIONS_DIR = CODEX_ROOT;
  process.env.OPENCODE_DB_PATH = OC_DB;
  db = openDb(SCRATCH_DB); // scratch DB the adapters can use as their cursor store (unused by discoverSessions here)
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmrf(SCRATCH_DB + suffix);
  rmrf(CC_ROOT);
  rmrf(CODEX_ROOT);
  rmrf(OC_DB);
  delete process.env.CLAUDE_CODE_PROJECTS_DIR;
  delete process.env.CODEX_SESSIONS_DIR;
  delete process.env.OPENCODE_DB_PATH;
});

describe("base helpers", () => {
  test("walkFiles returns [] for a missing root instead of throwing", () => {
    expect(walkFiles("/tmp/total-recall-does-not-exist", () => true)).toEqual([]);
  });

  test("tailJsonl never consumes a trailing partial line", () => {
    const path = "/tmp/total-recall-test-tail.jsonl";
    writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":3'); // last line still being written, no trailing '\n' yet
    const first = tailJsonl(path, 0);
    expect(first.records).toEqual([{ a: 1 }, { a: 2 }]);
    expect(first.newOffset).toBeLessThan(Buffer.byteLength('{"a":1}\n{"a":2}\n{"a":3'));

    // Completing the line on a second write and re-tailing from the returned offset picks it up.
    writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":3}\n');
    const second = tailJsonl(path, first.newOffset);
    expect(second.records).toEqual([{ a: 3 }]);
    rmSync(path);
  });

  test("tailJsonl skips malformed lines without crashing", () => {
    const path = "/tmp/total-recall-test-tail-bad.jsonl";
    writeFileSync(path, '{"a":1}\nnot json at all\n{"a":2}\n');
    const { records } = tailJsonl(path, 0);
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
    rmSync(path);
  });

  test("tailJsonl re-reads from 0 when the file has shrunk (rotation/replacement), instead of silently skipping its content (MAJOR regression)", () => {
    const path = "/tmp/total-recall-test-tail-shrink.jsonl";
    writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":3}\n');
    const first = tailJsonl(path, 0);
    expect(first.records).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);

    // File replaced with a new, shorter one (log rotation): the old offset now points past EOF.
    writeFileSync(path, '{"b":1}\n');
    const second = tailJsonl(path, first.newOffset);
    expect(second.records).toEqual([{ b: 1 }]);
    rmSync(path);
  });
});

describe("normalize", () => {
  test("capToolOutput leaves small output untouched", () => {
    const { text, bytes } = capToolOutput("hello world");
    expect(text).toBe("hello world");
    expect(bytes).toBe(11);
  });

  test("capToolOutput caps large output to head+tail and records the true size", () => {
    const big = "A".repeat(5000) + "MIDDLE" + "B".repeat(5000);
    const { text, bytes } = capToolOutput(big);
    expect(bytes).toBe(Buffer.byteLength(big, "utf8"));
    expect(text.length).toBeLessThan(big.length);
    expect(text.startsWith("A".repeat(100))).toBe(true);
    expect(text.endsWith("B".repeat(100))).toBe(true);
    expect(text).not.toContain("MIDDLE");
    expect(text).toContain("elided");
  });

  test("normalizeEvent hashes deterministically for identical input, and differently across source keys", () => {
    const raw = { ts: 1000, role: "assistant" as const, tool: null, text: "same text", toolInput: null, toolOutput: null };
    const a = normalizeEvent(raw, { agent: "claude-code", project: "p", sourceKey: "session-a" });
    const b = normalizeEvent(raw, { agent: "claude-code", project: "p", sourceKey: "session-a" });
    const c = normalizeEvent(raw, { agent: "claude-code", project: "p", sourceKey: "session-b" });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });

  test("normalizeEvent JSON-stringifies object tool_input but leaves a string tool_input as-is", () => {
    const objEvt = normalizeEvent(
      { ts: 1, role: "tool" as const, tool: "Bash", text: null, toolInput: { command: "ls -la" }, toolOutput: null },
      { agent: "claude-code", project: null, sourceKey: "s" },
    );
    expect(objEvt.toolInput).toBe(JSON.stringify({ command: "ls -la" }));

    const strEvt = normalizeEvent(
      { ts: 1, role: "tool" as const, tool: "apply_patch", text: null, toolInput: "*** Begin Patch", toolOutput: null },
      { agent: "codex", project: null, sourceKey: "s" },
    );
    expect(strEvt.toolInput).toBe("*** Begin Patch");
  });
});

describe("claude-code adapter", () => {
  function writeFixture(): string {
    const dir = join(CC_ROOT, "-fake-project");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session-abc.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: "hello world prompt" }, uuid: "u1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/fake/project", sessionId: "session-abc", gitBranch: "main" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello reply" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } }] },
        uuid: "a1",
        timestamp: "2024-01-01T00:00:01.000Z",
        cwd: "/fake/project",
        sessionId: "session-abc",
        gitBranch: "main",
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file1\nfile2" }] },
        uuid: "u2",
        timestamp: "2024-01-01T00:00:02.000Z",
        cwd: "/fake/project",
        sessionId: "session-abc",
        gitBranch: "main",
      },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  test("discoverSessions finds the fixture file with metadata from the first line carrying it", () => {
    expect(defaultClaudeCodeRoot()).toBe(CC_ROOT);
    const file = writeFixture();
    const sessions = claudeCodeAdapter.discoverSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sourcePath).toBe(file);
    expect(sessions[0].cursorPath).toBe(file);
    expect(sessions[0].cwd).toBe("/fake/project");
    expect(sessions[0].project).toBe("project");
    expect(sessions[0].gitBranch).toBe("main");
  });

  test("iterEvents extracts user text, assistant text, and a correlated tool_use/tool_result pair", () => {
    writeFixture();
    const [session] = claudeCodeAdapter.discoverSessions(db);
    const { events, newCursor } = claudeCodeAdapter.iterEvents(session, null);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ role: "user", text: "hello world prompt" });
    expect(events[1]).toMatchObject({ role: "assistant", text: "hello reply" });
    expect(events[2]).toMatchObject({ role: "tool", tool: "Bash", toolInput: { command: "ls -la" } });
    expect(events[3]).toMatchObject({ role: "tool", tool: "Bash", toolOutput: "file1\nfile2" });
    expect(Number(newCursor)).toBeGreaterThan(0);

    // Re-tailing from the returned cursor yields nothing new.
    const again = claudeCodeAdapter.iterEvents(session, newCursor);
    expect(again.events).toHaveLength(0);
  });
});

describe("codex adapter", () => {
  function writeFixture(): string {
    const dir = join(CODEX_ROOT, "2024", "01", "01");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-2024-01-01T00-00-00-test.jsonl");
    const lines = [
      { timestamp: "2024-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "test", cwd: "/fake/codex-project", git: { branch: "feat/x" } } },
      { timestamp: "2024-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "do the thing" } },
      { timestamp: "2024-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"command":"ls"}', call_id: "c1" } },
      { timestamp: "2024-01-01T00:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "file1\nfile2" } },
      { timestamp: "2024-01-01T00:00:04.000Z", type: "event_msg", payload: { type: "agent_message", message: "done" } },
      { timestamp: "2024-01-01T00:00:05.000Z", type: "event_msg", payload: { type: "token_count", info: {} } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  test("discoverSessions reads cwd/branch off the session_meta line", () => {
    expect(defaultCodexRoot()).toBe(CODEX_ROOT);
    const file = writeFixture();
    const sessions = codexAdapter.discoverSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sourcePath).toBe(file);
    expect(sessions[0].cwd).toBe("/fake/codex-project");
    expect(sessions[0].gitBranch).toBe("feat/x");
  });

  test("iterEvents maps event_msg and response_item pairs, skipping token_count", () => {
    writeFixture();
    const [session] = codexAdapter.discoverSessions(db);
    const { events } = codexAdapter.iterEvents(session, null);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ role: "user", text: "do the thing" });
    expect(events[1]).toMatchObject({ role: "tool", tool: "shell", toolInput: { command: "ls" } });
    expect(events[2]).toMatchObject({ role: "tool", tool: "shell", toolOutput: "file1\nfile2" });
    expect(events[3]).toMatchObject({ role: "assistant", text: "done" });
  });
});

describe("opencode adapter", () => {
  function buildFixtureDb(): void {
    const src = new Database(OC_DB, { create: true });
    src.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    src.query("INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)").run("ses1", "/fake/oc-project", 1000);
    src.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "m1", "ses1", 1000, 1000, JSON.stringify({ role: "user" }),
    );
    src.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "p1", "m1", "ses1", 1000, 1000, JSON.stringify({ type: "text", text: "user prompt here" }),
    );
    src.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "m2", "ses1", 1001, 1002, JSON.stringify({ role: "assistant" }),
    );
    src.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "p2", "m2", "ses1", 1001, 1001, JSON.stringify({ type: "text", text: "assistant reply here" }),
    );
    src.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
      "p3", "m2", "ses1", 1002, 1002,
      JSON.stringify({ type: "tool", tool: "glob", state: { status: "completed", input: { pattern: "*.ts" }, output: "a.ts\nb.ts" } }),
    );
    src.close();
  }

  test("discoverSessions returns one SessionRef per opencode session, sharing the DB path as cursorPath", () => {
    expect(defaultOpencodeDbPath()).toBe(OC_DB);
    buildFixtureDb();
    const sessions = opencodeAdapter.discoverSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sourcePath).toBe("opencode:ses1");
    expect(sessions[0].cursorPath).toBe(OC_DB);
    expect(sessions[0].cwd).toBe("/fake/oc-project");
    expect(sessions[0].project).toBe("oc-project");
    expect(sessions[0].startedAt).toBe(1000);
  });

  test("iterEvents maps text and tool parts, and resumes from the returned cursor", () => {
    buildFixtureDb();
    const [session] = opencodeAdapter.discoverSessions(db);
    const first = opencodeAdapter.iterEvents(session, null);
    expect(first.events).toHaveLength(3);
    expect(first.events[0]).toMatchObject({ role: "user", text: "user prompt here" });
    expect(first.events[1]).toMatchObject({ role: "assistant", text: "assistant reply here" });
    expect(first.events[2]).toMatchObject({ role: "tool", tool: "glob", toolOutput: "a.ts\nb.ts" });
    expect(first.newCursor).toBe("1002");

    // The boundary row (pts=1002) is intentionally re-returned on resume: `time_created`
    // is coarse (ms) and other parts can share that exact value, so the adapter uses `>=`
    // and leaves de-duplication to insertEvent()'s content_hash check downstream (see the
    // "opencode ingest" dedup test in ingest.test.ts for the full-pipeline guarantee).
    const second = opencodeAdapter.iterEvents(session, first.newCursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ role: "tool", tool: "glob" });
    expect(second.newCursor).toBe("1002");
  });

  test("discoverSessions returns [] when the DB file does not exist (opencode not installed)", () => {
    rmrf(OC_DB);
    expect(opencodeAdapter.discoverSessions(db)).toEqual([]);
  });
});
