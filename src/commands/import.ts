import { openDb } from "../store/db.ts";
import { defaultClaudeMemDbPath, importClaudeMem } from "../store/import-claudemem.ts";

/** `recall import claude-mem [--db PATH]` */
export function run(args: string[]): void {
  const [source, ...rest] = args;
  if (source !== "claude-mem") {
    console.error(`Unknown import source: ${source ?? "(none)"}. Only "claude-mem" is supported.`);
    process.exit(1);
  }

  let dbPath = defaultClaudeMemDbPath();
  const dbFlagIndex = rest.indexOf("--db");
  if (dbFlagIndex !== -1) {
    const value = rest[dbFlagIndex + 1];
    if (!value) {
      console.error("--db requires a path argument");
      process.exit(1);
    }
    dbPath = value;
  }

  const destDb = openDb();
  try {
    const result = importClaudeMem(destDb, dbPath);
    console.log(`Imported ${result.imported} observations from ${dbPath} (${result.skipped} already present).`);
  } finally {
    destDb.close();
  }
}
