import { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";
import pkg from "../package.json" with { type: "json" };

interface DefaultBehavior {
  /** Unique key so we can find and replace outdated versions across releases. */
  key: string;
  situation: string;
  behavior: string;
  rationale: string;
}

/**
 * Default behaviors seeded into the global store on first run, and updated
 * when their content changes across releases. Each behavior carries a
 * `key` that identifies it across versions. On startup, the seed checks
 * whether the existing behavior's rationale contains the same version stamp
 * as the current package version. If the stamps differ (the behavior was
 * seeded by an older release), the old behavior is deleted and the new one
 * is created. This mirrors how cleanupStaleSkills handles skill renames.
 *
 * Called by both the opencode plugin (src/index.ts) and the MCP server
 * (src/mcp.ts) at startup, after DB and model initialization.
 */
const DEFAULT_BEHAVIORS: DefaultBehavior[] = [
  {
    key: "session-wrap-up",
    situation:
      "The user is wrapping up the session, ending the conversation, or " +
      "signaling they are done working. Trigger phrases include: " +
      "wrapping up, loose ends, clean up, merge, finish up, tidy up, " +
      "ending the session, done for now, calling it a night, " +
      "wrapping up for today, any loose ends, ready to merge, signing off.",
    behavior:
      "Before responding, check for loose ends that would be lost " +
      "when the session ends: run git status --porcelain to surface " +
      "uncommitted changes, check for untracked files that are not " +
      "gitignored, check for stale artifacts or scratch files. If you " +
      "find anything, surface it to the user before they close the " +
      "session. Do not fix anything yourself unless asked. This is a " +
      "read-only check.",
    rationale:
      "The user asks this at the end of every session. A codified rule " +
      "that fires on wrap-up language ensures the check happens " +
      "consistently without relying on the user remembering to ask.",
  },
  {
    key: "work-finalization",
    situation:
      "The user is committing changes, merging a branch, closing a " +
      "ticket, or marking a PR ready for review. The user is " +
      "finalizing work: committing, merging, closing out, marking " +
      "done, shipping, finishing a task, completing a milestone, " +
      "ready to merge, pushing, tagging a release.",
    behavior:
      "Before responding, check whether anything needs to be saved " +
      "before the work is finalized: run git status --porcelain " +
      "to surface uncommitted or untracked files, check whether " +
      "branch-scoped memories should be consolidated into an archived " +
      "record, check whether there are follow-up tickets or TODOs " +
      "that should be filed before the branch merges. If you find " +
      "anything, surface it to the user. Do not fix anything yourself " +
      "unless asked. This is a read-only check.",
    rationale:
      "Finalizing work (commits, merges, ticket closures) is a " +
      "common point where durable context is lost if not saved first. " +
      "A codified rule that fires on finalization language ensures " +
      "the check happens consistently.",
  },
];

const SEED_VERSION_TAG = "seed-version:";

/**
 * Extract the version stamp from a behavior's rationale text.
 * Returns null if no stamp is found (behavior was not seeded by this
 * mechanism, or was manually codified).
 */
function extractSeedVersion(rationale: string | null): string | null {
  if (!rationale) return null;
  const match = rationale.match(/seed-version:([^\s]+)/);
  return match ? match[1] : null;
}

export async function seedDefaultBehaviors(db: ThatchDB, model: EmbeddingModel): Promise<void> {
  const currentVersion = pkg.version;

  for (const { key: _key, situation, behavior, rationale } of DEFAULT_BEHAVIORS) {
    try {
      const sitEmbed = await model.passageEmbed(situation);
      const behaviorEmbed = await model.passageEmbed(behavior);
      const stampedRationale = `${rationale} ${SEED_VERSION_TAG}${currentVersion}`;

      // Check if a behavior already exists for this situation.
      const existingMatcher = db.findNearestBehaviorMatcher("global", sitEmbed, 0.85);

      if (existingMatcher) {
        // Find the behavior linked to this matcher by key to check its version.
        const existingBehaviors = db.listBehaviors("global");
        const linked = existingBehaviors.find((b) =>
          b.matchers.some((m) => m.id === existingMatcher.id),
        );

        if (linked) {
          const storedVersion = extractSeedVersion(linked.rationale);
          if (storedVersion === currentVersion) continue;

          // Version mismatch (or manually codified with no stamp):
          // delete the old behavior and re-seed with the current version.
          // The matcher and edge cascade-delete with the behavior.
          db.deleteBehavior(linked.id);
        }
      }

      // Create (or re-create) the behavior with the current version stamp.
      // Reuse the existing matcher if it was found (avoid creating a
      // duplicate matcher for the same situation).
      const matcherId = existingMatcher?.id
        ?? db.createBehaviorMatcher("global", situation, sitEmbed, model.name);
      const behaviorId = db.createBehavior("global", behavior, stampedRationale, behaviorEmbed, model.name);
      db.createBehaviorEdge(matcherId, behaviorId, 1.0);
      db.addBehaviorProvenance(behaviorId, "codify", stampedRationale);
    } catch (err) {
      console.error(`[thatch] default behavior seed failed: ${err}`);
    }
  }
}
