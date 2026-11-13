import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

// The transformers mock the adapter's runtime needs (no model download in
// QA) is registered by the shared harness module below, at import time.
import { setup as setupV2 } from "../../../src/opencode/v2";
import { installOpencodeCommands } from "../../../src/commands";
import { EXIT_TAB_CLOSED_EVENT, TOAST_EVENT } from "../../../src/session-tab-shared";
import { makeV2Harness } from "../../mocks/v2-harness";
import { runtimeStateRow } from "../../mocks/runtime-state";

/**
 * UC-103: Wrap-up commands (/thatch/compact, /thatch/exit).
 *
 * Automatable: yes - drives the real v2 adapter with a mock promise
 * context, so the greenlight protocol is exercised end-to-end with no
 * logic replication. Asserted at the adapter's boundary: the
 * session.compact call and the tab-closed rpc event. The TUI-side
 * rendering of those actions needs a live session (manual verification).
 */

const useCase: UseCase = {
  name: "UC-103-wrapup-commands",
  preconditions: [
    "- The opencode plugin installed (src/index.ts default-export entry)",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Load the v2 adapter. Verify the ACTION command files were synced into the fixture's config home, that no wrap-up FILES exist (they register in code), and that wrap-up files left by a pre-drop install are removed.",
    "2. Verify installOpencodeCommands is idempotent (second run rewrites nothing).",
    "3. Run the registered /thatch/compact command, call the thatch_compact tool (the greenlight), then fire an execution.succeeded idle. Verify session.compact was called with the session's id.",
    "4. Run /thatch/exit, call the thatch_exit tool, then fire the idle. Verify the adapter emitted the exit-tab-closed rpc event (a TUI-only close of the session's own tab).",
    "5. Run /thatch/compact but let an un-greenlit idle pass first. Verify no host action fires and no warning toast is shown; the arm survives and still resolves on a later greenlight + idle.",
    "6. Fire session.deleted for a session with a pending wrap-up, then its idle. Verify no action fires.",
    "7. Simulate a mid-checklist location switch (the merged-worktree re-home): boot a SECOND adapter instance bound to a different directory against the same db, arm /thatch/exit through the FIRST instance, then greenlight (thatch_exit) and idle through the SECOND. Verify the exit still completes: the close event fires from the new location's instance and the arm row is gone.",
  ].join("\n"),
  expected: [
    "- The action command files exist under the fixture's opencode/command/thatch/ after plugin load; the wrap-up files (compact.md, exit.md) do not, and pre-drop leftovers are removed.",
    "- installOpencodeCommands returns an empty list when everything is current.",
    "- A compact greenlight (the thatch_compact tool call) triggers session.compact({sessionID}); an exit greenlight (thatch_exit) makes the following idle emit the exit-tab-closed rpc event {sessionID}.",
    "- An un-greenlit arm survives idles untouched - no host action, no warning toast.",
    "- session.deleted clears a pending wrap-up so a later idle cannot fire it.",
    "- A wrap-up armed in one location completes from another: the greenlight adopts the journaled arm (pid-scoped, directory-blind) in the new location's instance, and the closing idle fires the host action there.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDb = process.env.THATCH_DB_PATH;
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;

    // Pre-drop leftovers: wrap-up files the current install never writes.
    // The adapter load must remove them (they collide with the registered
    // wrap-up commands). The command dir does not exist yet on a fresh
    // fixture - create it before seeding.
    const cmdDir = join(ctx.env.XDG_CONFIG_HOME, "opencode", "command", "thatch");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "compact.md"), "stale pre-drop wrap-up file");
    writeFileSync(join(cmdDir, "exit.md"), "stale pre-drop wrap-up file");

    const harness = makeV2Harness(ctx.dir, { childID: "qa-103-child" });
    let dispose: (() => Promise<void>) | undefined;
    try {
      dispose = (await setupV2(harness.context as any)) as () => Promise<void>;
    } finally {
      process.env.XDG_CONFIG_HOME = prevXdg;
      process.env.THATCH_DB_PATH = prevDb;
    }
    try {
      // Step 1: action files synced at adapter load; wrap-up files removed.
      for (const name of ["defrag", "extract", "hygiene", "peer-review", "bug-intake", "refine", "reflect", "self-review", "whois"]) {
        if (!existsSync(join(cmdDir, `${name}.md`))) {
          console.log(`  FAIL: action file ${name}.md not installed into fixture config home`);
          return "FAIL";
        }
      }
      if (existsSync(join(cmdDir, "compact.md")) || existsSync(join(cmdDir, "exit.md"))) {
        console.log("  FAIL: pre-drop wrap-up files were not removed at adapter load");
        return "FAIL";
      }
      const defrag = readFileSync(join(cmdDir, "defrag.md"), "utf8");
      if (!defrag.includes("description:") || !defrag.includes("$ARGUMENTS")) {
        console.log("  FAIL: defrag.md missing frontmatter or user-message section");
        return "FAIL";
      }

      // Step 2: idempotent install.
      if (installOpencodeCommands(ctx.env.XDG_CONFIG_HOME).length !== 0) {
        console.log("  FAIL: installOpencodeCommands rewrote current files");
        return "FAIL";
      }

      const idle = (sessionID: string) =>
        harness.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID } });
      // The armed journal row is the resolution observable: the greenlit
      // branch deletes it, so its absence proves the branch ran to
      // completion - not that it never ran.
      const wrapupArmed = (sessionID: string) => runtimeStateRow(ctx.env.THATCH_DB_PATH, "wrapup", sessionID) !== null;
      const v2wait = async (desc: string, fn: () => unknown): Promise<boolean> => {
        // Expected settle: ms-scale pump handling. 30s = expected x ~300
        // headroom for loaded runners; this use case's overall test timeout
        // is 20 minutes, so the poll window is the only tight budget here.
        const end = Date.now() + 30_000;
        while (!fn()) {
          if (Date.now() > end) {
            console.log(`  FAIL: timed out waiting for: ${desc}`);
            return false;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        return true;
      };

      // Step 3: compact greenlight via the thatch_compact tool ->
      // session.compact on the following idle.
      const compactCmd = harness.commands.find((c) => c.name === "thatch/compact")!;
      await compactCmd.execute({ sessionID: "ses-qa-103a" });
      if (!wrapupArmed("ses-qa-103a")) {
        console.log("  FAIL: /thatch/compact did not arm the wrap-up check");
        return "FAIL";
      }
      await harness.addedTools.find((t) => t.name === "thatch_compact")!.execute({}, { sessionID: "ses-qa-103a" });
      await idle("ses-qa-103a");
      if (!(await v2wait("session.compact call", () => harness.calls.compact.length === 1))) return "FAIL";
      if (harness.calls.compact[0].sessionID !== "ses-qa-103a") {
        console.log(`  FAIL: compact greenlight should call session.compact with the session's id, got ${JSON.stringify(harness.calls.compact)}`);
        return "FAIL";
      }
      if (wrapupArmed("ses-qa-103a")) {
        console.log("  FAIL: the resolved compact arm's journal row must be gone");
        return "FAIL";
      }

      // Step 4: exit greenlight via the thatch_exit tool -> the
      // exit-tab-closed rpc event (a TUI-only close of the session's own
      // tab) on the following idle. An un-greenlit exit idle must leave
      // the arm alone first (the mid-exit-wait fix).
      const exitCmd = harness.commands.find((c) => c.name === "thatch/exit")!;
      const emittedExits = () => harness.calls.emitted.filter((e) => e.name === EXIT_TAB_CLOSED_EVENT);
      const beforeExit = emittedExits().length;
      await exitCmd.execute({ sessionID: "ses-qa-103b" });
      await idle("ses-qa-103b");
      if (emittedExits().length !== beforeExit) {
        console.log("  FAIL: an un-greenlit exit arm must not trigger any host action");
        return "FAIL";
      }
      await harness.addedTools.find((t) => t.name === "thatch_exit")!.execute({}, { sessionID: "ses-qa-103b" });
      await idle("ses-qa-103b");
      if (!(await v2wait("exit-tab-closed emit", () => emittedExits().length === beforeExit + 1))) return "FAIL";
      const closed = emittedExits()[beforeExit]!;
      // TUI-only payload (just the tab to close): the runtime records the
      // session's watcher deaths synchronously before the action, and the
      // pump never translates this event (a tab-closed-style payload would
      // invite that).
      if (closed.data.sessionID !== "ses-qa-103b") {
        console.log(`  FAIL: exit greenlight should emit exit-tab-closed {sessionID}, got ${JSON.stringify(closed.data)}`);
        return "FAIL";
      }

      // Step 5: an un-greenlit compact arm survives an idle untouched (the
      // mid-checklist fix; blockers are prose, there is no runtime
      // "blocked" concept to toast about). Find any stray warning by
      // variant + command name, not by position: a first-idle registration
      // toast (info) may land after it.
      const beforeBlock = { compact: harness.calls.compact.length };
      await compactCmd.execute({ sessionID: "ses-qa-103c" });
      await idle("ses-qa-103c");
      if (!wrapupArmed("ses-qa-103c")) {
        console.log("  FAIL: an un-greenlit compact arm must survive an idle");
        return "FAIL";
      }
      if (
        harness.calls.emitted.some(
          (e) => e.name === TOAST_EVENT && e.data?.variant === "warning" && String(e.data?.message).includes("/thatch/compact"),
        )
      ) {
        console.log("  FAIL: an un-greenlit compact arm must not show a warning toast");
        return "FAIL";
      }
      if (harness.calls.compact.length !== beforeBlock.compact) {
        console.log("  FAIL: an un-greenlit compact arm must not call session.compact");
        return "FAIL";
      }
      // The arm still resolves: greenlight now, compact on the next idle.
      await harness.addedTools.find((t) => t.name === "thatch_compact")!.execute({}, { sessionID: "ses-qa-103c" });
      await idle("ses-qa-103c");
      if (!(await v2wait("late compact call", () => harness.calls.compact.length === beforeBlock.compact + 1))) return "FAIL";
      if (wrapupArmed("ses-qa-103c")) {
        console.log("  FAIL: the late-resolved compact arm's journal row must be gone");
        return "FAIL";
      }

      // Step 6: session.deleted clears a pending wrap-up.
      await compactCmd.execute({ sessionID: "ses-qa-103e" });
      await harness.queue({
        type: "session.deleted",
        location: { directory: ctx.dir },
        data: { sessionID: "ses-qa-103e" },
      });
      await idle("ses-qa-103e");
      if (harness.calls.compact.length !== beforeBlock.compact + 1) {
        console.log("  FAIL: pending wrap-up fired after session.deleted");
        return "FAIL";
      }

      // Step 7: the mid-checklist location switch (the 2026-11-13
      // emma-bedding-00033 incident). A session whose worktree is merged
      // and deleted under it re-homes to another directory; every later
      // tool call and idle then resolves through the NEW location's plugin
      // instance (one serve hosts one instance per directory). Arm through
      // the ORIGINAL instance, then complete the whole greenlight + close
      // from the NEW one: the greenlight must adopt the journaled arm
      // (pid-scoped, directory-blind), and the closing idle must fire the
      // host action from the new instance.
      const movedDir = join(ctx.dir, "moved-home");
      mkdirSync(movedDir, { recursive: true });
      const movedHarness = makeV2Harness(movedDir, { childID: "qa-103-moved-child" });
      // Same env discipline as the first adapter load: the fixture db and
      // config home must be in place before setup (the first load's
      // finally restored the developer's real environment).
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      let movedDispose: (() => Promise<void>) | undefined;
      try {
        movedDispose = (await setupV2(movedHarness.context as any)) as () => Promise<void>;
      } finally {
        process.env.XDG_CONFIG_HOME = prevXdg;
        process.env.THATCH_DB_PATH = prevDb;
      }
      try {
        await exitCmd.execute({ sessionID: "ses-qa-103f" });
        if (!wrapupArmed("ses-qa-103f")) {
          console.log("  FAIL: /thatch/exit did not arm before the simulated move");
          return "FAIL";
        }
        const movedExitTool = movedHarness.addedTools.find((t) => t.name === "thatch_exit")!;
        const movedResult = (await movedExitTool.execute({}, { sessionID: "ses-qa-103f" })) as { content: string };
        if (!String(movedResult?.content).includes("Greenlit")) {
          console.log(`  FAIL: the moved session's thatch_exit must adopt the journaled arm, got ${JSON.stringify(movedResult)}`);
          return "FAIL";
        }
        const movedExits = () => movedHarness.calls.emitted.filter((e) => e.name === EXIT_TAB_CLOSED_EVENT);
        await movedHarness.queue({
          type: "session.execution.succeeded",
          location: { directory: movedDir },
          data: { sessionID: "ses-qa-103f" },
        });
        if (!(await v2wait("moved session's exit close", () => movedExits().some((e) => e.data?.sessionID === "ses-qa-103f")))) return "FAIL";
        if (wrapupArmed("ses-qa-103f")) {
          console.log("  FAIL: the moved session's resolved arm row must be gone");
          return "FAIL";
        }
      } finally {
        await movedDispose();
      }

      return "PASS";
    } finally {
      await dispose?.();
    }
  },
};

registerUseCase(useCase);
