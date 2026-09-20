import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { insertObservation } from "./db.ts";
import type { Observation } from "../types.ts";

export function defaultClaudeMemDbPath(): string {
  return join(homedir(), ".claude-mem", "claude-mem.db");
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

interface ClaudeMemObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
  content_hash: string | null;
  generated_by_model: string | null;
  relevance_count: number | null;
  merged_into_project: string | null;
  agent_type: string | null;
  agent_id: string | null;
  metadata: string | null;
  synced_at: number | null;
  origin_device_id: string | null;
  origin_local_id: string | null;
  sync_rev: string;
}

/**
 * Imports claude-mem's `observations` table into recall's `observations` table.
 * Opens the source DB read-only: total-recall must never write to ~/.claude-mem/.
 */
export function importClaudeMem(destDb: Database, srcDbPath: string = defaultClaudeMemDbPath()): ImportResult {
  const src = new Database(srcDbPath, { readonly: true });
  try {
    const rows = src.query("SELECT * FROM observations").all() as ClaudeMemObservationRow[];
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const obs: Omit<Observation, "id"> = {
        memorySessionId: row.memory_session_id,
        project: row.project,
        text: row.text,
        type: row.type,
        title: row.title,
        subtitle: row.subtitle,
        facts: row.facts,
        narrative: row.narrative,
        concepts: row.concepts,
        filesRead: row.files_read,
        filesModified: row.files_modified,
        promptNumber: row.prompt_number,
        discoveryTokens: row.discovery_tokens,
        createdAt: row.created_at,
        createdAtEpoch: row.created_at_epoch,
        contentHash: row.content_hash,
        generatedByModel: row.generated_by_model,
        relevanceCount: row.relevance_count,
        mergedIntoProject: row.merged_into_project,
        agentType: row.agent_type,
        agentId: row.agent_id,
        metadata: row.metadata,
        syncedAt: row.synced_at,
        originDeviceId: row.origin_device_id,
        originLocalId: row.origin_local_id,
        syncRev: row.sync_rev,
      };
      const result = insertObservation(destDb, obs);
      if (result.inserted) {
        imported++;
      } else {
        skipped++;
      }
    }
    return { imported, skipped };
  } finally {
    src.close();
  }
}
