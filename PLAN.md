# total-recall — cross-agent work log and memory

Name: `total-recall`. npm package: `total-recall`. CLI command: `recall` (short binary alias, so subcommands read as `recall search`, `recall ingest`, and so on). Repo lives at `~/playground/total-recall`.

## What it is

`total-recall` is a local-first tool that captures everything your coding agents do (Claude Code, Codex, opencode), indexes the full transcript (prompts, assistant output, tool inputs and outputs) for search, and injects relevant past context back into any agent through MCP. It gives you one queryable history of all agent work across every tool, with no cloud dependency, no always-on daemon, and no LLM in the core.

## Why it exists

Existing memory tools (claude-mem and similar) are powerful but heavy and fragile: an always-on LLM "observer" worker that depends on a live provider and quota, a separate vector database, and a supervisor. When the observer's provider runs out of quota, capture stops silently and can rot for a full day before anyone notices. `recall` keeps the useful parts (structured, searchable observations injected back into sessions) and removes the fragile parts (the always-on daemon, the mandatory vector DB, the silent-failure mode).

The design is shaped by three facts confirmed on a real machine:
1. Every agent already writes its full session transcript to disk. Claude Code writes `~/.claude/projects/**/*.jsonl` (3,640 files here), Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (329 files here), opencode writes a relational SQLite database at `~/.local/share/opencode/opencode.db` (session, message, part tables).
2. claude-mem's own store is plain SQLite with an FTS5 full-text index already built (`observations` plus `observations_fts`, kept in sync by triggers). Importing its 31k observations is a straight INSERT, and full-text search needs no new infrastructure.
3. All three agents support MCP, so a single MCP server reaches all of them for retrieval.

## Design principles

1. Local-first. All state lives in one portable SQLite file. No account, no cloud required.
2. Agent-agnostic by reading native session stores, not by depending on each agent's hook system. Hooks and plugins are optional fast-paths, never the foundation.
3. No always-on LLM daemon. Summarize lazily: once per session at end, or on demand. One synchronous call, cost-capped, and it fails loud.
4. Zero-friction migration. Reuse claude-mem's schema so existing observations import as-is.
5. Boring search first. SQLite FTS5 (BM25) by default. Semantic embeddings are an opt-in plugin, off by default, so the base install stays dependency-light.
6. Loud on failure. The single most important lesson from claude-mem: a memory tool that fails silently is worse than no tool, because you trust it. `recall doctor` and a status signal surface a stalled ingest immediately.

## Architecture

Five components, each replaceable.

### 1. Ingest adapters (read-only, per agent)

Each adapter knows how to read one agent's native session store and yield normalized events. Adapters never write to the agent's own files.

- `claude-code`: tail `~/.claude/projects/**/*.jsonl`. Each line is a JSON event (user, assistant, tool_use, tool_result). Resume by byte offset per file.
- `codex`: tail `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Line 1 is `session_meta`; later lines are `event_msg`, `response_item`, `turn_context`, `compacted`. Resume by byte offset per file.
- `opencode`: read `~/.local/share/opencode/opencode.db` read-only. Join `session` (id, project_id, workspace_id, slug), `message` (session_id, time_created, data JSON), and `part` (message_id, session_id). Resume by max `time_updated` or rowid per table.

Adapter interface (conceptual):

```
class Adapter:
    name: str
    def discover_sessions(self, cursor) -> Iterable[SessionRef]: ...
    def iter_events(self, session: SessionRef, from_cursor) -> Iterable[RawEvent]: ...
```

A single file/DB watcher drives the adapters (watchdog on the log directories, plus a polling fallback for the opencode DB). Every adapter persists a resumable cursor in `recall.db`, so a restart, a machine move, or a restore continues exactly where it left off.

### 2. Normalizer

Maps each agent's events into one common `raw_events` schema regardless of source: `(session_id, agent, project, cwd, git_branch, ts, kind, tool, payload_json)`. This is the layer that makes cross-agent search possible: after normalization, a Claude Code tool call and a Codex tool call look the same to everything downstream.

### 3. Capture (mechanical, zero model tokens by default)

The source of every answer is the session transcript, which each agent already writes to disk in full: the user's prompts, the assistant's own text output, and every tool call with its input and result. Capturing that text is what lets recall answer questions like "what was the API to get user tokens" or "what was the fix for the BigQuery column name and position mismatch". Those answers are almost never in metadata. They are stated in the assistant's explanation, or contained in a tool input (the exact command, the exact code edit). Metadata (branch, path, tool name) finds the session; the captured text finds the answer.

What is indexed, all with no LLM:
- User prompts, in full.
- Assistant text output, in full. This is the highest-value field. The name of an API, the reason a change was made, the description of a fix, usually live here. To be explicit: yes, the assistant's output (Claude's, Codex's, opencode's) is logged to SQLite, and it is the most important thing indexed.
- Tool inputs, in full: the exact Bash command, the Edit's before and after, the Write's content, the SQL or query run. These are small and answer-bearing.
- Tool outputs, capped: the first and last N kilobytes of a large result (command output, file reads) with the middle elided, recording the true size. This keeps the answer-bearing head and tail while stopping the gigabyte bloat that raw Codex logs are known for.

All of the above is stored in `events` and mirrored into an FTS5 index, so `recall search "bigquery column position"` returns the exact assistant message and the exact edit that made the fix, and `recall search "user token api"` returns the message or command that names the endpoint. No summary is needed to find either the session or the answer.

How capture runs, with no always-on daemon, no LLM, and no session-end guess:
- `recall ingest` tails each agent's transcript from a stored per-file cursor and appends new rows. It is the one mechanism for all three agents (Claude Code JSONL, Codex JSONL, opencode SQLite), and it reads files only, so it costs no model tokens.
- It is triggered opportunistically by a Claude Code `SessionStart` hook that runs a quick catch-up ingest of whatever finished since last time, which is exactly the moment fresh memory is wanted. An optional periodic timer (launchd/systemd) and a manual `recall ingest` cover everything else.
- A `PostToolUse` hook is available as an optional real-time path, but it is secondary, because it cannot see the assistant's prose between tool calls, which is the most answer-dense content. The transcript tail captures that prose; the hook does not.

Optional summary layer, opt-in: the capture above answers "find the message that holds the answer". If you want a synthesized one-line answer instead of a ranked list of matching messages, `recall ask "..."` retrieves the top matches and passes them to an LLM once, on demand. That is the only place a model is used for recall, it never runs automatically, and search works fully without it. A separate `recall summarize` can still produce claude-mem-shaped observations for a session if you want compact per-session cards, also opt-in.

Why not have Claude write to the database itself: it works, but it spends main-model context tokens on every write and depends on the model choosing to record, so misses are silent and permanent. Tailing the transcript costs no model tokens and never forgets. A Claude-authored "remember this exactly" note stays available as an explicit tool layered on top, not as the foundation.

Idempotency: every captured row carries a `content_hash`, so re-tailing a log or re-running a backfill never creates duplicates.

### 4. Store

One SQLite file, `recall.db`. Schema is a superset of claude-mem's:
- `sessions`: agent, project, cwd, git_branch, started_at, ended_at, source_path.
- `events` plus `events_fts` (FTS5): the primary searchable table. One row per transcript event, with role (user, assistant, tool), timestamp, tool name, the full text (prompt or assistant output), the full tool input, and the capped tool output. This is what answers "what was the API" and "what was the fix", so it is retained, not pruned.
- `observations` plus `observations_fts` (FTS5): identical columns to claude-mem, so the existing 31k rows import unchanged. Populated only by the claude-mem import and by the opt-in `recall summarize`. Both `events_fts` and `observations_fts` are searched together, and results are tagged by which table they came from.
- `ingest_cursors`: per adapter and per source file, the resume position.
- `config`: provider, model, retention policy.

FTS5 is compiled into SQLite (and into `bun:sqlite`), so full-text search is a dependency of zero.

### 5. Retrieval and injection

Retrieval (CLI):
- `recall search "<query>" [--agent] [--project] [--since] [--type]`: FTS5 BM25 over observations, results tagged by source agent.
- `recall timeline --session <id>` and `recall sessions`: browse.
- `recall ask "<question>"`: RAG. Search, then feed top-k observations to an LLM for a synthesized answer (for example, "which branch had the pure-inserts rebase"). Reuses the summarizer's provider.

Injection (context back into agents):
- `recall-mcp`: an MCP server exposing `search`, `timeline`, and `get` tools. This is the universal path and works in Claude Code, Codex, and opencode because all three speak MCP.
- Optional per-agent session-start injection as a fast-path: a Claude Code SessionStart hook, a Codex `hooks.json` entry, an opencode plugin using `session.hook("context")`. These pre-load recent and relevant context without the model having to call a tool. Optional, never required.

## Cross-agent story (the headline feature)

Because every session is normalized into one schema and tagged with its source agent, a single query spans all tools. "What did I do on clear-cover pure inserts" returns hits whether the work happened in Claude Code, Codex, or opencode, in one ranked list. Session references carry the agent, the project, the git branch, and the time, so you can jump back to the exact session in the right tool.

## Install, backup, continuation

Install:
- `recall init` detects installed agents, writes the MCP server into each agent's config (`.mcp.json` for Claude Code, `config.toml` for Codex, `opencode.jsonc` for opencode), seeds ingest cursors from now (or from the beginning with `--backfill`), and optionally installs the periodic ingest timer.
- Distribution: a single dependency-light package published to npm (`bunx recall` / `npx recall`), plus optional `bun build --compile` single-binary releases per platform for install without a runtime.

Migration from claude-mem:
- `recall import claude-mem [--db ~/.claude-mem/claude-mem.db]`: one-shot INSERT of existing observations into `recall.db`, then rebuild FTS. Because the schema matches, the 31k existing observations become searchable immediately, before any new capture runs.

Backup and continuation (a first-class goal):
- All state is one SQLite file, so `recall backup` is a consistent copy (SQLite Online Backup API, or optional litestream for continuous replication to a file or S3).
- Restore is dropping the file back. Ingest cursors live inside the DB, so after restoring on a new machine the adapters resume exactly where they stopped, with no re-summarizing and no duplicates (content_hash dedup guards re-runs).
- `recall export --json` writes a portable, tool-independent archive of observations for long-term keeping or moving to another store. `recall export --md` writes the same content as human-readable Markdown (one file per session or per day), which is git-friendly and greppable, for people who prefer a Markdown store or want to read history without the tool. The SQLite file stays the source of truth because it holds the existing 31k rows and supports agent, project, and type filters that flat Markdown cannot; Markdown is an export view, not the primary store.

## Other features (ranked by value)

1. `recall doctor`: verifies each adapter can read its logs, the summarizer provider is reachable, and reports the last successful ingest time. Emits a loud status (exit code plus optional notification or status-line line) so a stalled ingest is visible immediately. This directly fixes the silent-rot failure mode.
2. Redaction before summarizing: strip API keys, tokens, and high-entropy secrets from events before they reach the summarizer or the store. Important because the tool reads full session logs.
3. Dedup via `content_hash` (already a column): safe re-runs and idempotent backfills.
4. Retention and compaction: Codex rollout logs are known to bloat to gigabytes. Prune `raw_events` after summarizing while keeping observations, with a configurable window.
5. Per-project scoping and a `.recallignore` for repos or paths that should never be captured.
6. Multi-machine sync (v2): a sync layer (litestream, or a git-based sync of the JSON export) so history follows you across machines. Kept out of v1 to protect the local-first simplicity.

## Non-goals (v1)

No hosted cloud service. No team sharing or multi-user access control. No mandatory vector database. No always-on daemon. These can be added as plugins later, but the core must run offline from one file.

## Tech stack (decided: Node / Bun)

Runtime: Bun (with Node compatibility as a fallback for contributors who do not run Bun).

- Storage and search: `bun:sqlite`, Bun's built-in SQLite driver, which ships SQLite with FTS5 compiled in. Full-text search needs no external dependency and the import from claude-mem is a direct INSERT. On plain Node, use `better-sqlite3` for the same API surface.
- Filesystem watching: `fs.watch` (Bun and Node) with `chokidar` as the cross-platform fallback for reliable recursive watching, plus a polling loop for the opencode database file.
- MCP server: the official TypeScript MCP SDK (`@modelcontextprotocol/sdk`).
- Summarizer: a thin provider-agnostic client (OpenRouter, Gemini, Anthropic, OpenAI, or local Ollama), one synchronous call per session or chunk.
- Backup: SQLite Online Backup for consistent copies, with `litestream` optional for continuous replication.

Rationale for Node/Bun over Python: it matches claude-mem's own stack, it has the richer MCP and agent-plugin ecosystem (the opencode plugin API and hook surfaces are JavaScript-first), and Bun's bundled SQLite keeps FTS5 a zero-dependency feature while Bun's single-binary builds make distribution simple. The tradeoff accepted here is managing the SQLite binding across Bun and plain Node, handled by a thin storage adapter.

Distribution: publish to npm and provide a `bunx recall` entry point, plus optional `bun build --compile` single-binary releases per platform for install without a runtime.

## Milestones and effort

- M0 (about half a day): schema, `recall import claude-mem`, `recall search` over FTS5. Instant value: query the existing 31k observations as a standalone tool, before any capture code exists.
- M1 (about 1 day): Claude Code capture. A `PostToolUse` and `UserPromptSubmit` hook that append structured event rows to `recall.db`, zero model tokens, real-time, no session-end signal.
- M2 (1 to 2 days): cross-agent capture. Tail adapters for Codex JSONL and the opencode SQLite database, the normalizer, and resumable cursors, all writing the same structured rows.
- M3 (about 1 day): the MCP server and `recall init` wiring into all three agents.
- M4 (about 1 day): `recall doctor`, backup, `recall export --md`, redaction, the loud-failure status.
- M5 (optional, half to 1 day): the on-demand summarizer for prose recall. Not required for search; add only if row-level recall is not enough.

Total: about 4 to 6 focused days to a shippable open-source v1 without any LLM in the core. M0 is usable on its own on day one, and the summarizer in M5 is purely additive.

## Repository layout

```
recall/
  README.md
  LICENSE                 (MIT)
  package.json
  tsconfig.json
  bin/recall.ts           CLI entry (bunx recall / compiled binary)
  src/
    adapters/             claude-code.ts, codex.ts, opencode.ts, base.ts
    normalize.ts
    summarize/            runner.ts, prompt.ts, providers.ts
    store/                db.ts, schema.sql, migrate.ts, import-claudemem.ts
    search.ts
    mcp/                  server.ts
    cli.ts
    doctor.ts
    redact.ts
  test/
  docs/
  .github/workflows/      ci.yml
```

## Risks and mitigations

1. Agent log formats drift across versions. Mitigation: parse defensively, tolerate unknown record types, pin per-agent parser versions, and cover each with a fixture from a real transcript.
2. opencode's SQLite schema is internal and may change without notice. Mitigation: read defensively, keep the opencode adapter isolated, and prefer any stable export the tool offers if one appears.
3. Summarizer quality is the real work, not the plumbing. Mitigation: start from claude-mem's observation shape, iterate the prompt against a fixed recall test (a set of past questions the answers to which are known), and measure retrieval, not vibes.
4. Redaction completeness. Secrets can appear in tool output. Mitigation: layered regex plus entropy detection, an allowlist of safe fields, and a `--no-store-raw` mode for the cautious.
5. Backfilling 3,640 plus 329 transcripts at once is a large one-time summarize cost. Mitigation: backfill is opt-in and rate-limited, and can target a date range or a project.

## Open questions for the owner

1. Runtime: Python (recommended for the core) or Node/Bun (better agent-plugin ecosystem)?
2. Default summarizer provider: reuse the Gemini key already configured, or default to local Ollama for zero cost and zero external dependency?
3. Backfill scope on first run: everything, last 90 days, or nothing until the first new session?
4. Keep raw events, or store only observations after summarizing (privacy and size versus replay fidelity)?
