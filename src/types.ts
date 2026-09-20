/** Agent identifiers recognized across the codebase. */
export type Agent = "claude-code" | "codex" | "opencode";

/** Role of an event within a session transcript. */
export type EventRole = "user" | "assistant" | "tool";

/** One row of the `sessions` table: metadata about a captured agent session. */
export interface SessionRow {
  id: number;
  agent: Agent;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  sourcePath: string;
}

/** One row of the `events` table: a single transcript event (prompt, assistant text, or tool call). */
export interface Event {
  id: number;
  sessionId: number;
  agent: Agent;
  project: string | null;
  ts: number;
  role: EventRole;
  tool: string | null;
  text: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  toolOutputBytes: number | null;
  contentHash: string;
}

/**
 * One row of the `observations` table. Columns mirror claude-mem's
 * `observations` schema 1:1 so its ~31k rows import unchanged.
 */
export interface Observation {
  id: number;
  memorySessionId: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  filesRead: string | null;
  filesModified: string | null;
  promptNumber: number | null;
  discoveryTokens: number | null;
  createdAt: string;
  createdAtEpoch: number;
  contentHash: string | null;
  generatedByModel: string | null;
  relevanceCount: number | null;
  mergedIntoProject: string | null;
  agentType: string | null;
  agentId: string | null;
  metadata: string | null;
  syncedAt: number | null;
  originDeviceId: string | null;
  originLocalId: string | null;
  syncRev: string;
}

/** A unified search result, tagged with which underlying table it came from. */
export interface SearchHit {
  source: "events" | "observations";
  id: number;
  agent: Agent | string | null;
  project: string | null;
  ts: number | null;
  title: string | null;
  snippet: string;
  rank: number;
}

/** Filters accepted by `search()` and the `recall search` command. */
export interface SearchFilters {
  agent?: string;
  project?: string;
  type?: string;
  since?: number;
  limit?: number;
}
