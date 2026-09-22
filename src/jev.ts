import { TypeSafeClient, choice, score } from "@typesafe-ai/sdk";

/** jev's typed classification for one captured event: a kind label plus an importance score, no LLM prose. */
export interface Enrichment {
  type: string;
  importance: number;
  confidence: number;
}

/** Kind labels jev chooses between when classifying a coding-agent session event. */
export const KIND_CRITERIA = {
  bugfix: null,
  feature: null,
  refactor: null,
  discovery: null,
  decision: null,
  config: null,
  question: null,
  noise: null,
} as const;

/** Rubric levels jev scores importance against, from least to most important. */
export const IMPORTANCE_LEVELS = ["trivial", "minor", "useful", "important", "critical"] as const;

/**
 * Classifies one event's text via jev's `systemOne`. `deps.enrich` bypasses the real
 * client entirely (used by tests, no network/SDK involved). The real path lazily
 * constructs `TypeSafeClient` here, never at import time, so importing this module
 * never requires `TYPESAFE_API_KEY`.
 */
export async function enrichText(
  text: string,
  deps?: { enrich?: (text: string) => Promise<Enrichment> },
): Promise<Enrichment> {
  if (deps?.enrich) {
    return deps.enrich(text);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error("TYPESAFE_API_KEY not set");
  }
  const client = new TypeSafeClient();
  const res = await client.systemOne({
    state: { event: text },
    questions: {
      kind: choice("Classify this coding-agent session event", KIND_CRITERIA),
      importance: score("How important is this event for future recall", IMPORTANCE_LEVELS),
    },
  });
  return {
    type: res.answers.kind.choice,
    importance: res.answers.importance.score,
    confidence: Math.min(res.answers.kind.confidence, res.answers.importance.confidence),
  };
}
