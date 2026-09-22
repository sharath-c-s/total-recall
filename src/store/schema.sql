-- total-recall schema. Applied idempotently by src/store/db.ts, which tracks
-- the current version in schema_versions and re-runs this file only on a
-- version bump.

CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  source_path TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);

-- Primary searchable table: one row per transcript event (user prompt,
-- assistant text, or tool call), per PLAN "Store" and "Capture" sections.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  project TEXT,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  tool TEXT,
  text TEXT,
  tool_input TEXT,
  tool_output TEXT,
  tool_output_bytes INTEGER,
  content_hash TEXT NOT NULL,
  -- Opt-in jev enrichment (schema v2, `recall enrich`); null until enriched.
  jev_type TEXT,
  jev_importance REAL,
  jev_confidence REAL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_content_hash ON events(content_hash);
CREATE INDEX IF NOT EXISTS idx_events_jev_type ON events(jev_type);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  role,
  text,
  tool_input,
  tool_output,
  content='events',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, role, text, tool_input, tool_output)
  VALUES (new.id, new.role, new.text, new.tool_input, new.tool_output);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, role, text, tool_input, tool_output)
  VALUES ('delete', old.id, old.role, old.text, old.tool_input, old.tool_output);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, role, text, tool_input, tool_output)
  VALUES ('delete', old.id, old.role, old.text, old.tool_input, old.tool_output);
  INSERT INTO events_fts(rowid, role, text, tool_input, tool_output)
  VALUES (new.id, new.role, new.text, new.tool_input, new.tool_output);
END;

-- Columns are IDENTICAL to claude-mem's `observations` table (verified via
-- `sqlite3 ~/.claude-mem/claude-mem.db ".schema observations"`) so the
-- existing ~31k rows import as a direct INSERT with no column mapping.
CREATE TABLE IF NOT EXISTS observations (
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

CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  subtitle,
  narrative,
  text,
  facts,
  concepts,
  content='observations',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
END;

CREATE TABLE IF NOT EXISTS ingest_cursors (
  agent TEXT NOT NULL,
  source_path TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent, source_path)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);
