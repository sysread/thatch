import type { ThatchDB } from "./db";
import { listBranches, type RepoPathCache } from "./git";

// A memory nothing recalls for two months should be consolidated or
// forgotten: the recall nudge renders at most 5 memories, so a stale
// corpus crowds fresh matches out of that list.
const STALE_DAYS = 60;

// How many pending prediction pairs the hygiene line names by id before
// falling back to a bare count. Past this the ids would crowd out the
// line; prediction_find_duplicates carries the full list either way.
const PREDICTION_PAIR_IDS_CAP = 5;

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
  // Every project session scans [repo, "global"] for nudges, so the
  // global store's debt is reported here too; the project-store check
  // alone would never see it. When repo detection itself fell back to
  // "global", the two are the same store; report it once. allSettled
  // keeps one store's failure from dropping the other's report (the
  // hygiene line is best-effort, like the tiers).
  const stores = repo === "global" ? ["global"] : [repo, "global"];
  const reports = await Promise.allSettled(
    stores.map((store) => storeReport(db, store, worktree, repoCache)),
  );
  // Silence reads as a clean scan, so the code must log a failed store
  // report: otherwise the failing store's debt goes unreported and the
  // remaining line looks healthy (the tiers' never-swallowed-failure
  // rule, applied per store).
  reports.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[thatch] hygiene report for ${stores[i]} failed: ${r.reason}`);
    }
  });
  return reports
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value)
    .join("\n") || null;
}

async function storeReport(
  db: ThatchDB,
  store: string,
  worktree: string,
  repoCache: RepoPathCache | undefined,
): Promise<string | null> {
  const parts: string[] = [];

  const dupes = db.findDuplicates(store).length;
  if (dupes > 0) {
    parts.push(`${dupes} duplicate-candidate pair${dupes === 1 ? "" : "s"} pending review`);
  }

  const predDupes = db.findPredictionDuplicates(store);
  if (predDupes.length > 0) {
    const n = predDupes.length;
    let line = `${n} prediction duplicate pair${n === 1 ? "" : "s"} pending review`;
    // Naming the pair ids inline lets the verdict loop close without a
    // listing call (prediction_mark_checked takes these ids directly).
    if (n <= PREDICTION_PAIR_IDS_CAP) {
      line += `: ${predDupes.map((d) => `(${d.predictionA}, ${d.predictionB})`).join(", ")}`;
    }
    parts.push(line);
  }

  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  const stale = db.staleEntryCount(store, cutoff);
  if (stale > 0) {
    parts.push(`${stale} memor${stale === 1 ? "y" : "ies"} neither updated nor recalled in ${STALE_DAYS}+ days`);
  }

  // Branch-scoped orphans are a per-repo concept - the global store has no
  // branch scoping to go stale against a checkout.
  if (store !== "global") {
    // listBranches returns [] outside a git repo, which would make every
    // branch-scoped memory look orphaned - skip the check in that case.
    const scoped = db.branchesInStore(store);
    if (scoped.length > 0) {
      const live = await listBranches(worktree, repoCache);
      if (live.length > 0) {
        const orphaned = scoped.filter((b) => !live.includes(b));
        const n = db.entryCountForBranches(store, orphaned);
        if (n > 0) {
          parts.push(`${n} memor${n === 1 ? "y" : "ies"} scoped to deleted branches (${orphaned.join(", ")})`);
        }
      }
    }
  }

  return parts.length > 0 ? `Store "${store}": ${parts.join("; ")}.` : null;
}
