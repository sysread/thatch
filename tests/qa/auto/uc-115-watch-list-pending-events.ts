import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../tests/mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";
import { WatcherRegistry, type WatcherEvent } from "../../../src/watchers";

/**
 * UC-115: watch_list surfaces detected events queued behind the idle gate.
 *
 * Automatable: yes - the watch tools execute with an injected registry and
 * a temp-dir SQLite database, against a mocked gh runner, no network. A
 * busy session's events queue in the registry's pending map and deliver
 * only on idle; without a visible count that state was indistinguishable
 * from a dead watcher (observed 2026-10-01 as a ~7-minute "watcher
 * failure" that was really a session that never went idle).
 */

const useCase: UseCase = {
  name: "UC-115-watch-list-pending-events",
  preconditions: [
    "- No prerequisites beyond the source tree; the mocked gh runner never touches the network.",
  ].join("\n"),
  steps: [
    "1. Register a PR watch through the watch_create tool and force a head change; poll with the delivery gate closed so the event queues.",
    "2. Run watch_list and confirm it reports the queued event with a per-target breakdown.",
    "3. Open the delivery gate, flush pending, and run watch_list again; confirm the pending line is gone.",
  ].join("\n"),
  expected: [
    "- watch_list shows an 'N events detected, waiting for idle to deliver' line while events queue, naming each target and its count.",
    "- After the gate opens and delivery succeeds, the pending line disappears.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const host = { sessionID: "ses_uc115", agent: "build" };
    const headSha = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const gh = async (apiArgs: string[]) => {
      const joined = apiArgs.join(" ");
      if (/\/issues\/\d+\/comments/.test(joined)) return [];
      if (/\/pulls\/\d+\/comments/.test(joined)) return [];
      if (/\/check-runs/.test(joined)) return { check_runs: [] };
      if (/^graphql/.test(joined)) {
        return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
      }
      if (/\/pulls\/\d+$/.test(joined)) {
        return { head: { sha: headSha }, state: "open", merged: false, title: "T", body: "b" };
      }
      throw new Error(`no route: ${joined}`);
    };

    let canDeliver = false;
    const delivered: WatcherEvent[] = [];
    const registry = new WatcherRegistry({
      deliver: async (_sessionID, events) => {
        delivered.push(...events);
      },
      canDeliver: () => canDeliver,
      ghRunner: gh,
      pollIntervalMs: 60_000,
    });

    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc115-"));
    const db = new ThatchDB(join(dbDir, "uc115.db"));
    try {
      const toolCtx: CoreContext = {
        db,
        model: new MockEmbeddingModel(),
        defaultStore: "test-owner/test-repo",
        watchers: registry,
      };

      // Step 1: baseline via the real tool, then a head change while the
      // session is "busy".
      const created = await findTool("watch_create").execute({ pr: 7, events: ["pr_commit"] }, toolCtx, host);
      if (!created.includes("[watching]")) {
        console.log(`  FAIL: watch_create did not register: ${created}`);
        return "FAIL";
      }
      const watcher = registry.listForSession(host.sessionID)[0];
      if (!watcher || watcher.source !== "pr") {
        console.log("  FAIL: no pr watcher registered");
        return "FAIL";
      }
      watcher.state.headSha = "old";
      await registry.poll();
      if (registry.pendingCount(host.sessionID) !== 1) {
        console.log("  FAIL: the detected event did not queue while the gate was closed");
        return "FAIL";
      }

      // Step 2: watch_list names the queued event.
      const listed = await findTool("watch_list").execute({}, toolCtx, host);
      if (!listed.includes("1 event detected, waiting for idle to deliver")) {
        console.log(`  FAIL: watch_list did not surface the queued event: ${listed}`);
        return "FAIL";
      }
      if (!listed.includes("test-owner/test-repo#7 x1")) {
        console.log(`  FAIL: pending line should break down by target, got: ${listed}`);
        return "FAIL";
      }

      // Step 3: the gate opens, delivery flushes, the count clears.
      canDeliver = true;
      await registry.deliverPending();
      if (delivered.length !== 1 || registry.pendingCount(host.sessionID) !== 0) {
        console.log("  FAIL: queued event was not delivered when the gate opened");
        return "FAIL";
      }
      const cleared = await findTool("watch_list").execute({}, toolCtx, host);
      if (cleared.includes("waiting for idle")) {
        console.log(`  FAIL: pending line should be gone after delivery: ${cleared}`);
        return "FAIL";
      }
    } finally {
      registry.dispose();
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }

    return "PASS";
  },
};

registerUseCase(useCase);
