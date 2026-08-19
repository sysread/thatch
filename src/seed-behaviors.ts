import { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";

/**
 * Seed default behaviors into the global store on first run. Idempotent: if the
 * behavior matcher already exists (cosine >= 0.85), skip. This ensures the
 * session-wrap-up check is present for every new install without requiring
 * the user to codify it manually.
 *
 * Called by both the opencode plugin (src/index.ts) and the MCP server
 * (src/mcp.ts) at startup, after DB and model initialization.
 */
export async function seedDefaultBehaviors(db: ThatchDB, model: EmbeddingModel): Promise<void> {
  const situation = "The user is wrapping up the session, ending the conversation, or signaling they are done working. Trigger phrases include: wrapping up, loose ends, clean up, merge, finish up, tidy up, ending the session, done for now, calling it a night, wrapping up for today, any loose ends, ready to merge, signing off.";
  const behavior = "Before responding, check for loose ends that would be lost when the session ends: run git status --porcelain to surface uncommitted changes, check for untracked files that are not gitignored, check for stale artifacts or scratch files. If you find anything, surface it to the user before they close the session. Do not fix anything yourself unless asked. This is a read-only check.";
  const rationale = "The user asks this at the end of every session. A codified rule that fires on wrap-up language ensures the check happens consistently without relying on the user remembering to ask.";

  try {
    const sitEmbed = await model.passageEmbed(situation);
    const existing = db.findNearestBehaviorMatcher("global", sitEmbed, 0.85);
    if (existing) return;

    const behaviorEmbed = await model.passageEmbed(behavior);
    const matcherId = db.createBehaviorMatcher("global", situation, sitEmbed, model.name);
    const behaviorId = db.createBehavior("global", behavior, rationale, behaviorEmbed, model.name);
    db.createBehaviorEdge(matcherId, behaviorId, 1.0);
    db.addBehaviorProvenance(behaviorId, "codify", rationale);
  } catch (err) {
    console.error(`[thatch] default behavior seed failed: ${err}`);
  }
}
