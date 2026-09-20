import { Database } from "bun:sqlite";

/** Minimal claude-mem-shaped fixture: just enough of `observations` (+ FTS) for import tests. */
export function buildClaudeMemFixture(path: string, rows: number = 3): void {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      content_hash TEXT,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0,
      merged_into_project TEXT,
      agent_type TEXT,
      agent_id TEXT,
      metadata TEXT,
      synced_at INTEGER,
      origin_device_id TEXT,
      origin_local_id TEXT,
      sync_rev TEXT NOT NULL DEFAULT '1'
    );
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title, subtitle, narrative, text, facts, concepts,
      content='observations', content_rowid='id'
    );
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END;
  `);
  const insert = db.query(
    `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, created_at, created_at_epoch, agent_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < rows; i++) {
    insert.run(
      `sess-${i}`,
      "total-recall",
      `observation body mentioning bigquery column ${i}`,
      "insight",
      `Title ${i}`,
      `Narrative about bigquery column position fix number ${i}`,
      new Date(2024, 0, i + 1).toISOString(),
      1_700_000_000 + i,
      "claude-code",
    );
  }
  db.close();
}
