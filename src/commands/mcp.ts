import { openDb } from "../store/db.ts";
import { startStdioServer } from "../mcp/server.ts";

/** `recall mcp`: starts the MCP server on stdio (search/timeline/get), for Claude Code, Codex, and opencode. */
export async function run(_args: string[]): Promise<void> {
  const db = openDb();
  try {
    await startStdioServer(db);
  } finally {
    db.close();
  }
}
