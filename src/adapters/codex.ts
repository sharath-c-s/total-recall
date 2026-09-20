import { basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { readAllJsonl, tailJsonl, walkFiles } from "./base.ts";
import type { Adapter, IterEventsResult, RawEvent, SessionRef } from "./base.ts";

/** Default root for Codex rollout transcripts; `CODEX_SESSIONS_DIR` overrides for tests. */
export function defaultCodexRoot(): string {
  return process.env.CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions");
}

/** Pulls cwd/git branch off the `session_meta` line, which is always line 1 of a rollout file. */
function peekMeta(path: string): { cwd: string | null; gitBranch: string | null } {
  for (const record of readAllJsonl(path)) {
    const r = record as Record<string, unknown>;
    if (r.type === "session_meta") {
      const payload = r.payload as Record<string, unknown> | undefined;
      const cwd = typeof payload?.cwd === "string" ? (payload.cwd as string) : null;
      const git = payload?.git as Record<string, unknown> | undefined;
      const gitBranch = typeof git?.branch === "string" ? (git.branch as string) : null;
      return { cwd, gitBranch };
    }
  }
  return { cwd: null, gitBranch: null };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // not JSON (e.g. a plain apply_patch-style body): keep as-is
  }
}

export const codexAdapter: Adapter = {
  name: "codex",

  discoverSessions(_db: Database): SessionRef[] {
    const root = defaultCodexRoot();
    const files = walkFiles(root, (p) => basename(p).startsWith("rollout-") && p.endsWith(".jsonl"));
    return files.map((file) => {
      const meta = peekMeta(file);
      return {
        agent: "codex",
        sourcePath: file,
        cursorPath: file,
        cwd: meta.cwd,
        project: meta.cwd ? basename(meta.cwd) : basename(file, ".jsonl"),
        gitBranch: meta.gitBranch,
        startedAt: null,
      } satisfies SessionRef;
    });
  },

  iterEvents(session: SessionRef, fromCursor: string | null): IterEventsResult {
    const fromOffset = fromCursor ? Number(fromCursor) : 0;
    const { records, newOffset } = tailJsonl(session.sourcePath, fromOffset);
    const events: RawEvent[] = [];
    // Short-lived, per-batch correlation so a *_call_output line can be
    // tagged with the tool name its matching *_call line already told us.
    // Known limitation: this map only lives for one iterEvents() call, so a
    // call/call_output pair split across a cursor boundary (call in one
    // ingest run, output in the next) stores tool: null on the output.
    const toolNameByCallId = new Map<string, string>();

    for (const record of records) {
      const r = record as Record<string, unknown>;
      const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      if (Number.isNaN(ts)) continue;
      const payload = r.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (r.type === "event_msg") {
        if (payload.type === "user_message" && typeof payload.message === "string") {
          events.push({ ts, role: "user", tool: null, text: payload.message, toolInput: null, toolOutput: null });
        } else if (payload.type === "agent_message" && typeof payload.message === "string") {
          events.push({ ts, role: "assistant", tool: null, text: payload.message, toolInput: null, toolOutput: null });
        }
        // agent_reasoning, token_count, turn_aborted: not answer-bearing, skip.
      } else if (r.type === "response_item") {
        const kind = payload.type;
        if (kind === "function_call") {
          const name = typeof payload.name === "string" ? payload.name : null;
          const callId = typeof payload.call_id === "string" ? payload.call_id : null;
          if (name && callId) toolNameByCallId.set(callId, name);
          events.push({ ts, role: "tool", tool: name, text: null, toolInput: parseArguments(payload.arguments), toolOutput: null });
        } else if (kind === "function_call_output") {
          const callId = typeof payload.call_id === "string" ? payload.call_id : null;
          const tool = callId ? toolNameByCallId.get(callId) ?? null : null;
          const output = typeof payload.output === "string" ? payload.output : null;
          events.push({ ts, role: "tool", tool, text: null, toolInput: null, toolOutput: output });
        } else if (kind === "custom_tool_call") {
          const name = typeof payload.name === "string" ? payload.name : null;
          const callId = typeof payload.call_id === "string" ? payload.call_id : null;
          if (name && callId) toolNameByCallId.set(callId, name);
          const input = typeof payload.input === "string" ? payload.input : null;
          events.push({ ts, role: "tool", tool: name, text: null, toolInput: input, toolOutput: null });
        } else if (kind === "custom_tool_call_output") {
          const callId = typeof payload.call_id === "string" ? payload.call_id : null;
          const tool = callId ? toolNameByCallId.get(callId) ?? null : null;
          const output = typeof payload.output === "string" ? payload.output : null;
          events.push({ ts, role: "tool", tool, text: null, toolInput: null, toolOutput: output });
        }
        // "message" items (developer/user/assistant prose already given via event_msg) are skipped to avoid double-indexing.
      }
      // session_meta: metadata only, handled in discoverSessions.
      // turn_context, compacted: session/turn bookkeeping, not transcript content; skip.
    }

    return { events, newCursor: String(newOffset) };
  },
};
