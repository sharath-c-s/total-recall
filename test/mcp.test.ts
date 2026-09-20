import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { contentHash, insertEvent, insertObservation, insertSession, openDb } from "../src/store/db.ts";
import { createRecallMcpServer, getTool, searchTool, timelineTool } from "../src/mcp/server.ts";
import {
  claudeConfigPath,
  claudeSettingsPath,
  codexConfigPath,
  detectAgents,
  mergeClaudeMcpConfig,
  mergeClaudeSessionStartHook,
  mergeCodexMcpConfig,
  mergeOpencodeMcpConfig,
  opencodeConfigPath,
  run as runInit,
} from "../src/commands/init.ts";

const DB_PATH = "/tmp/total-recall-test-mcp.sqlite";
const FIXTURE_DIR = "/tmp/total-recall-test-mcp-fixtures";

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
    endedAt: null,
    sourcePath: "/fake/mcp-session-1.jsonl",
  });
  insertEvent(db, {
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
    contentHash: contentHash("assistant", "fixed the bigquery column position mismatch"),
  });
  insertEvent(db, {
    sessionId,
    agent: "claude-code",
    project: "total-recall",
    ts: 1_700_000_200,
    role: "user",
    tool: null,
    text: "what is the bigquery fix",
    toolInput: null,
    toolOutput: null,
    toolOutputBytes: null,
    contentHash: contentHash("user", "what is the bigquery fix"),
  });
  insertObservation(db, {
    memorySessionId: "sess-1",
    project: "total-recall",
    text: "observation about bigquery column fix",
    type: "insight",
    title: "BigQuery fix",
    subtitle: null,
    facts: null,
    narrative: "Narrative about the bigquery column position fix",
    concepts: null,
    filesRead: null,
    filesModified: null,
    promptNumber: null,
    discoveryTokens: null,
    createdAt: new Date(2024, 0, 1).toISOString(),
    createdAtEpoch: 1_700_000_050,
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

  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true });
});

describe("mcp tool handlers", () => {
  test("search returns ranked hits spanning events and observations", () => {
    const hits = searchTool(db, { query: "bigquery" });
    const sources = new Set(hits.map((h) => h.source));
    expect(sources.has("events")).toBe(true);
    expect(sources.has("observations")).toBe(true);
    expect(hits[0].snippet.toLowerCase()).toContain("bigquery");
  });

  test("search respects filters", () => {
    const hits = searchTool(db, { query: "bigquery", type: "user" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      if (h.source === "events") expect(h.title).toBe("user");
    }
  });

  test("timeline returns events and observations, most recent first", () => {
    const entries = timelineTool(db, {});
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].ts ?? 0).toBeGreaterThanOrEqual(entries[i].ts ?? 0);
    }
    expect(entries.some((e) => e.source === "events")).toBe(true);
    expect(entries.some((e) => e.source === "observations")).toBe(true);
  });

  test("timeline scoped to a session_id only returns that session's events", () => {
    const entries = timelineTool(db, { sessionId: 1 });
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(e.source).toBe("events");
      expect(e.sessionId).toBe(1);
    }
  });

  test("get fetches the full row by id and table", () => {
    const [hit] = searchTool(db, { query: "bigquery", type: "user" });
    const row = getTool(db, { id: hit.id, table: "events" });
    expect(row).not.toBeNull();
    expect((row as Record<string, unknown>).text).toBe("what is the bigquery fix");
  });

  test("get returns null for a missing id", () => {
    expect(getTool(db, { id: 999_999, table: "events" })).toBeNull();
  });

  test("MCP round-trip over an in-memory transport: tools/list and a real search call", async () => {
    const server = createRecallMcpServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["get", "search", "timeline"]);

      const result = await client.callTool({ name: "search", arguments: { query: "bigquery" } });
      const structured = (result as { structuredContent?: { hits: Array<{ source: string }> } }).structuredContent;
      expect(structured?.hits.length ?? 0).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("init config merge", () => {
  test("Claude Code: adds mcpServers.total-recall, preserves existing entries, backs up, idempotent", () => {
    const path = join(FIXTURE_DIR, "claude.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "other-cmd", args: [] } }, unrelated: true }, null, 2));

    const first = mergeClaudeMcpConfig(path);
    expect(first.changed).toBe(true);

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.mcpServers.other).toEqual({ command: "other-cmd", args: [] });
    expect(after.mcpServers["total-recall"]).toEqual({ command: "recall", args: ["mcp"] });
    expect(after.unrelated).toBe(true);
    expect(existsSync(`${path}.total-recall.bak`)).toBe(true);
    const backedUp = JSON.parse(readFileSync(`${path}.total-recall.bak`, "utf8"));
    expect(backedUp.mcpServers["total-recall"]).toBeUndefined();

    const second = mergeClaudeMcpConfig(path);
    expect(second.changed).toBe(false);
    const afterSecond = JSON.parse(readFileSync(path, "utf8"));
    expect(afterSecond).toEqual(after);
  });

  test("Claude Code: creates config when none exists", () => {
    const path = join(FIXTURE_DIR, "claude-missing.json");
    const result = mergeClaudeMcpConfig(path);
    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcpServers["total-recall"]).toEqual({ command: "recall", args: ["mcp"] });
  });

  test("Claude Code: SessionStart hook is appended without disturbing other hooks, and is idempotent", () => {
    const path = join(FIXTURE_DIR, "settings.json");
    writeFileSync(
      path,
      JSON.stringify(
        { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } },
        null,
        2,
      ),
    );
    const scriptPath = "/fake/hooks/sessionstart-ingest.sh";

    const first = mergeClaudeSessionStartHook(path, scriptPath);
    expect(first.changed).toBe(true);

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }]);
    expect(after.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: scriptPath }] }]);
    expect(existsSync(`${path}.total-recall.bak`)).toBe(true);

    const second = mergeClaudeSessionStartHook(path, scriptPath);
    expect(second.changed).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(after);
  });

  test("Codex: appends [mcp_servers.total-recall] as text, preserves existing TOML, idempotent", () => {
    const path = join(FIXTURE_DIR, "config.toml");
    const original = '[mcp_servers.other]\ncommand = "other-cmd"\nargs = []\n';
    writeFileSync(path, original);

    const first = mergeCodexMcpConfig(path);
    expect(first.changed).toBe(true);
    const afterFirst = readFileSync(path, "utf8");
    expect(afterFirst).toContain(original.trim());
    expect(afterFirst).toContain("[mcp_servers.total-recall]");
    expect(afterFirst).toContain('command = "recall"');
    expect(existsSync(`${path}.total-recall.bak`)).toBe(true);
    expect(readFileSync(`${path}.total-recall.bak`, "utf8")).toBe(original);

    const second = mergeCodexMcpConfig(path);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });

  test("opencode: adds mcp.total-recall, preserves existing servers, idempotent", () => {
    const path = join(FIXTURE_DIR, "opencode.jsonc");
    writeFileSync(path, JSON.stringify({ mcp: { other: { type: "remote", url: "https://example.com" } } }, null, 2));

    const first = mergeOpencodeMcpConfig(path);
    expect(first.changed).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.mcp.other).toEqual({ type: "remote", url: "https://example.com" });
    expect(after.mcp["total-recall"]).toEqual({ type: "local", command: ["recall", "mcp"], enabled: true });

    const second = mergeOpencodeMcpConfig(path);
    expect(second.changed).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(after);
  });

  test("detectAgents reflects presence of each agent's home directory", () => {
    const detected = detectAgents();
    expect(typeof detected["claude-code"]).toBe("boolean");
    expect(typeof detected.codex).toBe("boolean");
    expect(typeof detected.opencode).toBe("boolean");
  });

  test("run(): --agents overrides detection and writes only the requested fixtures, --no-hooks skips the hook file", () => {
    const claudePath = join(FIXTURE_DIR, "run-claude.json");
    const codexPath = join(FIXTURE_DIR, "run-codex.toml");
    const opencodePath = join(FIXTURE_DIR, "run-opencode.jsonc");
    const settingsPath = join(FIXTURE_DIR, "run-settings.json");

    const env = {
      TOTAL_RECALL_CLAUDE_CONFIG: claudePath,
      TOTAL_RECALL_CODEX_CONFIG: codexPath,
      TOTAL_RECALL_OPENCODE_CONFIG: opencodePath,
      TOTAL_RECALL_CLAUDE_SETTINGS: settingsPath,
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      runInit(["--agents", "claude-code,codex", "--no-hooks"]);
      expect(existsSync(claudePath)).toBe(true);
      expect(existsSync(codexPath)).toBe(true);
      expect(existsSync(opencodePath)).toBe(false);
      expect(existsSync(settingsPath)).toBe(false);

      // idempotent re-run with the same fixtures
      runInit(["--agents", "claude-code,codex", "--no-hooks"]);
      const claudeAfter = JSON.parse(readFileSync(claudePath, "utf8"));
      expect(claudeAfter.mcpServers["total-recall"]).toEqual({ command: "recall", args: ["mcp"] });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
