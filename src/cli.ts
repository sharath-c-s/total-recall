/**
 * Command-registry CLI: subcommand -> dynamic import of `src/commands/<name>.ts`.
 * Later milestones add a command by dropping in a new file here; this file never changes.
 */
const COMMANDS = [
  "import",
  "search",
  "ingest",
  "mcp",
  "init",
  "doctor",
  "export",
  "ask",
  "summarize",
  "enrich",
] as const;

export interface Command {
  run(args: string[]): Promise<void> | void;
}

export async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  if (!name || name === "-h" || name === "--help") {
    printHelp();
    process.exit(name ? 0 : 1);
  }

  if (!(COMMANDS as readonly string[]).includes(name)) {
    console.error(`Unknown command: ${name}`);
    printHelp();
    process.exit(1);
  }

  const mod = (await import(`./commands/${name}.ts`)) as Command;
  await mod.run(rest);
}

function printHelp(): void {
  console.log(`recall <command> [args]\n\nCommands:\n  ${COMMANDS.join("\n  ")}`);
}
