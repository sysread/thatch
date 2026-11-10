/**
 * CLI process context: the env-driven paths and store resolution shared
 * by the dispatcher and the subcommands.
 */
import { detectRepo } from "../git";
import { repoPathCache } from "../db";
import type { ThatchDB } from "../db";

/** Resolve the project directory from host-specific env vars or cwd.
 *  THATCH_PROJECT_DIR (pinned by project-local MCP configs) leads the
 *  chain, mirroring the server's resolution in src/mcp.ts. */
export function projectDir(): string {
  return process.env.THATCH_PROJECT_DIR ?? process.env.CURSOR_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Resolves the default store: the cwd repo's project store, or "global"
 * when no repo is detected. The cache recovers identity when the project
 * directory is gone (deleted worktree) - the same unknown-to-global
 * mapping the tool layer applies, so the CLI never lands on a literal
 * "unknown" store.
 */
export async function defaultStore(db: ThatchDB): Promise<string> {
  try {
    const repo = await detectRepo(undefined, repoPathCache(db));
    return repo === "unknown" ? "global" : repo;
  } catch {
    return "global";
  }
}
