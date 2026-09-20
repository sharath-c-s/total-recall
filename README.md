# total-recall

Local-first, cross-agent memory tool: indexes coding-agent session transcripts
(Claude Code, Codex, opencode) into one SQLite database with FTS5 full-text
search, and imports an existing claude-mem database so history carries over.

See [PLAN.md](./PLAN.md) for the full design, architecture, and roadmap.

## Status

Working end to end. Capture adapters for Claude Code, Codex, and opencode tail each agent's native session store and write normalized, redacted, deduped rows into one SQLite database with FTS5 search (`recall ingest`). `recall search` and `recall export` query it. `recall import claude-mem` brings in an existing claude-mem database unchanged. The MCP server (`recall mcp`) exposes `search`, `timeline`, and `get` to any MCP-speaking agent. `recall init` wires the MCP server (and an optional SessionStart hook) into each detected agent's config, and `--backfill` runs a full ingest backfill in the same step. `recall doctor` reports per-adapter health and flags a stalled ingest.

## Quick start

```bash
bun install
bun run bin/recall.ts import claude-mem
bun run bin/recall.ts ingest --backfill
bun run bin/recall.ts search "bigquery column"
bun run bin/recall.ts init --backfill
```
