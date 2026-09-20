import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport } from "../src/commands/doctor.ts";
import { insertSession, openDb, upsertCursor } from "../src/store/db.ts";

const DB_PATH = "/tmp/total-recall-test-doctor.sqlite";
const FIXTURE_ROOT = "/tmp/total-recall-test-doctor-fixtures";
const CLAUDE_DIR = join(FIXTURE_ROOT, "claude-projects");
const CODEX_DIR = join(FIXTURE_ROOT, "codex-sessions");
const OPENCODE_DB = join(FIXTURE_ROOT, "opencode.db");

let db: Database;

function resetFixtureDirs(): void {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(join(CLAUDE_DIR, "proj-a"), { recursive: true });
  mkdirSync(CODEX_DIR, { recursive: true });
}

beforeEach(() => {
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  db = openDb(DB_PATH);
  resetFixtureDirs();
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("doctor: row counts", () => {
  test("reports events/observations/sessions counts from the db", () => {
    insertSession(db, {
      agent: "claude-code",
      project: "p",
      cwd: null,
      gitBranch: null,
      startedAt: null,
      endedAt: null,
      sourcePath: "/fake/s.jsonl",
    });
    const report = buildReport(db, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, opencodeDbPath: OPENCODE_DB });
    expect(report.counts).toEqual({ events: 0, observations: 0, sessions: 1 });
  });
});

describe("doctor: stalled detection", () => {
  test("flags an adapter with data but no ingest cursor as stalled", () => {
    writeFileSync(join(CLAUDE_DIR, "proj-a", "session-1.jsonl"), "{}\n");
    const report = buildReport(db, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, opencodeDbPath: OPENCODE_DB });
    const claude = report.adapters.find((a) => a.agent === "claude-code")!;
    expect(claude.itemCount).toBe(1);
    expect(claude.lastIngestAt).toBeNull();
    expect(claude.stalled).toBe(true);
    expect(report.stalled).toBe(true);
    expect(report.stalledAgents).toContain("claude-code");
  });

  test("does not flag an adapter with no source files even without a cursor", () => {
    const report = buildReport(db, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, opencodeDbPath: OPENCODE_DB });
    const codex = report.adapters.find((a) => a.agent === "codex")!;
    expect(codex.itemCount).toBe(0);
    expect(codex.stalled).toBe(false);
  });

  test("does not flag an adapter whose cursor is recent relative to source mtime", () => {
    writeFileSync(join(CLAUDE_DIR, "proj-a", "session-1.jsonl"), "{}\n");
    upsertCursor(db, "claude-code", join(CLAUDE_DIR, "proj-a", "session-1.jsonl"), "100");
    const report = buildReport(db, {
      claudeDir: CLAUDE_DIR,
      codexDir: CODEX_DIR,
      opencodeDbPath: OPENCODE_DB,
      stallThresholdMs: 24 * 60 * 60 * 1000,
    });
    const claude = report.adapters.find((a) => a.agent === "claude-code")!;
    expect(claude.lastIngestAt).not.toBeNull();
    expect(claude.stalled).toBe(false);
  });

  test("flags an adapter whose cursor is far older than the newest source file", () => {
    writeFileSync(join(CLAUDE_DIR, "proj-a", "session-1.jsonl"), "{}\n");
    // upsertCursor always stamps updated_at = Date.now(); simulate a stale cursor directly.
    db.query(
      "INSERT INTO ingest_cursors (agent, source_path, cursor, updated_at) VALUES (?, ?, ?, ?)",
    ).run("claude-code", join(CLAUDE_DIR, "proj-a", "session-1.jsonl"), "0", Date.now() - 48 * 60 * 60 * 1000);
    const report = buildReport(db, {
      claudeDir: CLAUDE_DIR,
      codexDir: CODEX_DIR,
      opencodeDbPath: OPENCODE_DB,
      stallThresholdMs: 60 * 60 * 1000,
    });
    const claude = report.adapters.find((a) => a.agent === "claude-code")!;
    expect(claude.stalled).toBe(true);
  });

  test("reports a missing directory as unreadable without throwing", () => {
    const report = buildReport(db, {
      claudeDir: join(FIXTURE_ROOT, "does-not-exist"),
      codexDir: CODEX_DIR,
      opencodeDbPath: OPENCODE_DB,
    });
    const claude = report.adapters.find((a) => a.agent === "claude-code")!;
    expect(claude.readable).toBe(false);
    expect(claude.stalled).toBe(false);
  });

  test("degrades gracefully when the opencode db does not exist", () => {
    const report = buildReport(db, { claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, opencodeDbPath: OPENCODE_DB });
    const opencode = report.adapters.find((a) => a.agent === "opencode")!;
    expect(opencode.readable).toBe(false);
    expect(opencode.stalled).toBe(false);
  });
});
