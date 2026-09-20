import { contentHash } from "./store/db.ts";
import { redact } from "./redact.ts";
import type { Event, Agent } from "./types.ts";
import type { RawEvent } from "./adapters/base.ts";

/** Keep this many bytes at the head and tail of a capped tool_output; the middle is elided. */
const TOOL_OUTPUT_CAP_BYTES = 4096;

/**
 * Caps `raw` to ~4KB head + ~4KB tail with the middle elided, and records the
 * true byte size (pre-cap) for `tool_output_bytes`.
 */
export function capToolOutput(raw: string): { text: string; bytes: number } {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= TOOL_OUTPUT_CAP_BYTES * 2) return { text: raw, bytes };
  const buf = Buffer.from(raw, "utf8");
  // ponytail: slicing at a fixed byte offset can split a multi-byte UTF-8 char
  // at the head/tail seam (renders as a stray replacement char); acceptable
  // for a capped preview whose job is search recall, not exact replay.
  const head = buf.subarray(0, TOOL_OUTPUT_CAP_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - TOOL_OUTPUT_CAP_BYTES).toString("utf8");
  const elided = bytes - TOOL_OUTPUT_CAP_BYTES * 2;
  return { text: `${head}\n...[elided ${elided} bytes]...\n${tail}`, bytes };
}

export interface NormalizeContext {
  agent: Agent;
  project: string | null;
  /** Folded into the content hash so identical text in different sessions never collides. */
  sourceKey: string;
}

export type NormalizedEvent = Omit<Event, "id" | "sessionId">;

/**
 * Maps one adapter-produced RawEvent to the common `events` row shape: this
 * is the one place (shared by every adapter) that redacts text/tool_input/
 * tool_output, caps tool_output, and computes the dedup content_hash.
 */
export function normalizeEvent(raw: RawEvent, ctx: NormalizeContext): NormalizedEvent {
  const text = raw.text ? redact(raw.text) : null;

  let toolInput: string | null = null;
  if (raw.toolInput !== null && raw.toolInput !== undefined) {
    const serialized = typeof raw.toolInput === "string" ? raw.toolInput : JSON.stringify(raw.toolInput);
    toolInput = redact(serialized);
  }

  let toolOutput: string | null = null;
  let toolOutputBytes: number | null = null;
  if (raw.toolOutput) {
    const capped = capToolOutput(raw.toolOutput);
    toolOutput = redact(capped.text);
    toolOutputBytes = capped.bytes;
  }

  const hash = contentHash(ctx.agent, ctx.sourceKey, String(raw.ts), raw.role, raw.tool, text, toolInput, toolOutput);

  return {
    agent: ctx.agent,
    project: ctx.project,
    ts: raw.ts,
    role: raw.role,
    tool: raw.tool,
    text,
    toolInput,
    toolOutput,
    toolOutputBytes,
    contentHash: hash,
  };
}
