/**
 * The shared help renderer. Consumes the Subcommand registry and each
 * subcommand's SubUsage and builds uniform, column-aligned pages - all
 * padding is computed here, none is hand-maintained in the commands.
 * Pure string builders: the dispatcher decides the stream (stderr) and
 * the exit code.
 */
import type { FlagSpec, Subcommand } from "./types";

/** Render width: descriptions wrap past this column with a hanging indent. */
const WIDTH = 100;

/** Splits text into lines of at most `width` characters, breaking on spaces. */
function wrapLine(text: string, width: number): string[] {
  const words = text.split(" ").filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Wraps a paragraph, prefixing every line with `indent` spaces. */
function wrapParagraph(text: string, indent: number): string[] {
  return wrapLine(text, WIDTH - indent).map((line) => `${" ".repeat(indent)}${line}`);
}

/**
 * A two-column table: the left column pads to the widest form, the
 * description column wraps with a hanging indent aligned under it.
 * Serves both the flag tables (form = "--store, -s") and the command
 * listings (form = "thatch stores" or a child's bare name).
 */
function twoColumnTable(rows: { form: string; description: string }[]): string[] {
  const width = Math.max(...rows.map((r) => r.form.length));
  const out: string[] = [];
  for (const row of rows) {
    const descLines = wrapLine(row.description, WIDTH - 4 - width);
    const first = descLines.shift() ?? "";
    out.push(`  ${row.form.padEnd(width)}  ${first}`.trimEnd());
    for (const line of descLines) out.push(`  ${" ".repeat(width)}  ${line}`);
  }
  return out;
}

/** Joins a flag's spellings: the pair, or whichever form exists. */
function flagForm(flag: FlagSpec): string {
  if (flag.long && flag.short) return `${flag.long}, ${flag.short}`;
  return flag.long ?? flag.short ?? "";
}

/**
 * The top-level page: the version and help forms, then one line per
 * registered subcommand with its summary, then the store-default note
 * that applies across the memory commands.
 */
export function renderGlobal(commands: Subcommand[]): string {
  const rows = [
    { form: "thatch --version, -v", description: "Print version and exit" },
    { form: "thatch help [sub]", description: "Print help for thatch or one subcommand" },
    {
      form: "thatch -h, --help",
      description: "Print help (top-level help before a subcommand; that subcommand's help after it)",
    },
    ...commands.map((c) => ({ form: `thatch ${c.name}`, description: c.summary })),
  ];
  return [
    "USAGE",
    ...twoColumnTable(rows),
    "",
    ...wrapParagraph(
      'Stores default to the repo detected from git remote. Use "global" for the global store. Use "all" with search to search project + global together.',
      0,
    ),
  ].join("\n");
}

/**
 * One subcommand's page: the usage line, the summary paragraph, the
 * flag table (omitted when the command has no flags), any note
 * paragraphs, and - for a namespace - the child listing.
 */
export function renderCommand(cmd: Subcommand): string {
  const usage = cmd.usage();
  const lines = ["USAGE", `  ${usage.synopsis}`, "", ...wrapParagraph(cmd.summary, 2)];
  if (usage.flags.length > 0) {
    lines.push(
      "",
      "FLAGS",
      ...twoColumnTable(usage.flags.map((f) => ({ form: flagForm(f), description: f.description }))),
    );
  }
  for (const note of usage.notes ?? []) {
    lines.push("", ...wrapParagraph(note, 0));
  }
  if (cmd.children && cmd.children.length > 0) {
    lines.push(
      "",
      "SUBCOMMANDS",
      ...twoColumnTable(cmd.children.map((c) => ({ form: c.name, description: c.summary }))),
    );
  }
  return lines.join("\n");
}

/**
 * Prints a subcommand's page to stderr and exits (default 1). Help is
 * never stdout data: scripts pipe real output, and the QA runner checks
 * stdout stays empty on a help request.
 */
export function printCommandHelp(cmd: Subcommand, exitCode = 1): never {
  console.error(renderCommand(cmd));
  process.exit(exitCode);
}
