import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { openDb } from "../src/store/db.ts";
import { importClaudeMem } from "../src/store/import-claudemem.ts";
import { buildClaudeMemFixture } from "./fixtures.ts";

const DB_PATH = "/tmp/total-recall-test-import.sqlite";
const SRC_PATH = "/tmp/total-recall-test-claudemem-fixture.sqlite";

let db: Database;

beforeEach(() => {
  for (const p of [DB_PATH, SRC_PATH]) if (existsSync(p)) rmSync(p);
  buildClaudeMemFixture(SRC_PATH, 5);
  db = openDb(DB_PATH);
});

afterEach(() => {
  db.close();
  for (const p of [DB_PATH, SRC_PATH]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(p + suffix)) rmSync(p + suffix);
    }
  }
});

describe("importClaudeMem", () => {
  test("imports fixture rows 1:1", () => {
    const result = importClaudeMem(db, SRC_PATH);
    expect(result.imported).toBe(5);
    expect(result.skipped).toBe(0);

    const count = db.query("SELECT COUNT(*) as c FROM observations").get() as { c: number };
    expect(count.c).toBe(5);
  });

  test("dedupes on re-run", () => {
    importClaudeMem(db, SRC_PATH);
    const second = importClaudeMem(db, SRC_PATH);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(5);

    const count = db.query("SELECT COUNT(*) as c FROM observations").get() as { c: number };
    expect(count.c).toBe(5);
  });

  test("never writes to the source DB", () => {
    importClaudeMem(db, SRC_PATH);
    const src = new Database(SRC_PATH, { readonly: true });
    const count = src.query("SELECT COUNT(*) as c FROM observations").get() as { c: number };
    expect(count.c).toBe(5);
    src.close();
  });
});
