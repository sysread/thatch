import { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";

interface DefaultBehavior {
  situation: string;
  behavior: string;
  rationale: string;
}

/**
 * Default behaviors seeded into the global store on first run. Idempotent: if a
 * behavior matcher already exists (cosine >= 0.85), skip. This ensures
 * these rules are present for every new install without requiring the user
 * to codify them manually.
 *
 * Called by both the opencode plugin (src/index.ts) and the MCP server
 * (src/mcp.ts) at startup, after DB and model initialization.
 */
const DEFAULT_BEHAVIORS: DefaultBehavior[] = [
  {
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

export async function seedDefaultBehaviors(db: ThatchDB, model: EmbeddingModel): Promise<void> {
  for (const { situation, behavior, rationale } of DEFAULT_BEHAVIORS) {
    try {
      const sitEmbed = await model.passageEmbed(situation);
      const existing = db.findNearestBehaviorMatcher("global", sitEmbed, 0.85);
      if (existing) continue;

      const behaviorEmbed = await model.passageEmbed(behavior);
      const matcherId = db.createBehaviorMatcher("global", situation, sitEmbed, model.name);
      const behaviorId = db.createBehavior("global", behavior, rationale, behaviorEmbed, model.name);
      db.createBehaviorEdge(matcherId, behaviorId, 1.0);
      db.addBehaviorProvenance(behaviorId, "codify", rationale);
    } catch (err) {
      console.error(`[thatch] default behavior seed failed: ${err}`);
    }
  }
}
