import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import { readAllJsonl, tailJsonl, walkFiles } from "./base.ts";
import type { Adapter, IterEventsResult, RawEvent, SessionRef } from "./base.ts";

/** Default root for Claude Code project transcripts; `CLAUDE_CODE_PROJECTS_DIR` overrides for tests. */
export function defaultClaudeCodeRoot(): string {
  return process.env.CLAUDE_CODE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

interface ContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** Best-effort metadata (cwd/gitBranch/sessionId) pulled from the first line that carries it. */
function peekMeta(path: string): { cwd: string | null; gitBranch: string | null; sessionId: string | null } {
  for (const record of readAllJsonl(path)) {
    const r = record as Record<string, unknown>;
    if (typeof r.cwd === "string" || typeof r.sessionId === "string") {
      return {
        cwd: typeof r.cwd === "string" ? r.cwd : null,
        gitBranch: typeof r.gitBranch === "string" ? r.gitBranch : null,
        sessionId: typeof r.sessionId === "string" ? r.sessionId : null,
      };
    }
  }
  return { cwd: null, gitBranch: null, sessionId: null };
}

function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = (content as ContentPart[])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (texts.length) return texts.join("\n");
  }
  if (content !== null && content !== undefined) return JSON.stringify(content);
  return null;
}

export const claudeCodeAdapter: Adapter = {
  name: "claude-code",

  discoverSessions(_db: Database): SessionRef[] {
    const root = defaultClaudeCodeRoot();
    const files = walkFiles(root, (p) => p.endsWith(".jsonl"));
    return files.map((file) => {
      const meta = peekMeta(file);
      return {
        agent: "claude-code",
        sourcePath: file,
        cursorPath: file,
        cwd: meta.cwd,
        project: meta.cwd ? basename(meta.cwd) : basename(dirname(file)),
        gitBranch: meta.gitBranch,
        startedAt: null,
      } satisfies SessionRef;
    });
  },

  iterEvents(session: SessionRef, fromCursor: string | null): IterEventsResult {
    const fromOffset = fromCursor ? Number(fromCursor) : 0;
    const { records, newOffset } = tailJsonl(session.sourcePath, fromOffset);
    const events: RawEvent[] = [];
    // Short-lived, per-batch correlation so a tool_result line can be tagged
    // with the tool name its matching tool_use line already told us.
    // Known limitation: this map only lives for one iterEvents() call, so a
    // tool_use/tool_result pair split across a cursor boundary (use in one
    // ingest run, result in the next) stores tool: null on the result.
    const toolNameByUseId = new Map<string, string>();

    for (const record of records) {
      const r = record as Record<string, unknown>;
      const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      if (Number.isNaN(ts)) continue;

      if (r.type === "assistant") {
        const message = r.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content as ContentPart[]) {
          if (part.type === "text" && typeof part.text === "string") {
            events.push({ ts, role: "assistant", tool: null, text: part.text, toolInput: null, toolOutput: null });
          } else if (part.type === "tool_use") {
            const name = typeof part.name === "string" ? part.name : null;
            if (name && typeof part.id === "string") toolNameByUseId.set(part.id, name);
            events.push({ ts, role: "tool", tool: name, text: null, toolInput: part.input ?? null, toolOutput: null });
          }
        }
      } else if (r.type === "user") {
        const message = r.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (typeof content === "string") {
          events.push({ ts, role: "user", tool: null, text: content, toolInput: null, toolOutput: null });
        } else if (Array.isArray(content)) {
          for (const part of content as ContentPart[]) {
            if (part.type === "text" && typeof part.text === "string") {
              events.push({ ts, role: "user", tool: null, text: part.text, toolInput: null, toolOutput: null });
            } else if (part.type === "tool_result") {
              const tool = typeof part.tool_use_id === "string" ? toolNameByUseId.get(part.tool_use_id) ?? null : null;
              const output = toolResultText(part.content);
              events.push({ ts, role: "tool", tool, text: null, toolInput: null, toolOutput: output });
            }
          }
        }
      }
    }

    return { events, newCursor: String(newOffset) };
  },
};
