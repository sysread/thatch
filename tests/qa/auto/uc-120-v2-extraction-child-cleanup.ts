import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { makeV2Harness } from "../../mocks/v2-harness";
import { Database } from "bun:sqlite";

/**
 * UC-120: opencode v2 extraction-child cleanup (session.remove).
 *
 * Automatable: yes — drives the real v2 adapter with the shared mock
 * promise context (tests/mocks/v2-harness.ts): the parent's idle spawns the
 * extraction child, the child's idle finishes it, and the cleanup calls
 * session.remove on the promise domain (upstream #52387). The older-SDK
 * floor (no remove member) must degrade silently - the child stays (the
 * documented picker-clutter gap) and nothing crashes.
 */

const useCase: UseCase = {
  name: "UC-120-v2-extraction-child-cleanup",
  preconditions: [
    "- The opencode v2 adapter (src/opencode/v2.ts) loadable with a mock promise context",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Load the v2 adapter on a current-host context (session.remove present). Buffer a real tool interaction for a parent session, then fire its idle: the adapter creates and prompts the extraction child.",
    "2. Fire the child's idle. Verify the cleanup called session.remove with the child's id (the picker stays clean, `-c` cannot land in the child).",
    "3. Reload the adapter on an older-SDK context (no session.remove member) and run the same flow. Verify it degrades silently: no crash, no remove call, the child cleanup otherwise completes.",
  ].join("\n"),
  expected: [
    "- On a current host, the extraction child's idle triggers session.remove({sessionID: childID}) - extraction children no longer accumulate in the session picker.",
    "- On an older SDK floor, the deletion degrades to a silent no-op (best-effort by contract) and the child-completion bookkeeping still runs.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const v2wait = async (desc: string, fn: () => unknown): Promise<boolean> => {
      const end = Date.now() + 5000;
      while (!fn()) {
        if (Date.now() > end) {
          console.log(`  FAIL: timed out waiting for: ${desc}`);
          return false;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return true;
    };
    const runLeg = async (options: { remove?: boolean }): Promise<boolean> => {
      const harness = makeV2Harness(ctx.dir, { ...options, childID: "qa-120-child" });
      let dispose: (() => Promise<void>) | undefined;
      const prevXdg = process.env.XDG_CONFIG_HOME;
      const prevDb = process.env.THATCH_DB_PATH;
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      try {
        dispose = (await setupV2(harness.context as any)) as () => Promise<void>;
        // Buffer a real-work interaction so the parent's idle triggers the
        // direct-extraction child.
        await harness.toolAfter({
          tool: "bash",
          sessionID: "ses-qa-120-parent",
          input: { command: "git log" },
          status: "completed",
          result: { content: "abc123 real work" },
        });
        await harness.queue({
          type: "session.execution.succeeded",
          location: { directory: ctx.dir },
          data: { sessionID: "ses-qa-120-parent" },
        });
        if (!(await v2wait("extraction child created", () => harness.calls.create.length === 1))) return false;

        // The child's idle finishes the extraction child: metrics toast
        // (none - it wrote no memories), claim-scoped buffer completion,
        // map cleanup, and the session deletion under test.
        await harness.queue({ type: "session.execution.succeeded", data: { sessionID: "qa-120-child" } });
        if (options.remove) {
          if (!(await v2wait("child removed", () => harness.calls.remove.length === 1))) return false;
          if (harness.calls.remove[0].sessionID !== "qa-120-child") {
            console.log(`  FAIL: session.remove should carry the child's id, got ${JSON.stringify(harness.calls.remove)}`);
            return false;
          }
        } else {
          // The floor degrades silently: the child cleanup still runs to
          // completion (the child journal row is the observable -
          // journalChild deletes it after the map cleanup and BEFORE the
          // deletion under test), the deletion just never happens.
          const childJournaled = () => {
            const db = new Database(ctx.env.THATCH_DB_PATH, { readonly: true });
            try {
              return db.query("SELECT 1 FROM runtime_state WHERE kind = 'child' AND session_id = ?").get("qa-120-child") != null;
            } finally {
              db.close();
            }
          };
          if (!(await v2wait("child cleanup completed", () => !childJournaled()))) return false;
          if (harness.calls.remove.length !== 0) {
            console.log(`  FAIL: the floor context has no remove member, got ${JSON.stringify(harness.calls.remove)}`);
            return false;
          }
        }
        return true;
      } finally {
        process.env.XDG_CONFIG_HOME = prevXdg;
        process.env.THATCH_DB_PATH = prevDb;
        await dispose?.();
      }
    };

    if (!(await runLeg({ remove: true }))) return "FAIL";
    if (!(await runLeg({ remove: false }))) return "FAIL";
    return "PASS";
  },
};

registerUseCase(useCase);
