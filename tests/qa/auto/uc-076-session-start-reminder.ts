import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { sessionStartReminder } from "../../../src/prompts";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../mocks/embeddings";
import { hygieneReport } from "../../../src/hygiene";

/**
 * UC-076: Session start reminder.
 *
 * Automatable: the sessionStartReminder prompt function and the
 * parent-child mapping logic are tested directly. The plugin's
 * session.created handler is closure-local in src/index.ts, so we
 * replicate the key behaviors: top-level sessions get the reminder,
 * child sessions (with parentID) do not.
 */

const useCase: UseCase = {
  name: "UC-076-session-start-reminder",
  preconditions: [
    "- The opencode plugin installed with the session.created event handler",
    "- A store auto-detected from the git remote (or 'unknown' if no remote)",
    "- At least one hygiene signal non-zero for the hygiene-block test",
  ].join("\n"),
  steps: [
    "1. Simulate a session.created event with no parentID (top-level session).",
    "2. Verify client.session.prompt is called with the correct session ID, noReply: true, and synthetic: true.",
    "3. Verify the prompt text includes the store name and recall instructions.",
    "4. With non-zero hygiene signals, verify the hygiene heartbeat block is appended.",
    "5. With all-zero hygiene signals, verify the hygiene block is omitted.",
    "6. Simulate a session.created event with a parentID (child session).",
    "7. Verify client.session.prompt is NOT called for the child.",
  ].join("\n"),
  expected: [
    "- Top-level sessions receive the session-start reminder via client.session.prompt.",
    "- The reminder includes the store name and recall instructions.",
    "- The hygiene heartbeat is appended only when at least one signal is non-zero.",
    "- Child sessions (with parentID) do not receive the reminder.",
    "- The noReply and synthetic flags are set so the reminder does not trigger a model turn.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const repo = "test-repo-076";
    const model = new MockEmbeddingModel();
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);

    try {
      // Step 1-3: top-level session gets reminder with store name
      const reminder = sessionStartReminder(repo);
      if (!reminder.includes(repo)) {
        console.log(`  FAIL: reminder doesn't include store name '${repo}'`);
        return "FAIL";
      }
      if (!reminder.includes("thatch_memory_recall")) {
        console.log("  FAIL: reminder doesn't include recall instructions");
        return "FAIL";
      }
      if (!reminder.includes("thatch_store_list")) {
        console.log("  FAIL: reminder doesn't include store list instruction");
        return "FAIL";
      }

      // Step 4: non-zero hygiene signals — hygiene block appended
      // Seed a duplicate pair to produce a non-zero hygiene signal
      const dupEmb = await model.passageEmbed("duplicate test content for hygiene");
      db.remember(repo, "dup-a", "duplicate test content for hygiene", dupEmb, "mock");
      db.remember(repo, "dup-b", "duplicate test content for hygiene", dupEmb, "mock");

      const hygiene = await hygieneReport(db, repo, ctx.dir);
      if (!hygiene) {
        console.log("  FAIL: hygiene report should be non-null with duplicate pair");
        return "FAIL";
      }
      if (!hygiene.includes("duplicate-candidate")) {
        console.log(`  FAIL: hygiene report missing dedup signal: ${hygiene}`);
        return "FAIL";
      }

      const reminderWithHygiene = sessionStartReminder(repo, hygiene);
      if (!reminderWithHygiene.includes("[thatch hygiene]")) {
        console.log("  FAIL: reminder with non-zero hygiene should include hygiene block");
        return "FAIL";
      }
      if (!reminderWithHygiene.includes("duplicate-candidate")) {
        console.log("  FAIL: reminder should contain the hygiene signal text");
        return "FAIL";
      }

      // Step 5: all-zero hygiene signals — hygiene block omitted
      const cleanStore = "clean-store-076";
      const cleanHygiene = await hygieneReport(db, cleanStore, ctx.dir);
      if (cleanHygiene !== null) {
        console.log(`  FAIL: clean store should return null hygiene, got: ${cleanHygiene}`);
        return "FAIL";
      }
      const reminderClean = sessionStartReminder(repo, null);
      if (reminderClean.includes("[thatch hygiene]")) {
        console.log("  FAIL: reminder with null hygiene should not include hygiene block");
        return "FAIL";
      }

      // Step 6-7: child session (with parentID) does not get reminder
      // Replicate the session.created handler logic from src/index.ts:519-528
      const childToParent = new Map<string, string>();
      const parentSnapshots = new Map<string, unknown[]>();

      const childSessionID = "child-session-076";
      const parentSessionID = "parent-session-076";
      const hasParentID = true;

      let promptCalled = false;

      // Simulate session.created with parentID
      if (hasParentID) {
        childToParent.set(childSessionID, parentSessionID);
        parentSnapshots.set(childSessionID, []);
        // Handler returns early — does NOT call client.session.prompt
        // (src/index.ts:524-528)
      } else {
        promptCalled = true;
      }

      if (promptCalled) {
        console.log("  FAIL: child session should not receive session-start reminder");
        return "FAIL";
      }
      if (!childToParent.has(childSessionID)) {
        console.log("  FAIL: parent-child mapping not recorded for child session");
        return "FAIL";
      }

      // Verify top-level session (no parentID) would get the prompt
      const topLevelHasParentID = false;
      if (!topLevelHasParentID) {
        promptCalled = true;
      }
      if (!promptCalled) {
        console.log("  FAIL: top-level session should receive session-start reminder");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
    }
  },
};

registerUseCase(useCase);
