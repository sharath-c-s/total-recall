import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { contentHash, insertEvent, insertSession, openDb } from "../src/store/db.ts";
import { enrich, type EnrichOptions } from "../src/commands/enrich.ts";
import type { Enrichment } from "../src/jev.ts";

const DB_PATH = "/tmp/total-recall-test-enrich.sqlite";

let db: Database;

const BASE_OPTS: EnrichOptions = { since: null, agent: null, limit: 200, concurrency: 4, dryRun: false };

/** No network, no SDK: a deterministic fake standing in for jev's classification. */
function fakeEnrich(text: string): Promise<Enrichment> {
  return Promise.resolve({
    type: text.includes("bug") ? "bugfix" : "discovery",
    importance: text.includes("bug") ? 4 : 1,
    confidence: 0.9,
  });
}

function seedEvent(text: string, ts: number): void {
  const sessionId = insertSession(db, {
    agent: "claude-code",
    project: "p",
    cwd: null,
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    sourcePath: `/fake/enrich-${ts}.jsonl`,
  });
  insertEvent(db, {
    sessionId,
    agent: "claude-code",
    project: "p",
    ts,
    role: "assistant",
    tool: null,
    text,
    toolInput: null,
    toolOutput: null,
    toolOutputBytes: null,
    contentHash: contentHash("assistant", text, String(ts)),
  });
}

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

describe("recall enrich", () => {
  test("populates jev columns for un-enriched events via injected fake", async () => {
    seedEvent("fixed a nasty bug in the parser", 1);
    seedEvent("just poking around the codebase", 2);

    const summary = await enrich(db, BASE_OPTS, { enrich: fakeEnrich });

    expect(summary.enriched).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.skipped).toBe(0);

    const rows = db
      .query("SELECT text, jev_type as jevType, jev_importance as jevImportance FROM events ORDER BY ts")
      .all() as Array<{ text: string; jevType: string; jevImportance: number }>;
    expect(rows[0].jevType).toBe("bugfix");
    expect(rows[0].jevImportance).toBe(4);
    expect(rows[1].jevType).toBe("discovery");
    expect(rows[1].jevImportance).toBe(1);
  });

  test("is resumable: a second run enriches 0 new rows", async () => {
    seedEvent("fixed a nasty bug in the parser", 1);

    const first = await enrich(db, BASE_OPTS, { enrich: fakeEnrich });
    expect(first.enriched).toBe(1);

    const second = await enrich(db, BASE_OPTS, { enrich: fakeEnrich });
    expect(second.enriched).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.errors).toBe(0);
  });

  test("--dry-run classifies but writes nothing", async () => {
    seedEvent("fixed a nasty bug in the parser", 1);

    const summary = await enrich(db, { ...BASE_OPTS, dryRun: true }, { enrich: fakeEnrich });
    expect(summary.enriched).toBe(1);

    const row = db.query("SELECT jev_type as jevType FROM events LIMIT 1").get() as { jevType: string | null };
    expect(row.jevType).toBeNull();
  });

  test("per-event errors are logged and skipped, not fatal to the batch", async () => {
    seedEvent("fixed a nasty bug in the parser", 1);
    seedEvent("discovered a new integration point", 2);

    let calls = 0;
    const summary = await enrich(db, BASE_OPTS, {
      enrich: (text) => {
        calls++;
        if (text.includes("bug")) return Promise.reject(new Error("boom"));
        return fakeEnrich(text);
      },
    });

    expect(calls).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.enriched).toBe(1);
  });
});
