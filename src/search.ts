import type { Database } from "bun:sqlite";
import { search as dbSearch } from "./store/db.ts";
import type { SearchFilters, SearchHit } from "./types.ts";

/** Renders one hit as a CLI-friendly line: source, rank, agent/project, and a snippet. */
export function formatHit(hit: SearchHit): string {
  const when = hit.ts ? new Date(hit.ts > 2_000_000_000 ? hit.ts : hit.ts * 1000).toISOString() : "unknown time";
  const agent = hit.agent ?? "unknown-agent";
  const project = hit.project ?? "unknown-project";
  const title = hit.title ? ` "${hit.title}"` : "";
  return `[${hit.source}] (${agent}/${project} @ ${when})${title}\n  ${hit.snippet}`;
}

/** Runs a search and renders results, already ordered by bm25 rank (ascending = more relevant). */
export function renderSearch(db: Database, query: string, filters: SearchFilters = {}): string {
  const hits = dbSearch(db, query, filters);
  if (hits.length === 0) {
    return "No results.";
  }
  return hits.map(formatHit).join("\n\n");
}
