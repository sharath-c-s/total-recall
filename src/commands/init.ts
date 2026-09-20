import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { run as ingestRun } from "./ingest.ts";

const RECALL_COMMAND = "recall";
const RECALL_MCP_ARGS = ["mcp"];

export interface MergeResult {
  changed: boolean;
  /** Human-readable reason, printed either as "added ..." or "skipped, ...". */
  reason: string;
}

/** Copies `path` to `<path>.total-recall.bak` once, before its first edit. No-op if the file doesn't exist yet or a backup already exists. */
function backup(path: string): void {
  const bak = `${path}.total-recall.bak`;
  if (existsSync(path) && !existsSync(bak)) {
    copyFileSync(path, bak);
  }
}

function writeJson(path: string, root: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude.json, top-level `mcpServers` map (the same shape
// `claude mcp add --scope user` writes). Global, so one recall install covers
// every project.
// ---------------------------------------------------------------------------

export function claudeConfigPath(): string {
  return process.env.TOTAL_RECALL_CLAUDE_CONFIG ?? join(homedir(), ".claude.json");
}

export function mergeClaudeMcpConfig(path: string): MergeResult {
  const root: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const mcpServers = (root.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (mcpServers["total-recall"]) {
    return { changed: false, reason: "mcpServers.total-recall already present" };
  }
  backup(path);
  mcpServers["total-recall"] = { command: RECALL_COMMAND, args: RECALL_MCP_ARGS };
  root.mcpServers = mcpServers;
  writeJson(path, root);
  return { changed: true, reason: "added mcpServers.total-recall" };
}

// ---------------------------------------------------------------------------
// Claude Code SessionStart hook: ~/.claude/settings.json, `hooks.SessionStart`
// array of matchers. Appended as a new matcher entry so existing hooks are
// never touched.
// ---------------------------------------------------------------------------

export function claudeSettingsPath(): string {
  return process.env.TOTAL_RECALL_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

/** Absolute path to the installed hook script, resolved from this file's location in the repo. */
export function sessionStartHookScriptPath(): string {
  return join(import.meta.dir, "..", "..", "hooks", "sessionstart-ingest.sh");
}

export function mergeClaudeSessionStartHook(settingsPath: string, scriptPath: string): MergeResult {
  const root: Record<string, unknown> = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const hooks = (root.hooks as Record<string, unknown> | undefined) ?? {};
  const sessionStart = (hooks.SessionStart as Array<{ hooks?: Array<{ type?: string; command?: string }> }> | undefined) ?? [];
  const alreadyPresent = sessionStart.some((matcher) => matcher.hooks?.some((h) => h.command === scriptPath));
  if (alreadyPresent) {
    return { changed: false, reason: "SessionStart hook already present" };
  }
  backup(settingsPath);
  sessionStart.push({ hooks: [{ type: "command", command: scriptPath }] });
  hooks.SessionStart = sessionStart;
  root.hooks = hooks;
  writeJson(settingsPath, root);
  return { changed: true, reason: "added SessionStart hook" };
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml, `[mcp_servers.total-recall]` table. Edited as
// text (append-only) rather than parse+reserialize, so existing comments and
// formatting in the user's TOML survive untouched.
// ---------------------------------------------------------------------------

export function codexConfigPath(): string {
  return process.env.TOTAL_RECALL_CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");
}

export function mergeCodexMcpConfig(path: string): MergeResult {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/\[mcp_servers\.total-recall\]/.test(text)) {
    return { changed: false, reason: "[mcp_servers.total-recall] already present" };
  }
  backup(path);
  const block = `[mcp_servers.total-recall]\ncommand = "${RECALL_COMMAND}"\nargs = ${JSON.stringify(RECALL_MCP_ARGS)}\n`;
  const separator = text.length > 0 ? (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") : "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}${separator}${block}`);
  return { changed: true, reason: "appended [mcp_servers.total-recall]" };
}

// ---------------------------------------------------------------------------
// opencode: ~/.config/opencode/opencode.jsonc, `mcp` map. `type: "local"` with
// a `command` array is opencode's documented shape for a stdio server.
// Comments are stripped for parsing only; if the file already has no
// total-recall entry, the file is rewritten as plain JSON (a valid JSONC
// subset), so pre-existing comments are not preserved across that one edit.
// ---------------------------------------------------------------------------

export function opencodeConfigPath(): string {
  return process.env.TOTAL_RECALL_OPENCODE_CONFIG ?? join(homedir(), ".config", "opencode", "opencode.jsonc");
}

function stripJsonComments(text: string): string {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(/(^|[^:"])\/\/.*$/gm, "$1");
}

export function mergeOpencodeMcpConfig(path: string): MergeResult {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    root = raw.trim() ? JSON.parse(stripJsonComments(raw)) : {};
  }
  const mcp = (root.mcp as Record<string, unknown> | undefined) ?? {};
  if (mcp["total-recall"]) {
    return { changed: false, reason: "mcp.total-recall already present" };
  }
  backup(path);
  mcp["total-recall"] = { type: "local", command: [RECALL_COMMAND, ...RECALL_MCP_ARGS], enabled: true };
  root.mcp = mcp;
  writeJson(path, root);
  return { changed: true, reason: "added mcp.total-recall" };
}

// ---------------------------------------------------------------------------
// Agent detection and the `recall init` command.
// ---------------------------------------------------------------------------

export interface DetectedAgents {
  "claude-code": boolean;
  codex: boolean;
  opencode: boolean;
}

/** Detects installed agents by the presence of their well-known home directories. */
export function detectAgents(): DetectedAgents {
  return {
    "claude-code": existsSync(join(homedir(), ".claude")),
    codex: existsSync(join(homedir(), ".codex")),
    opencode: existsSync(join(homedir(), ".local", "share", "opencode")),
  };
}

function describe(label: string, path: string, result: MergeResult): string {
  return result.changed ? `${label}: ${result.reason} (${path})` : `${label}: skipped, ${result.reason} (${path})`;
}

function parseAgentsFlag(args: string[]): (keyof DetectedAgents)[] | null {
  const idx = args.indexOf("--agents");
  if (idx === -1) return null;
  const value = args[idx + 1] ?? "";
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as (keyof DetectedAgents)[];
}

/** `recall init [--agents claude-code,codex,opencode] [--backfill] [--no-hooks]` */
export function run(args: string[]): void {
  const agentsOverride = parseAgentsFlag(args);
  const noHooks = args.includes("--no-hooks");
  const backfill = args.includes("--backfill");

  const detected = detectAgents();
  const wants = (agent: keyof DetectedAgents): boolean => (agentsOverride ? agentsOverride.includes(agent) : detected[agent]);

  const lines: string[] = [];

  if (wants("claude-code")) {
    lines.push(describe("Claude Code MCP", claudeConfigPath(), mergeClaudeMcpConfig(claudeConfigPath())));
    if (noHooks) {
      lines.push("Claude Code SessionStart hook: skipped (--no-hooks)");
    } else {
      const settingsPath = claudeSettingsPath();
      const scriptPath = sessionStartHookScriptPath();
      lines.push(describe("Claude Code SessionStart hook", settingsPath, mergeClaudeSessionStartHook(settingsPath, scriptPath)));
    }
  } else {
    lines.push("Claude Code: not detected (~/.claude not found), skipped");
  }

  if (wants("codex")) {
    lines.push(describe("Codex MCP", codexConfigPath(), mergeCodexMcpConfig(codexConfigPath())));
  } else {
    lines.push("Codex: not detected (~/.codex not found), skipped");
  }

  if (wants("opencode")) {
    lines.push(describe("opencode MCP", opencodeConfigPath(), mergeOpencodeMcpConfig(opencodeConfigPath())));
  } else {
    lines.push("opencode: not detected (~/.local/share/opencode not found), skipped");
  }

  console.log(lines.join("\n"));

  if (backfill) {
    console.log("--backfill: running `recall ingest --backfill` to seed cursors from the beginning of every discoverable session...");
    ingestRun(["--backfill"]);
  }
}
