import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Agent, EventRole } from "../types.ts";

/**
 * One resumable transcript source: one JSONL file (claude-code, codex) or one
 * native session row (opencode).
 */
export interface SessionRef {
  agent: Agent;
  /** Unique key for the `sessions.source_path` column. */
  sourcePath: string;
  /**
   * Key used to look up/store the ingest cursor. Equals `sourcePath` for
   * per-file adapters; opencode shares one cursor (the DB path) across every
   * session found in its single database file.
   */
  cursorPath: string;
  cwd: string | null;
  project: string | null;
  gitBranch: string | null;
  startedAt: number | null;
}

/**
 * One transcript event already mapped to the common role/tool/text shape,
 * but not yet redacted, capped, or hashed — normalize.ts does that in one
 * place shared by every adapter. `toolInput` is the native value (object or
 * string), never pre-JSON-stringified.
 */
export interface RawEvent {
  ts: number;
  role: EventRole;
  tool: string | null;
  text: string | null;
  toolInput: unknown;
  toolOutput: string | null;
}

export interface IterEventsResult {
  events: RawEvent[];
  /** Opaque, adapter-defined resume position: byte offset for file tails, epoch-ms for opencode. */
  newCursor: string;
}

export interface Adapter {
  name: Agent;
  discoverSessions(db: Database): SessionRef[];
  iterEvents(session: SessionRef, fromCursor: string | null): IterEventsResult;
}

/** Recursively lists files under `root` matching `predicate`; returns [] if `root` is missing (agent not installed). */
export function walkFiles(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // missing/unreadable dir: agent not installed, or a race with log rotation
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  }
  return out;
}

/**
 * Tails a JSONL file from a byte offset. Only complete, newline-terminated
 * lines are parsed and consumed; a trailing partial line (log still being
 * written) is left for the next call. Malformed lines are skipped, not thrown.
 */
export function tailJsonl(path: string, fromOffset: number): { records: unknown[]; newOffset: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return { records: [], newOffset: fromOffset };
  }
  // `fromOffset > buf.length` means the file is now shorter than our last read position: it was
  // rotated/replaced (not just appended to), so the old offset points past the end of the new
  // content. Re-read the new file from the start instead of returning [] and silently losing it.
  // `fromOffset === buf.length` genuinely means "caught up, nothing new".
  const startOffset = fromOffset > buf.length ? 0 : fromOffset;
  if (startOffset === buf.length) return { records: [], newOffset: buf.length };

  const text = buf.subarray(startOffset).toString("utf8");
  const lines = text.split("\n");
  const completeCount = lines.length - 1; // last element is "" (trailing \n) or a partial line; never process it
  const records: unknown[] = [];
  let consumedBytes = 0;
  for (let i = 0; i < completeCount; i++) {
    const line = lines[i];
    consumedBytes += Buffer.byteLength(line, "utf8") + 1; // +1 for the '\n'
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // malformed line: skip, don't crash
    }
  }
  return { records, newOffset: startOffset + consumedBytes };
}

/** Reads every line of a JSONL file (used only for cheap session-metadata discovery, not tailing). */
export function readAllJsonl(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // malformed line: skip, don't crash
    }
  }
  return out;
}
