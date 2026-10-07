import { registerUseCase, type UseCase, type QaContext } from "../runner";
import {
  WatcherRegistry,
  type PrState,
  type Watcher,
  type WatcherEvent,
} from "../../../src/watchers";

/**
 * UC-114: Watcher TTL expiry is reported, and journal rehydration never
 * replays delivered events.
 *
 * Automatable: yes - the registry is in-memory with injected dependencies,
 * so both behaviors run against a mocked gh runner with no network access.
 *
 * Background (2026-10-07 bug report, PR #7561 watch): the poller advanced
 * watcher.state in memory while the journal was only rewritten on membership
 * change, so a registry rebuild (v2 plugin reload, the watch tools' journal
 * reconcile) rehydrated a stale baseline and re-delivered the same completed
 * events on every rebuild. Expiry was also silent: a watch that hit its TTL
 * just stopped notifying, indistinguishable from a broken poller.
 */

const useCase: UseCase = {
  name: "UC-114-watcher-expiry-replay",
  preconditions: [
    "- No prerequisites beyond the source tree; the mocked gh runner never touches the network.",
  ].join("\n"),
  steps: [
    "1. Register a watcher with a journal hook; change the mocked PR state and poll; confirm the journal holds the advanced state.",
    "2. Rebuild the registry from the journaled row (the reload/reconcile path) and poll again; confirm no events re-fire.",
    "3. Age a watcher past its TTL and poll with the delivery gate closed; confirm a watch_expired event queues.",
    "4. Open the gate and flush; confirm the expiry names the target and the watch lifetime, and that it is reported exactly once.",
  ].join("\n"),
  expected: [
    "- poll() journals state changes, not just membership changes, so rehydration resumes from the current baseline.",
    "- A rebuilt registry that hydrates the journal does not re-deliver already-delivered events.",
    "- An expired watcher queues a watch_expired event naming the target and lifetime in minutes, then disappears.",
    "- The expiry notification is delivered once; later polls stay quiet.",
  ].join("\n"),

  async run(_ctx: QaContext) {
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

    let canDeliver = true;
    const delivered: Array<{ sessionID: string; events: WatcherEvent[] }> = [];
    // A function, not a captured number: TS narrows delivered.length to a
    // literal after the first assertion, which breaks the later count check.
    const deliveryCount = () => delivered.length;
    const journaled: Watcher[][] = [];
    const build = () =>
      new WatcherRegistry({
        deliver: async (sessionID, events) => {
          delivered.push({ sessionID, events });
        },
        canDeliver: () => canDeliver,
        ghRunner: gh,
        journal: (_sessionID, watchers) => journaled.push([...watchers]),
        pollIntervalMs: 60_000,
      });

    // Step 1: the poll journals the advanced state.
    const registry = build();
    const created = await registry.createPr("ses_uc114", "acme/widgets", 7, ["pr_commit"]);
    if (!created.ok) {
      console.log(`  FAIL: create failed: ${created.error}`);
      return "FAIL";
    }
    state.headSha = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    await registry.poll();
    const deliveredTypes = delivered.flatMap((d) => d.events.map((e) => e.type));
    if (!(deliveredTypes.includes("pr_commit"))) {
      console.log(`  FAIL: expected the head change to deliver, got ${deliveredTypes.join(",") || "nothing"}`);
      return "FAIL";
    }
    const journaledWatcher = journaled.at(-1)?.[0];
    if (!journaledWatcher || journaledWatcher.source !== "pr" || journaledWatcher.state.headSha !== state.headSha) {
      console.log("  FAIL: poll did not journal the advanced state");
      return "FAIL";
    }

    // Step 2: a rebuild that rehydrates the journal must not replay.
    const rebuilt = build();
    rebuilt.hydrate(journaled.at(-1) ?? []);
    await rebuilt.poll();
    if (deliveryCount() !== 1 || rebuilt.pendingCount("ses_uc114") !== 0) {
      console.log("  FAIL: rehydrated registry replayed already-delivered events");
      return "FAIL";
    }

    // Step 3: expire the watch; the expiry queues even while the gate is shut.
    canDeliver = false;
    const watcher = rebuilt.listForSession("ses_uc114")[0];
    if (!watcher) {
      console.log("  FAIL: watcher vanished before the expiry step");
      return "FAIL";
    }
    watcher.createdAt = Date.now() - 480 * 60_000;
    watcher.expiresAt = Date.now() - 1;
    await rebuilt.poll();
    if (rebuilt.listForSession("ses_uc114").length !== 0) {
      console.log("  FAIL: expired watcher was not dropped");
      return "FAIL";
    }
    if (rebuilt.pendingCount("ses_uc114") !== 1) {
      console.log("  FAIL: expiry did not queue while the session was busy");
      return "FAIL";
    }

    // Step 4: the gate opens; the expiry delivers once, with the target and
    // lifetime in the summary.
    canDeliver = true;
    await rebuilt.deliverPending();
    const expiry = delivered[1]?.events[0];
    if (!expiry || expiry.type !== "watch_expired") {
      console.log(`  FAIL: expected a delivered watch_expired event, got ${delivered[1]?.events.map((e) => e.type).join(",") || "nothing"}`);
      return "FAIL";
    }
    if (!expiry.summary.includes("acme/widgets#7") || !expiry.summary.includes("480 min")) {
      console.log(`  FAIL: expiry summary should name the target and lifetime, got: ${expiry.summary}`);
      return "FAIL";
    }
    await rebuilt.poll();
    await rebuilt.deliverPending();
    if (deliveryCount() !== 2) {
      console.log("  FAIL: the expiry was reported more than once");
      return "FAIL";
    }

    registry.dispose();
    rebuilt.dispose();
    return "PASS";
  },
};

registerUseCase(useCase);
