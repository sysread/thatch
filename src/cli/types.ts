import type { ThatchDB } from "../db";

/**
 * One documented flag form of a subcommand. A flag documents its long
 * and/or short spelling; the absent form is null, so the renderer can
 * print "--json" alone, "-x" alone, or "--store, -s" for the pair.
 */
export interface FlagSpec {
  long: string | null;
  short: string | null;
  description: string;
}

/**
 * Everything the shared help renderer needs to print one subcommand's
 * page: the full usage line, the flag triplets, and any paragraph docs
 * that do not fit a flag description (the renderer prints notes after
 * the flag table).
 */
export interface SubUsage {
  synopsis: string;
  flags: FlagSpec[];
  notes?: string[];
}

/**
 * What the dispatcher hands a subcommand's run(). The dispatcher opens
 * db once before run() and closes it after run() returns; a command
 * that takes over the process (mcp) or closes the handle itself (chat
 * tail's finally) documents that in its own body - the context never
 * re-opens the database.
 */
export interface CliContext {
  db: ThatchDB;
  dbPath: string;
  /** The cwd repo's project store, or "global" when no repo is detected. */
  defaultStore(): Promise<string>;
}

/**
 * One CLI subcommand. Namespaces are Subcommands too: their run()
 * dispatches a child registry, and the child listing for the
 * namespace's own help page rides in `children`.
 */
export interface Subcommand {
  name: string;
  /** One-line description shown in the parent's command listing. */
  summary: string;
  usage(): SubUsage;
  run(args: string[], ctx: CliContext): Promise<void>;
  /** Child subcommands; present on namespaces, absent on leaves. */
  children?: Subcommand[];
}
