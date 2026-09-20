/**
 * Secret redaction for captured transcript text.
 *
 * Contract: `redact` is called on every event's text, tool_input, and tool_output
 * before it is written to the database, so no secret ever lands in the store or the
 * FTS index. It must be pure, synchronous, and never throw (a redaction failure must
 * not drop an event); on any internal error it returns the input unchanged.
 *
 * Layers, applied in order so a specific match always wins over a generic one:
 *   1. `Authorization: Bearer <token>` — redact just the token.
 *   2. Vendor-shaped keys/tokens (OpenAI, OpenRouter, Google, nvidia, GitHub, Slack, JWT).
 *   3. Generic `api_key = ...` / `token: ...` / `secret = ...` / `password: ...` assignments.
 *
 * There is deliberately no high-entropy catch-all: on real data it masked far more
 * structural metadata (UUIDs, tool-use ids, git SHAs) than actual secrets, degrading
 * search recall for no real security gain given layers 1-3 already cover realistic
 * secret shapes.
 *
 * Each placeholder is typed, e.g. `«redacted:openrouter»`, so a human scanning exported
 * text can tell a secret was there without seeing it.
 */

const REDACTED = (label: string) => `«redacted:${label}»`;

/** `Authorization: Bearer <token>` — keep the scheme, redact the token. */
const BEARER_RE = /\b(authorization\s*:\s*bearer\s+)([^\s'",;]{8,})/gi;

/** High-confidence vendor key/token shapes, checked before the generic passes below. */
const VENDOR_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "openrouter", re: /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g },
  { label: "openai", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "googleapikey", re: /\bAIza[0-9A-Za-z_-]{35,}\b/g },
  { label: "nvidia", re: /\bnvapi-[A-Za-z0-9_-]{20,}\b/g },
  { label: "googleoauth", re: /\bAQ\.[A-Za-z0-9_-]{20,}\b/g },
  { label: "githubtoken", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "slacktoken", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/** Generic `<secret-field> [:=] <value>` assignments, for field names not tied to a vendor shape. */
const ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|password|passwd)\b(\s*[:=]\s*)(['"]?)([^\s'",;]{6,})\3/gi;

/**
 * A plain-English-looking word is not a secret even if it happens to sit right after
 * `token:`/`secret:` in prose ("secret: keeping calm"). Require either a non-letter
 * character (digit/symbol, the common case for real secrets) or an unusually long
 * all-letter run (few English words exceed 20 letters) before treating it as a value.
 */
function looksLikeSecretValue(value: string): boolean {
  if (value.startsWith("«redacted:")) return false;
  if (/^[A-Za-z]+$/.test(value) && value.length < 20) return false;
  return true;
}

/** Applies all redaction layers and returns both the result and which labels fired (for tests/debugging). */
export function redactLabeled(text: string): { text: string; labels: string[] } {
  const labels: string[] = [];
  let out = text;

  out = out.replace(BEARER_RE, (match, prefix: string, value: string) => {
    if (value.startsWith("«redacted:")) return match;
    labels.push("bearer");
    return `${prefix}${REDACTED("bearer")}`;
  });

  for (const { label, re } of VENDOR_PATTERNS) {
    out = out.replace(re, () => {
      labels.push(label);
      return REDACTED(label);
    });
  }

  out = out.replace(ASSIGNMENT_RE, (match, keyword: string, sep: string, quote: string, value: string) => {
    if (!looksLikeSecretValue(value)) return match;
    labels.push("apikey");
    return `${keyword}${sep}${quote}${REDACTED("apikey")}${quote}`;
  });

  return { text: out, labels };
}

/**
 * Redacts secrets from captured transcript text. Pure, synchronous, never throws:
 * on any internal error it returns the original text unchanged rather than dropping it.
 */
export function redact(text: string | null | undefined): string {
  if (!text) return "";
  try {
    return redactLabeled(text).text;
  } catch {
    return text;
  }
}
