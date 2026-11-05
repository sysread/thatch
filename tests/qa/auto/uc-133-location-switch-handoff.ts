import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { makeV2Harness } from "../../mocks/v2-harness";
import { ThatchDB } from "../../../src/db";

/**
 * UC-133: location-switch hand-off (issue #25).
 *
 * Automatable: yes - boots the real v2 adapter on the shared mock promise
 * context, feeds the session.moved bus event through the harness's event
 * queue, and asserts the hosted journal row reacts: a session that moved
 * AWAY is released (the row loses it, so the old instance stops waking and
 * stamp-delivering for a session that no longer lives here), a session
 * that moved IN is adopted (the row gains it durably, so mail delivery
 * resumes from the destination instance).
 */

const useCase: UseCase = {
  name: "UC-133-location-switch-handoff",
  preconditions: [
    "- The opencode v2 adapter (src/opencode/v2.ts) loadable with a mock promise context",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Seed the hosted journal row (runtime_state kind=hosted keyed by the adapter's directory) with a session id, then boot the v2 adapter so it rehydrates as hosted.",
    "2. Queue a session.moved event for that session pointing at a foreign directory.",
    "3. Verify the hosted journal row no longer contains the moved session (released).",
    "4. Queue a session.moved event for a new session pointing AT the adapter's directory.",
    "5. Verify the hosted journal row contains the newcomer (adopted).",
  ].join("\n"),
  expected: [
    "- The moved-away session is released from hosting: the journal row loses it, so no future wake prompt runs through the old instance's delivery guard (the wake-accepted-but-never-executed zombie, issue #25).",
    "- The moved-in session is adopted: the journal row gains it before any poller tick, so mail delivery resumes from the destination instance without waiting for the session's first turn.",
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
    const hostedIds = (): string[] => {
      const check = new ThatchDB(ctx.env.THATCH_DB_PATH);
      try {
        const row = check.runtimeStateAll().find((r) => r.kind === "hosted" && r.sessionID === ctx.dir);
        return Array.isArray(row?.value) ? (row!.value as string[]) : [];
      } finally {
        check.close();
      }
    };

    // Seed hosting for qa-133-moved BEFORE setup: a same-pid same-directory
    // hosted row rehydrates into rehostedSessions, so the adapter hosts it
    // from the first beat.
    const seed = new ThatchDB(ctx.env.THATCH_DB_PATH);
    try {
      seed.runtimeStatePut("hosted", ctx.dir, ["qa-133-moved"], ctx.dir);
    } finally {
      seed.close();
    }

    const harness = makeV2Harness(ctx.dir, {});
    let dispose: (() => Promise<void>) | undefined;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    const prevDb = process.env.THATCH_DB_PATH;
    const prevSweep = process.env.THATCH_STRAND_SWEEP;
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = ctx.env.XDG_DATA_HOME;
    process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
    process.env.THATCH_STRAND_SWEEP = "off";
    try {
      dispose = (await setupV2(harness.context as any)) as () => Promise<void>;

      // Moved AWAY: the release must prune the journal row (no future wake
      // prompts through this instance for a session that lives elsewhere).
      await harness.queue({
        type: "session.moved",
        data: { sessionID: "qa-133-moved", location: { directory: join(ctx.dir, "elsewhere") } },
      });
      if (!(await v2wait("moved session released", () => !hostedIds().includes("qa-133-moved")))) return "FAIL";

      // Moved IN: the adoption must land durably (before any poller tick).
      await harness.queue({
        type: "session.moved",
        data: { sessionID: "qa-133-newcomer", location: { directory: ctx.dir } },
      });
      if (!(await v2wait("moved-in session adopted", () => hostedIds().includes("qa-133-newcomer")))) return "FAIL";

      return "PASS";
    } finally {
      await dispose?.();
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevData;
      if (prevDb === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDb;
      if (prevSweep === undefined) delete process.env.THATCH_STRAND_SWEEP;
      else process.env.THATCH_STRAND_SWEEP = prevSweep;
    }
  },
};

registerUseCase(useCase);
