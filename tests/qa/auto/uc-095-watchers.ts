import { registerUseCase, type UseCase, type QaContext } from "../runner";
import {
  WatcherRegistry,
  diffPrState,
  WATCHER_EVENT_TYPES,
  type PrState,
  type WatcherEvent,
} from "../../../src/watchers";
import { TOOL_DEFS } from "../../../src/tool-defs";

/**
 * UC-095: Watchers.
 *
 * Automatable: yes - the registry is in-memory with injected dependencies,
 * so the full lifecycle (register with baseline, poll, detect, deliver,
 * cancel, session cleanup) runs against a mocked gh runner with no network
 * access. The live end-to-end path (real gh polling + promptAsync delivery
 * into a running session) is covered by the user doc workflow.
 */

const useCase: UseCase = {
  name: "UC-095-watchers",
  preconditions: [
    "- No prerequisites beyond the source tree; the mocked gh runner never touches the network.",
  ].join("\n"),
  steps: [
    "1. Verify the watch tools are opencode-only in TOOL_DEFS.",
    "2. Register a watcher with a mocked gh runner and confirm the baseline is captured.",
    "3. Change the mocked PR state and poll; confirm events are detected, filtered, and delivered.",
    "4. Confirm undeliverable events stay pending and deliver when the gate opens.",
    "5. Cancel the watcher and confirm session cleanup leaves nothing behind.",
  ].join("\n"),
  expected: [
    "- watch_create, watch_list, and watch_cancel are marked opencodeOnly.",
    "- create() captures baseline PR state (head SHA, comment ids) and reports gh failures as errors.",
    "- poll() diffs against the last-seen state, filters to watched event types, and delivers via the injected callback.",
    "- Events for sessions that cannot accept a prompt stay pending; deliverPending() flushes them when the gate opens.",
    "- cancel()/cancelSession() remove the watcher and its pending events.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    // Step 1: watch tools are opencode-only.
    const watchTools = TOOL_DEFS.filter((t) => t.name.startsWith("watch_"));
    if (watchTools.length !== 3) {
      console.log(`  FAIL: expected 3 watch tools, got ${watchTools.length}`);
      return "FAIL";
    }
    if (!watchTools.every((t) => t.opencodeOnly)) {
      console.log("  FAIL: watch tools must be opencodeOnly (no poller or proactive-prompt channel on MCP hosts)");
      return "FAIL";
    }

    // The event vocabulary is stable and documented.
    if (WATCHER_EVENT_TYPES.length !== 11) {
      console.log(`  FAIL: expected 11 event types, got ${WATCHER_EVENT_TYPES.length}`);
      return "FAIL";
    }

    // Mocked PR state that changes on demand.
    const state: PrState = {
      headSha: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      state: "open",
      merged: false,
      title: "T",
      bodySha: "body",
      lastIssueCommentId: 0,
      lastReviewCommentId: 0,
      issueComments: [],
      reviewComments: [],
      resolvedThreads: [],
      checkRuns: {},
    };
    const gh = async (apiArgs: string[]) => {
      const joined = apiArgs.join(" ");
      if (/\/issues\/\d+\/comments/.test(joined)) {
        return state.issueComments.length > 0
          ? state.issueComments.map((c) => ({ id: c.id, user: { login: c.author }, html_url: c.url }))
          : [];
      }
      if (/\/pulls\/\d+\/comments/.test(joined)) return [];
      if (/\/check-runs/.test(joined)) return { check_runs: [] };
      if (/^graphql/.test(joined)) {
        return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
      }
      if (/\/pulls\/\d+$/.test(joined)) {
        return { head: { sha: state.headSha }, state: state.state, merged: state.merged, title: state.title, body: state.bodySha };
      }
      throw new Error(`no route: ${joined}`);
    };

    let canDeliver = false;
    const delivered: Array<{ sessionID: string; events: WatcherEvent[] }> = [];
    const registry = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        delivered.push({ sessionID, events });
      },
      canDeliver: () => canDeliver,
      ghRunner: gh,
      pollIntervalMs: 60_000,
    });

    // Step 2: baseline capture.
    const created = await registry.createPr("ses_uc95", "acme/widgets", 7, ["pr_comment", "pr_commit"]);
    if (!created.ok) {
      console.log(`  FAIL: create failed: ${created.error}`);
      return "FAIL";
    }
    if (created.watcher.state.headSha !== state.headSha) {
      console.log("  FAIL: baseline state was not captured");
      return "FAIL";
    }
    await registry.poll();
    if (registry.pendingCount("ses_uc95") !== 0 || delivered.length !== 0) {
      console.log("  FAIL: first poll after baseline must not notify");
      return "FAIL";
    }

    // Step 3: change the PR, poll, gate is closed so events stay pending.
    state.headSha = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    state.issueComments = [{ id: 1, author: "alice", url: "https://github.com/acme/widgets/pull/7#issuecomment-1", isReply: false }];
    await registry.poll();
    if (registry.pendingCount("ses_uc95") === 0) {
      console.log("  FAIL: changed PR should have queued events");
      return "FAIL";
    }
    if (delivered.length > 0) {
      console.log("  FAIL: events were delivered while the session could not accept a prompt");
      return "FAIL";
    }

    // Step 4: open the gate and flush.
    canDeliver = true;
    await registry.deliverPending();
    if (delivered.length < 1 || registry.pendingCount("ses_uc95") !== 0) {
      console.log("  FAIL: pending events were not delivered once the gate opened");
      return "FAIL";
    }
    const types = delivered[0].events.map((e) => e.type).sort();
    if (!(types.includes("pr_commit") && types.includes("pr_comment"))) {
      console.log(`  FAIL: unexpected delivered event types: ${types.join(",")}`);
      return "FAIL";
    }

    // Sanity: the pure diff is the same machinery the poller uses.
    const diffEvents = diffPrState(created.watcher.state, { ...created.watcher.state, headSha: "cccc3333" }, "acme/widgets#7", "https://github.com/acme/widgets/pull/7");
    if (diffEvents.length !== 1 || diffEvents[0].type !== "pr_commit") {
      console.log("  FAIL: diffPrState did not detect the head change");
      return "FAIL";
    }

    // Step 5: cancel and confirm nothing is left.
    if (!registry.cancel("ses_uc95", created.watcher.id)) {
      console.log("  FAIL: cancel returned false for the session's own watcher");
      return "FAIL";
    }
    registry.cancelSession("ses_uc95");
    if (registry.listForSession("ses_uc95").length !== 0 || registry.pendingCount("ses_uc95") !== 0) {
      console.log("  FAIL: session cleanup left state behind");
      return "FAIL";
    }

    registry.dispose();
    return "PASS";
  },
};

registerUseCase(useCase);
