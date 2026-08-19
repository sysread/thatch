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
  {
    key: "research-new-project",
    situation:
      "The user is starting research on a new project, investigating " +
      "an unfamiliar codebase, or beginning a new ticket in an " +
      "area they have not worked in before. Trigger phrases " +
      "include: new project, unfamiliar codebase, new ticket, " +
      "never seen this before, where do I start, how does this " +
      "work, getting up to speed.",
    behavior:
      "Before diving into code, run a structured investigation: " +
      "check test coverage to understand what is tested and what " +
      "is not, disambiguate domain terms and naming conventions " +
      "(look for naming drift, renamed concepts, or inconsistent " +
      "terminology), look for evidence of partial migrations " +
      "(naming, conventions, libraries, or behavioral patterns " +
      "that changed partway through), and identify existing " +
      "patterns before proposing changes. Load the " +
      "thatch-code-archaeology skill for the full investigation " +
      "procedure.",
    rationale:
      "Starting research without checking for existing patterns, " +
      "partial migrations, or naming drift leads to proposing " +
      "changes that conflict with in-progress migrations or " +
      "established conventions. A codified rule ensures the " +
      "investigation happens before any code changes.",
  },
  {
    key: "day-turnover-coding",
    situation:
      "The user is continuing work from a previous day, picking " +
      "up where they left off, or resuming a coding session. " +
      "The session has turned over from one day to the next. " +
      "Trigger phrases include: continuing from yesterday, " +
      "picking up where I left off, resuming work, back at it, " +
      "let me pick this back up, where was I.",
    behavior:
      "Before starting new changes, check how far origin/main " +
      "has moved since the branch's merge-base: run " +
      "git fetch origin, then git log --oneline " +
      "$(git merge-base HEAD origin/main)..origin/main. If main " +
      "has moved significantly, surface this to the user and " +
      "suggest rebasing before starting new work. Also check " +
      "git status for uncommitted changes from the previous " +
      "session.",
    rationale:
      "When a branch sits overnight, origin/main may advance " +
      "significantly. Starting new work on a stale base leads " +
      "to larger merge conflicts later. A quick rebase check " +
      "at the start of a new day prevents this.",
  },
  {
    key: "day-turnover-pr",
    situation:
      "The user is continuing work on a branch with an open " +
      "PR or MR, picking up a coding session that has a " +
      "associated pull request. The session has turned over " +
      "from one day to the next. Trigger phrases include: " +
      "continuing the PR, picking up the branch, back on this " +
      "PR, let me check on this, resuming the PR.",
    behavior:
      "Before starting new changes, check for new upstream " +
      "review comments on the PR: run gh api repos/OWNER/REPO/" +
      "pulls/NUMBER/comments (or gh pr view NUMBER --comments) " +
      "and surface any comments the user has not yet seen. " +
      "Also check git status for uncommitted changes from " +
      "the previous session.",
    rationale:
      "Review comments arriving overnight can change the " +
      "direction of the work. Surfacing them before starting " +
      "new changes prevents wasted effort on a path the " +
      "reviewer has already redirected.",
  },
  {
    key: "day-turnover-review",
    situation:
      "The user is continuing a code review session, " +
      "picking up a review that was in progress. The session " +
      "has turned over from one day to the next. Trigger " +
      "phrases include: continuing the review, picking up " +
      "the review, back to reviewing, resuming the review, " +
      "where was I on this review.",
    behavior:
      "Before continuing the review, check for new upstream " +
      "comments on the PR and for responses to the user's " +
      "previous review comments: run gh api repos/OWNER/" +
      "REPO/pulls/NUMBER/comments (or gh pr view NUMBER " +
      "--comments) and surface anything new. Also check " +
      "whether the PR author has pushed new commits since " +
      "the last review round.",
    rationale:
      "Review threads can evolve overnight with author " +
      "responses and new comments from other reviewers. " +
      "Checking before continuing prevents re-raising " +
      "already-addressed findings or missing new context.",
  },
  {
    key: "snag-dead-end",
    situation:
      "The user has hit a snag, dead end, red herring, or " +
      "something unexpected during investigation or coding. " +
      "The agent went down a path that did not pan out. " +
      "Trigger phrases include: wait this does not make " +
      "sense, this is a dead end, that was a red herring, " +
      "this is not what I expected, that did not work, " +
      "I was wrong about, turns out that is not the issue.",
    behavior:
      "Before moving on, save a memory about the dead end " +
      "or red herring so future sessions do not repeat the " +
      "same investigation. Call thatch_memory_remember " +
      "with a label describing the dead end and content " +
      "explaining what looked promising, why it was wrong, " +
      "and what the actual cause or solution turned out " +
      "to be. This is a save-only action; do not attempt " +
      "to fix anything.",
    rationale:
      "Dead ends and red herrings are expensive to " +
      "re-discover. Saving them as memories gives future " +
      "sessions a shortcut past the same wrong path.",
  },
  {
    key: "debugging-git-archaeology",
    situation:
      "The user is debugging an issue, investigating a bug, " +
      "or trying to understand why something is broken. " +
      "The agent is about to propose a fix or explanation " +
      "without understanding the history of the code. " +
      "Trigger phrases include: debugging, why is this " +
      "broken, what changed, this used to work, why did " +
      "this stop working, what is going on here, something " +
      "is wrong but I do not know why.",
    behavior:
      "Before proposing a fix, do git archaeology to " +
      "understand the history of the code being debugged. " +
      "Run git log --oneline -- <path> for the affected " +
      "files, then git show <commit> for any commit that " +
      "changed the behavior in question. Look for: " +
      "removed code that left orphaned parts behind, " +
      "renamed functions whose old callers were not " +
      "updated, migrations that were completed partway, " +
      "or behavior that was intentionally removed. " +
      "An old behavior that was removed could have left " +
      "orphaned code causing the current bug. Load " +
      "the thatch-code-archaeology skill for the full " +
      "investigation procedure.",
    rationale:
      "Debugging without understanding history leads to " +
      "fixing symptoms instead of root causes. A removed " +
      "behavior that left orphaned code behind is a " +
      "common source of mysterious bugs, and only git " +
      "archaeology surfaces it.",
  },
  {
    key: "planning-git-archaeology",
    situation:
      "The user is planning a change, starting a new " +
      "ticket, or about to propose modifications to an " +
      "existing workflow or feature. The agent is " +
      "about to propose an approach without " +
      "understanding the history of the feature. " +
      "Trigger phrases include: planning a change, " +
      "how should we approach, what if we, proposing " +
      "a new approach, redesigning, refactoring this, " +
      "changing how this works.",
    behavior:
      "Before proposing an approach, do git archaeology " +
      "to understand why the code looks the way it " +
      "does. Run git log --oneline -- <path> for " +
      "the files you plan to change, then read the " +
      "commits that established the current design. " +
      "Look for: design decisions that look wrong " +
      "but were correct at the time, migrations " +
      "that were completed partway, or constraints " +
      "that no longer apply. Understanding history " +
      "prevents proposing changes that conflict with " +
      "the original design intent. Load the " +
      "thatch-code-archaeology skill for the full " +
      "investigation procedure.",
    rationale:
      "Planning without history leads to proposing " +
      "changes that fight the original design or " +
      "reintroduce constraints that were deliberately " +
      "removed. Git archaeology is the only way to " +
      "distinguish a design decision from a wart.",
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
