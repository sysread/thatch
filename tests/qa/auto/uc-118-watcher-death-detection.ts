import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { WatcherRegistry, type WatcherEvent } from "../../../src/watchers";

/**
 * UC-118: watcher death detection - a dead session's watchers stop
 * polling, and the death is announced.
 *
 * Automatable: yes - the registry runs with injected dependencies and an
 * injectable clock. A closed v2 tab fires no session.deleted, so its
 * watchers used to poll until the 8h TTL while their notifications queued
 * forever. Death is now declared when a session's pending queue ages past
 * the threshold while deliveries throw 404-class errors consecutively -
 * the verified closed-tab signature (live probe 2026-10-07: prompt_async
 * to a closed v2 tab returns 404; the session row persists; no headless
 * turn runs).
 */

const useCase: UseCase = {
  name: "UC-118-watcher-death-detection",
  preconditions: [
    "- No prerequisites beyond the source tree; the mocked gh runner never touches the network.",
  ].join("\n"),
  steps: [
    "1. Register a PR watch and force a state change with a 404-throwing deliver callback; confirm the event queues and the death scan stays quiet while the pending queue is young.",
    "2. Age the pending queue past the death threshold (2 minutes here) and poll until the consecutive-throw minimum is reached; confirm death is declared exactly once, with the watch target in the summary.",
    "3. Confirm the dead session's watchers and pending queue are gone.",
    "4. Repeat with a session whose deliveries throw 5xx: confirm death is never declared (a wedged server is not a dead session).",
  ].join("\n"),
  expected: [
    "- Death requires age past the threshold AND consecutive 404-class delivery throws AND hosting eligibility.",
    "- The death callback fires once, carrying the watch target; the watchers and pending queue are dropped.",
    "- 5xx delivery loops never declare death.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    let clock = 1_000_000;
    const now = () => clock;
    const notFound = () => {
      const e = new Error("HTTP 404: session not found") as Error & { statusCode: number };
      e.statusCode = 404;
      return e;
    };

    const deaths: Array<{ sessionID: string; death: { chatName: string | null; targets: string[] } }> = [];
    const deathCount = () => deaths.length; // defeats TS literal narrowing across the asserts
    const pendingJournals: Array<{ sessionID: string; pending: { event: WatcherEvent; queuedAt: number }[] | undefined }> = [];
    const errorLog = console.error;
    console.error = () => {}; // the death path logs each failed delivery
    // Shared mocked gh runner: registration baselines must succeed - only
    // the DELIVERY throws in this use case.
    const gh = async (apiArgs: string[]) => {
      const joined = apiArgs.join(" ");
      if (/\/issues\/\d+\/comments/.test(joined)) return [];
      if (/\/pulls\/\d+\/comments/.test(joined)) return [];
      if (/\/check-runs/.test(joined)) return { check_runs: [] };
      if (/^graphql/.test(joined)) {
        return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
      }
      if (/\/pulls\/\d+$/.test(joined)) {
        return { head: { sha: "aaaa1111" }, state: "open", merged: false, title: "T", body: "b" };
      }
      throw new Error(`no route: ${joined}`);
    };
    try {
      const registry = new WatcherRegistry({
        deliver: async () => { throw notFound(); },
        canDeliver: () => true,
        ghRunner: gh,
        pollIntervalMs: 60_000,
        journalPending: (sessionID, pending) => pendingJournals.push({ sessionID, pending }),
        onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
        isHostedSession: () => true,
        deathMinutes: 2,
        now,
      });

      // Step 1: the event queues; a young pending queue never dies.
      const created = await registry.createPr("ses_uc118", "acme/widgets", 7, ["pr_commit"]);
      if (!created.ok) {
        console.log(`  FAIL: create failed: ${created.error}`);
        return "FAIL";
      }
      const watcher = registry.listForSession("ses_uc118")[0];
      if (!watcher || watcher.source !== "pr") {
        console.log("  FAIL: no pr watcher registered");
        return "FAIL";
      }
      watcher.state.headSha = "old";
      await registry.poll();
      if (registry.pendingCount("ses_uc118") !== 1) {
        console.log("  FAIL: the detected event did not queue");
        return "FAIL";
      }
      if (deaths.length !== 0) {
        console.log("  FAIL: death fired while the pending queue was young");
        return "FAIL";
      }

      // Step 2: age past the threshold; consecutive throws reach the minimum.
      clock += 3 * 60_000;
      for (let i = 0; i < 6; i++) await registry.poll();
      if (deathCount() !== 1) {
        console.log(`  FAIL: expected exactly one death declaration, got ${deathCount()}`);
        return "FAIL";
      }
      if (deaths[0].sessionID !== "ses_uc118" || !deaths[0].death.targets.includes("acme/widgets#7")) {
        console.log(`  FAIL: death summary should identify the session and target: ${JSON.stringify(deaths[0])}`);
        return "FAIL";
      }

      // Step 3: the dead session's state is gone.
      if (registry.listForSession("ses_uc118").length !== 0 || registry.pendingCount("ses_uc118") !== 0) {
        console.log("  FAIL: the dead session's watchers/pending were not dropped");
        return "FAIL";
      }

      // Step 4: 5xx loops are a wedged server, never death. The baseline
      // fetch must SUCCEED (only the delivery throws).
      const wedged = new WatcherRegistry({
        deliver: async () => { throw new Error("HTTP 502: bad gateway"); },
        canDeliver: () => true,
        ghRunner: gh,
        pollIntervalMs: 60_000,
        onSessionDeath: (sessionID, death) => deaths.push({ sessionID, death }),
        isHostedSession: () => true,
        deathMinutes: 2,
        now,
      });
      const seeded = await wedged.createPr("ses_uc118b", "acme/widgets", 8, ["pr_commit"]);
      if (!seeded.ok) {
        console.log(`  FAIL: wedged-registry create failed: ${seeded.error}`);
        return "FAIL";
      }
      const w2 = wedged.listForSession("ses_uc118b")[0];
      if (!w2 || w2.source !== "pr") {
        console.log("  FAIL: expected a pr watcher in the wedged registry");
        return "FAIL";
      }
      w2.state.headSha = "old";
      clock += 10 * 60_000;
      for (let i = 0; i < 6; i++) await wedged.poll();
      if (deathCount() !== 1) {
        console.log(`  FAIL: 5xx delivery loops must never declare death, got ${deathCount()}`);
        return "FAIL";
      }
      registry.dispose();
      wedged.dispose();
    } finally {
      console.error = errorLog;
    }

    return "PASS";
  },
};

registerUseCase(useCase);
