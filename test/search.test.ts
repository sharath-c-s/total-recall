import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { contentHash, insertEvent, insertSession, openDb, search } from "../src/store/db.ts";
import { importClaudeMem } from "../src/store/import-claudemem.ts";
import { buildClaudeMemFixture } from "./fixtures.ts";

const DB_PATH = "/tmp/total-recall-test-search.sqlite";
const SRC_PATH = "/tmp/total-recall-test-search-fixture.sqlite";

let db: Database;

beforeEach(() => {
  for (const p of [DB_PATH, SRC_PATH]) if (existsSync(p)) rmSync(p);
  buildClaudeMemFixture(SRC_PATH, 2);
  db = openDb(DB_PATH);
  importClaudeMem(db, SRC_PATH);

  const sessionId = insertSession(db, {
    agent: "codex",
    project: "other-project",
    cwd: null,
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    sourcePath: "/fake/search-session.jsonl",
  });
  insertEvent(db, {
    sessionId,
    agent: "codex",
    project: "other-project",
    ts: 1_800_000_000,
    role: "tool",
    tool: "bash",
    text: null,
    toolInput: "SELECT * FROM bigquery_table",
    toolOutput: null,
    toolOutputBytes: null,
    contentHash: contentHash("tool", "SELECT * FROM bigquery_table"),
  });
});

afterEach(() => {
  db.close();
  for (const p of [DB_PATH, SRC_PATH]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(p + suffix)) rmSync(p + suffix);
    }
  }
});

describe("search filters", () => {
  test("unfiltered query spans both events and observations", () => {
    const hits = search(db, "bigquery");
    const sources = new Set(hits.map((h) => h.source));
    expect(sources.has("events")).toBe(true);
    expect(sources.has("observations")).toBe(true);
  });

  test("agent filter restricts to observations imported with that agent_type", () => {
    const hits = search(db, "bigquery", { agent: "claude-code" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.agent).toBe("claude-code");
    }
  });

  test("project filter restricts results", () => {
    const hits = search(db, "bigquery", { project: "other-project" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.project).toBe("other-project");
    }
  });

  test("type filter on events matches role", () => {
    const hits = search(db, "bigquery", { type: "tool" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      if (h.source === "events") expect(h.title).toBe("tool");
    }
  });

  test("limit caps result count", () => {
    const hits = search(db, "bigquery", { limit: 1 });
    expect(hits.length).toBe(1);
  });
});

describe("search: kind + minImportance filters (events only, populated by `recall enrich`)", () => {
  test("kind and minImportance restrict to jev-enriched events", () => {
    const sessionId = insertSession(db, {
      agent: "claude-code",
      project: "proj-enrich",
      cwd: null,
      gitBranch: null,
      startedAt: null,
      endedAt: null,
      sourcePath: "/fake/enrich-session.jsonl",
    });

    const bug = insertEvent(db, {
      sessionId,
      agent: "claude-code",
      project: "proj-enrich",
      ts: 10,
      role: "assistant",
      tool: null,
      text: "widget rocket zephyr bugfix",
      toolInput: null,
      toolOutput: null,
      toolOutputBytes: null,
      contentHash: contentHash("assistant", "widget rocket zephyr bugfix"),
    });
    db.query("UPDATE events SET jev_type = ?, jev_importance = ?, jev_confidence = ? WHERE id = ?").run(
      "bugfix",
      5,
      0.9,
      bug.id,
    );

    const discovery = insertEvent(db, {
      sessionId,
      agent: "claude-code",
      project: "proj-enrich",
      ts: 20,
      role: "assistant",
      tool: null,
      text: "widget rocket zephyr discovery",
      toolInput: null,
      toolOutput: null,
      toolOutputBytes: null,
      contentHash: contentHash("assistant", "widget rocket zephyr discovery"),
    });
    db.query("UPDATE events SET jev_type = ?, jev_importance = ?, jev_confidence = ? WHERE id = ?").run(
      "discovery",
      1,
      0.9,
      discovery.id,
    );

    const kindHits = search(db, "widget rocket zephyr", { kind: "bugfix" });
    expect(kindHits.length).toBe(1);
    expect(kindHits[0].type).toBe("bugfix");
    expect(kindHits[0].importance).toBe(5);

    const importanceHits = search(db, "widget rocket zephyr", { minImportance: 3 });
    expect(importanceHits.length).toBe(1);
    expect(importanceHits[0].type).toBe("bugfix");

    const both = search(db, "widget rocket zephyr", { kind: "discovery", minImportance: 3 });
    expect(both.length).toBe(0);
  });
});

describe("search: special FTS5 characters do not crash (BLOCKER regression)", () => {
  test("a colon in the query is treated as a literal token", () => {
    expect(() => search(db, "foo: bar")).not.toThrow();
    expect(search(db, "foo: bar")).toEqual(expect.any(Array));
  });

  test("a leading hyphen (FTS5 NOT-prefix syntax) is treated as a literal token", () => {
    expect(() => search(db, "-flag")).not.toThrow();
  });

  test("an unterminated quote does not throw a syntax error", () => {
    expect(() => search(db, '"unterminated')).not.toThrow();
  });

  test("bare boolean keywords (AND/OR/NOT/NEAR) are treated as literal terms, not FTS5 operators", () => {
    expect(() => search(db, "a AND b")).not.toThrow();
    // "AND" is now a literal required token, so a query with no such literal text returns cleanly, not a crash.
    expect(search(db, "a AND b")).toEqual([]);
  });
});
