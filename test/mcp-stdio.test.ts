import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, insertEvent, insertSession, contentHash } from "../src/store/db.ts";

// Regression test for the bug where `recall mcp` closed the database immediately
// after `server.connect()` resolved, so every tool call ran against a closed DB
// and silently returned []. This spawns the real stdio server as a subprocess
// (the only way the bug reproduces) and asserts a search returns the seeded row.

const dir = mkdtempSync(join(tmpdir(), "tr-mcp-"));
const dbPath = join(dir, "recall.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed(): void {
  const db = openDb(dbPath);
  const sessionId = insertSession(db, {
    agent: "claude-code",
    project: "proj",
    cwd: null,
    gitBranch: null,
    startedAt: Date.now(),
    endedAt: null,
    sourcePath: "test-source",
  });
  insertEvent(db, {
    sessionId,
    agent: "claude-code",
    project: "proj",
    ts: Date.now(),
    role: "assistant",
    tool: null,
    text: "the zzzuniqueterm marker for the mcp stdio test",
    toolInput: null,
    toolOutput: null,
    toolOutputBytes: 0,
    contentHash: contentHash("zzzuniqueterm-mcp-test"),
  });
  db.close();
}

test("recall mcp serves search over stdio without closing the db", async () => {
  seed();
  const proc = Bun.spawn(["bun", "bin/recall.ts", "mcp"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TOTAL_RECALL_DB: dbPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "zzzuniqueterm" } } });
  await proc.stdin.flush();

  const deadline = Date.now() + 15000;
  let buf = "";
  let hits: unknown[] | null = null;
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  while (Date.now() < deadline && hits === null) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let msg: { id?: number; result?: { structuredContent?: { hits?: unknown[] } } };
      try {
        msg = JSON.parse(s);
      } catch {
        continue;
      }
      if (msg.id === 2 && msg.result?.structuredContent?.hits) {
        hits = msg.result.structuredContent.hits;
        break;
      }
    }
  }

  proc.kill();
  expect(hits).not.toBeNull();
  expect(hits!.length).toBeGreaterThan(0);
});
