import type { Database } from "bun:sqlite";
import { openDb } from "../store/db.ts";
import { enrichText } from "../jev.ts";
import type { Enrichment } from "../jev.ts";
import type { Agent } from "../types.ts";

export interface EnrichOptions {
  since: number | null;
  agent: Agent | null;
  limit: number;
  concurrency: number;
  dryRun: boolean;
}

export interface EnrichDeps {
  enrich?: (text: string) => Promise<Enrichment>;
}

export interface EnrichSummary {
  enriched: number;
  skipped: number;
  errors: number;
}

function parseArgs(args: string[]): EnrichOptions {
  const opts: EnrichOptions = { since: null, agent: null, limit: 200, concurrency: 4, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--since":
        opts.since = parseSince(args[++i]);
        break;
      case "--agent":
        opts.agent = args[++i] as Agent;
        break;
      case "--limit":
        opts.limit = Number(args[++i]);
        break;
      case "--concurrency":
        opts.concurrency = Number(args[++i]);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

/** Accepts a relative duration ("7d", "24h", "30m") or an ISO 8601 timestamp. */
function parseSince(value: string | undefined): number {
  if (!value) {
    console.error("--since requires a value (e.g. 7d, 24h, or an ISO timestamp)");
    process.exit(1);
  }
  const m = /^(\d+)(d|h|m)$/.exec(value);
  if (m) {
    const amount = Number(m[1]);
    const unitMs = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
    return Date.now() - amount * unitMs;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid --since value: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function printHelp(): void {
  console.log(
    `recall enrich [--since <iso|dur>] [--agent claude-code|codex|opencode] [--limit N] [--concurrency K] [--dry-run]\n\n` +
      "Labels captured events with a jev-classified type and importance score. Opt-in only: never runs during ingest.\n" +
      "Only enriches events with jev_type IS NULL (resumable); a second run with no new events enriches 0.\n" +
      "Requires TYPESAFE_API_KEY unless run against injected test dependencies.",
  );
}

/** Runs `worker` over `items` with at most `concurrency` in flight at once. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function drain(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => drain()));
}

interface CandidateRow {
  id: number;
  text: string | null;
}

/**
 * Enriches up to `opts.limit` un-enriched `events` rows (role in user/assistant, `jev_type IS NULL`),
 * newest first. Bounded concurrency, per-event errors logged and skipped (never abort the batch),
 * `--dry-run` classifies without writing. `deps.enrich` bypasses the real jev client for tests.
 */
export async function enrich(db: Database, opts: EnrichOptions, deps: EnrichDeps = {}): Promise<EnrichSummary> {
  const conditions = ["role IN ('user','assistant')", "jev_type IS NULL"];
  const params: Array<string | number> = [];
  if (opts.since !== null) {
    conditions.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.agent) {
    conditions.push("agent = ?");
    params.push(opts.agent);
  }

  const rows = db
    .query(`SELECT id, text FROM events WHERE ${conditions.join(" AND ")} ORDER BY ts DESC LIMIT ?`)
    .all(...params, opts.limit) as CandidateRow[];

  const update = db.query("UPDATE events SET jev_type = ?, jev_importance = ?, jev_confidence = ? WHERE id = ?");
  const summary: EnrichSummary = { enriched: 0, skipped: 0, errors: 0 };

  await runPool(rows, opts.concurrency, async (row) => {
    if (!row.text) {
      summary.skipped++;
      return;
    }
    try {
      const enrichment = await enrichText(row.text, deps);
      if (!opts.dryRun) {
        update.run(enrichment.type, enrichment.importance, enrichment.confidence, row.id);
      }
      summary.enriched++;
    } catch (err) {
      summary.errors++;
      console.error(`recall enrich: event ${row.id} failed: ${(err as Error).message}`);
    }
  });

  return summary;
}

/** `recall enrich [--since <iso|dur>] [--agent claude-code|codex|opencode] [--limit N] [--concurrency K] [--dry-run]` */
export async function run(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const db = openDb();
  try {
    const summary = await enrich(db, opts);
    console.log(
      `recall enrich: ${summary.enriched} enriched, ${summary.skipped} skipped, ${summary.errors} error(s)` +
        `${opts.dryRun ? " (dry run)" : ""}.`,
    );
  } finally {
    db.close();
  }
}
