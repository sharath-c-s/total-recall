import { openDb } from "../store/db.ts";
import { renderSearch } from "../search.ts";
import type { SearchFilters } from "../types.ts";

/** `recall search "<q>" [--agent] [--project] [--type] [--since] [--limit]` */
export function run(args: string[]): void {
  const positional: string[] = [];
  const filters: SearchFilters = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        filters.agent = args[++i];
        break;
      case "--project":
        filters.project = args[++i];
        break;
      case "--type":
        filters.type = args[++i];
        break;
      case "--since":
        filters.since = Number(args[++i]);
        break;
      case "--limit":
        filters.limit = Number(args[++i]);
        break;
      default:
        positional.push(arg);
    }
  }

  const query = positional.join(" ").trim();
  if (!query) {
    console.error('Usage: recall search "<query>" [--agent] [--project] [--type] [--since] [--limit]');
    process.exit(1);
  }

  const db = openDb();
  try {
    console.log(renderSearch(db, query, filters));
  } finally {
    db.close();
  }
}
