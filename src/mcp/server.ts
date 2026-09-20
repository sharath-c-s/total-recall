import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "bun:sqlite";
import { buildWhere, search as dbSearch } from "../store/db.ts";
import type { SearchFilters, SearchHit } from "../types.ts";

/** One row in a `timeline` result: an event or observation, normalized to a common shape and time-ordered. */
export interface TimelineEntry {
  source: "events" | "observations";
  id: number;
  sessionId: number | string | null;
  agent: string | null;
  project: string | null;
  ts: number | null;
  role: string | null;
  title: string | null;
  text: string | null;
}

export interface SearchToolArgs {
  query: string;
  agent?: string;
  project?: string;
  type?: string;
  since?: number;
  limit?: number;
}

/** `search` tool handler: thin wrapper over `db.search()` so tests can call it without a transport. */
export function searchTool(db: Database, args: SearchToolArgs): SearchHit[] {
  const filters: SearchFilters = {};
  if (args.agent) filters.agent = args.agent;
  if (args.project) filters.project = args.project;
  if (args.type) filters.type = args.type;
  if (args.since !== undefined) filters.since = args.since;
  if (args.limit !== undefined) filters.limit = args.limit;
  return dbSearch(db, args.query, filters);
}

export interface TimelineToolArgs {
  sessionId?: number;
  since?: number;
  limit?: number;
}

/**
 * `timeline` tool handler: recent events and observations, most recent first.
 * Session scoping (`sessionId`) only applies to `events`, because observations
 * key on claude-mem's string `memory_session_id`, not the integer `sessions.id`.
 */
export function timelineTool(db: Database, args: TimelineToolArgs): TimelineEntry[] {
  const limit = args.limit ?? 20;

  const eventWhere = buildWhere([
    { column: "session_id", value: args.sessionId },
    { column: "ts", op: ">=", value: args.since },
  ]);
  const eventWhereSql = eventWhere.clause ? `WHERE ${eventWhere.clause}` : "";
  const eventRows = db
    .query(
      `SELECT id, session_id as sessionId, agent, project, ts, role, text
       FROM events ${eventWhereSql}
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(...eventWhere.params, limit) as Array<{
    id: number;
    sessionId: number;
    agent: string;
    project: string | null;
    ts: number;
    role: string;
    text: string | null;
  }>;
  const entries: TimelineEntry[] = eventRows.map((r) => ({
    source: "events",
    id: r.id,
    sessionId: r.sessionId,
    agent: r.agent,
    project: r.project,
    ts: r.ts,
    role: r.role,
    title: null,
    text: r.text,
  }));

  if (args.sessionId === undefined) {
    const obsWhere = buildWhere([{ column: "created_at_epoch", op: ">=", value: args.since }]);
    const obsWhereSql = obsWhere.clause ? `WHERE ${obsWhere.clause}` : "";
    const obsRows = db
      .query(
        `SELECT id, memory_session_id as sessionId, agent_type as agent, project,
                created_at_epoch as ts, type as role, title, text
         FROM observations ${obsWhereSql}
         ORDER BY created_at_epoch DESC LIMIT ?`,
      )
      .all(...obsWhere.params, limit) as Array<{
      id: number;
      sessionId: string;
      agent: string | null;
      project: string;
      ts: number;
      role: string;
      title: string | null;
      text: string | null;
    }>;
    for (const r of obsRows) {
      entries.push({
        source: "observations",
        id: r.id,
        sessionId: r.sessionId,
        agent: r.agent,
        project: r.project,
        ts: r.ts,
        role: r.role,
        title: r.title,
        text: r.text,
      });
    }
  }

  entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return entries.slice(0, limit);
}

export interface GetToolArgs {
  id: number;
  table: "events" | "observations";
}

/** `get` tool handler: the full, uncapped row for one id, by source table. */
export function getTool(db: Database, args: GetToolArgs): Record<string, unknown> | null {
  const sql = args.table === "events" ? "SELECT * FROM events WHERE id = ?" : "SELECT * FROM observations WHERE id = ?";
  const row = db.query(sql).get(args.id) as Record<string, unknown> | undefined;
  return row ?? null;
}

/** Builds the MCP server exposing `search`, `timeline`, and `get` over the given recall database. */
export function createRecallMcpServer(db: Database): McpServer {
  const server = new McpServer({ name: "total-recall", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      title: "Search recall history",
      description:
        "Full-text search across every captured agent session (Claude Code, Codex, opencode): user prompts, " +
        "assistant output, and tool calls, plus imported claude-mem observations. Call this first for 'what did " +
        "I do / decide / fix about X' questions. Ranked by BM25 relevance (lower rank = more relevant); each hit " +
        "is tagged with its source table ('events' or 'observations') and source agent. Use the `get` tool with " +
        "a hit's id and source to fetch its full, uncapped text.",
      inputSchema: {
        query: z.string().describe("Free-text search query, e.g. 'bigquery column position fix'."),
        agent: z.enum(["claude-code", "codex", "opencode"]).optional().describe("Restrict results to one agent."),
        project: z.string().optional().describe("Restrict results to one project name."),
        type: z.string().optional().describe("Restrict by event role (user/assistant/tool) or observation type."),
        since: z.number().optional().describe("Only rows at or after this timestamp (epoch, same units as stored ts)."),
        limit: z.number().int().positive().optional().describe("Max results to return (default 20)."),
      },
    },
    async (args) => {
      const hits = searchTool(db, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(hits, null, 2) }],
        structuredContent: { hits },
      };
    },
  );

  server.registerTool(
    "timeline",
    {
      title: "Recent timeline",
      description:
        "Returns recent captured events and observations in time order, most recent first. Optionally scoped " +
        "to one `session_id` (events only) or a `since` timestamp. Use this to browse 'what happened recently' " +
        "or walk a specific session chronologically; use `search` instead when ranking by relevance to a query.",
      inputSchema: {
        session_id: z
          .number()
          .int()
          .optional()
          .describe("Restrict to one sessions.id (events only; observations aren't linked to it)."),
        since: z.number().optional().describe("Only entries at or after this timestamp (epoch)."),
        limit: z.number().int().positive().optional().describe("Max entries to return (default 20)."),
      },
    },
    async (args) => {
      const entries = timelineTool(db, { sessionId: args.session_id, since: args.since, limit: args.limit });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
        structuredContent: { entries },
      };
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get full row",
      description:
        "Fetches the full, uncapped row for one id from a `search` or `timeline` result. Pass the `table` field " +
        "from that result ('events' or 'observations') plus the `id`. Use this when a search snippet is " +
        "truncated and the complete text, tool input, or tool output is needed.",
      inputSchema: {
        id: z.number().int().describe("Row id, from a prior search/timeline result."),
        table: z.enum(["events", "observations"]).describe("Which table the id belongs to."),
      },
    },
    async (args) => {
      const row = getTool(db, args);
      if (!row) {
        return {
          content: [{ type: "text" as const, text: `No ${args.table} row with id ${args.id}.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }], structuredContent: { row } };
    },
  );

  return server;
}

/** Connects a recall MCP server to stdio; resolves when the transport closes (parent process disconnects). */
export async function startStdioServer(db: Database): Promise<void> {
  const server = createRecallMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
