import type { ThatchDB } from "./db";
import { listBranches, type RepoPathCache } from "./git";

const STALE_DAYS = 90;

/**
 * Counts that give the agent standing cause to tend the store. Only non-zero
 * signals are reported; a healthy store stays silent. Shared by the opencode
 * plugin's session-start hook and the CLI's `thatch reminder` subcommand.
 * The optional cache lets listBranches fall back to the cached main checkout
 * when the worktree was deleted (refs are shared, so the branch list is
 * identical from either).
 */
export async function hygieneReport(
  db: ThatchDB,
  repo: string,
  worktree: string,
  repoCache?: RepoPathCache,
): Promise<string | null> {
  const parts: string[] = [];

  const dupes = db.findDuplicates(repo).length;
  if (dupes > 0) {
    parts.push(`${dupes} duplicate-candidate pair${dupes === 1 ? "" : "s"} pending review`);
  }

  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  const stale = db.staleEntryCount(repo, cutoff);
  if (stale > 0) {
    parts.push(`${stale} memor${stale === 1 ? "y" : "ies"} neither updated nor recalled in ${STALE_DAYS}+ days`);
  }

  // listBranches returns [] outside a git repo, which would make every
  // branch-scoped memory look orphaned - skip the check in that case.
  const scoped = db.branchesInStore(repo);
  if (scoped.length > 0) {
    const live = await listBranches(worktree, repoCache);
    if (live.length > 0) {
      const orphaned = scoped.filter((b) => !live.includes(b));
      const n = db.entryCountForBranches(repo, orphaned);
      if (n > 0) {
        parts.push(`${n} memor${n === 1 ? "y" : "ies"} scoped to deleted branches (${orphaned.join(", ")})`);
      }
    }
  }

  return parts.length > 0 ? `Store "${repo}": ${parts.join("; ")}.` : null;
}
