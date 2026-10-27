import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

// The transformers mock the adapter's runtime needs (no model download in
// QA) is registered by the shared harness module below, at import time.
import { server } from "../../../src/index";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { installOpencodeCommands } from "../../../src/commands";
import { EXIT_TAB_CLOSED_EVENT, TOAST_EVENT } from "../../../src/session-tab-shared";
import { makeV2Harness } from "../../mocks/v2-harness";
import { runtimeStateRow } from "../../mocks/runtime-state";
import { captureConsoleError } from "../../mocks/console-error";

/**
 * UC-103: Wrap-up commands (/thatch/compact, /thatch/exit).
 *
 * Automatable: yes — drives the real plugin server() with a mock SDK client,
 * so the greenlight protocol is exercised end-to-end with no logic
 * replication. The TUI actions are asserted at the client boundary
 * (executeCommand / publish payloads), which is as far as a headless test
 * can go: the TUI-side rendering of those actions needs a live session
 * (manual verification). The v2 leg (steps 9-11) drives the v2 adapter the
 * same way and asserts at its boundary: the session.compact call and the
 * tab-closed rpc event.
 */

const useCase: UseCase = {
  name: "UC-103-wrapup-commands",
  preconditions: [
    "- The opencode plugin installed (src/index.ts dual-shape entry export)",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Load the plugin server. Verify the command files were synced into the fixture's config home (opencode/command/thatch/compact.md and exit.md), and that each instructs the model to call its zero-arg greenlight tool (thatch_compact / thatch_exit).",
    "2. Verify installOpencodeCommands is idempotent (second run rewrites nothing).",
    "3. Simulate /thatch/compact: fire command.execute.before, call the thatch_compact tool (the greenlight), then fire session.status idle.",
    "4. Verify client.tui.executeCommand was called with the legacy alias 'session_compact' and publish was not used.",
    "5. Simulate /thatch/exit: arm it, call the thatch_exit tool (the greenlight), then fire session.status idle. Verify client.tui.publish sent tui.command.execute with 'app.exit'.",
    "6. Simulate /thatch/compact but let an un-greenlit idle pass first. Verify no TUI action fires and no warning toast is shown; the arm survives and still resolves on a later greenlight + idle.",
    "7. Fire session.deleted for a session with a pending wrap-up, then its idle. Verify no action fires.",
    "8. v2 leg: load the v2 adapter with a mock promise context (with session.compact), run the registered /thatch/compact command, call the thatch_compact tool, then fire an execution.succeeded idle. Verify session.compact was called with the session's id.",
    "9. v2 leg: run /thatch/exit, call the thatch_exit tool, then fire the idle. Verify the adapter emitted the exit-tab-closed rpc event (a TUI-only close of the session's own tab).",
    "10. v2 leg: reload the adapter on a context WITHOUT session.compact (the older-SDK floor) and run /thatch/compact to a tool greenlight. Verify it degrades without crashing or calling anything.",
    "11. v2 leg: run /thatch/compact but let an un-greenlit idle pass first. Verify the arm survives untouched (no warning toast, no completion action), then greenlight and verify session.compact fires.",
  ].join("\n"),
  expected: [
    "- The command files exist under the fixture's opencode/command/thatch/ after plugin load: each names its zero-arg greenlight tool (thatch_compact / thatch_exit) and carries a description frontmatter.",
    "- installOpencodeCommands returns an empty list when everything is current.",
    "- The compact greenlight (the thatch_compact tool call) triggers compact via executeCommand('session_compact'); the exit greenlight (the thatch_exit tool call) makes the following idle trigger publish of tui.command.execute 'app.exit'.",
    "- An un-greenlit arm survives idles untouched - no host action, no warning toast.",
    "- session.deleted clears a pending wrap-up so a later idle cannot fire it.",
    "- v2: a compact greenlight calls session.compact({sessionID}); an exit greenlight emits the exit-tab-closed rpc event {sessionID}; the older-SDK floor degrades to a logged no-op.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const recorded = { execute: [] as any[], publish: [] as any[], toast: [] as any[] };
    const mockClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "qa-103-child" } }),
        delete: async () => {},
        get: async () => ({ data: { title: "QA wrap-up session" } }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
      },
      tui: {
        showToast: async (opts: any) => {
          recorded.toast.push(opts);
        },
        executeCommand: async (opts: any) => {
          recorded.execute.push(opts);
          return { data: true };
        },
        publish: async (opts: any) => {
          recorded.publish.push(opts);
          return { data: true };
        },
      },
    };

    // server() reads env at init: THATCH_DB_PATH for the store,
    // XDG_CONFIG_HOME for the skill + command installs. Redirect both into
    // the fixture for the init window so the run never touches the real
    // user config, and restore immediately (other UCs share this process).
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDb = process.env.THATCH_DB_PATH;
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
    let hooks: Awaited<ReturnType<typeof server>>;
    try {
      hooks = await server({ client: mockClient, worktree: ctx.dir } as any);
    } finally {
      process.env.XDG_CONFIG_HOME = prevXdg;
      process.env.THATCH_DB_PATH = prevDb;
    }
    try {
      // Step 1: command files synced at plugin load.
      const dir = join(ctx.env.XDG_CONFIG_HOME, "opencode", "command", "thatch");
      const compactPath = join(dir, "compact.md");
      const exitPath = join(dir, "exit.md");
      if (!existsSync(compactPath) || !existsSync(exitPath)) {
        console.log("  FAIL: command files not installed into fixture config home");
        return "FAIL";
      }
      const compact = readFileSync(compactPath, "utf8");
      const exit = readFileSync(exitPath, "utf8");
      if (!compact.includes("thatch_compact") || !compact.includes("description:")) {
        console.log("  FAIL: compact.md missing the thatch_compact instruction or description frontmatter");
        return "FAIL";
      }
      if (!exit.includes("thatch_exit") || !exit.includes("description:")) {
        console.log("  FAIL: exit.md missing the thatch_exit tool instruction or description frontmatter");
        return "FAIL";
      }

      // Step 2: idempotent install.
      if (installOpencodeCommands(ctx.env.XDG_CONFIG_HOME).length !== 0) {
        console.log("  FAIL: installOpencodeCommands rewrote current files");
        return "FAIL";
      }

      const idle = (sessionID: string) =>
        hooks.event!({ event: {
          type: "session.status",
          properties: { sessionID, status: { type: "idle" } } } as any,
        });
      const arm = (command: string, sessionID: string) =>
        hooks["command.execute.before"]!({ command, sessionID, arguments: "" }, { parts: [] });
      // Length reads go through a helper: inline `arr.length !== n` lets TS
      // narrow the length to a literal and reject later comparisons.
      const count = (arr: any[]) => arr.length;

      // Steps 3-4: compact greenlight via the thatch_compact tool ->
      // executeCommand with the legacy alias on the following idle.
      await arm("thatch/compact", "ses-qa-103a");
      await hooks.tool!.thatch_compact.execute({}, { sessionID: "ses-qa-103a" } as any);
      await idle("ses-qa-103a");
      if (count(recorded.execute) !== 1 || recorded.execute[0].body.command !== "session_compact") {
        console.log(`  FAIL: compact greenlight should call executeCommand('session_compact'), got ${JSON.stringify(recorded.execute)}`);
        return "FAIL";
      }
      if (count(recorded.publish) !== 0) {
        console.log("  FAIL: compact greenlight must not use publish");
        return "FAIL";
      }

      // Step 5: exit greenlight via the thatch_exit tool -> publish
      // app.exit on the following idle. An un-greenlit exit idle must
      // leave the arm alone first (the mid-exit-wait fix).
      const beforeExit = { publish: count(recorded.publish) };
      await arm("thatch/exit", "ses-qa-103b");
      await idle("ses-qa-103b");
      if (count(recorded.publish) !== beforeExit.publish) {
        console.log(`  FAIL: an un-greenlit exit arm must not trigger any host action, got ${JSON.stringify(recorded.publish)}`);
        return "FAIL";
      }
      await hooks.tool!.thatch_exit.execute({}, { sessionID: "ses-qa-103b" } as any);
      await idle("ses-qa-103b");
      if (
        count(recorded.publish) !== beforeExit.publish + 1 ||
        recorded.publish[beforeExit.publish].body.type !== "tui.command.execute" ||
        recorded.publish[beforeExit.publish].body.properties.command !== "app.exit"
      ) {
        console.log(`  FAIL: exit greenlight should publish tui.command.execute 'app.exit', got ${JSON.stringify(recorded.publish)}`);
        return "FAIL";
      }

      // Step 6: an un-greenlit compact arm survives an idle untouched (the
      // mid-checklist fix; blockers are prose, there is no runtime
      // "blocked" concept to toast about). Find any stray warning by
      // variant + command name, not by position: a first-idle registration
      // toast (info) may land after it.
      const beforeBlock = { execute: count(recorded.execute), publish: count(recorded.publish) };
      const blockedWarn = () =>
        recorded.toast.find((t) => t.body.variant === "warning" && t.body.message.includes("/thatch/compact"));
      await arm("thatch/compact", "ses-qa-103c");
      await idle("ses-qa-103c");
      if (recorded.execute.length !== beforeBlock.execute || recorded.publish.length !== beforeBlock.publish) {
        console.log("  FAIL: an un-greenlit compact arm must not trigger a TUI action");
        return "FAIL";
      }
      if (blockedWarn()) {
        console.log(`  FAIL: an un-greenlit compact arm must not show a warning toast, got ${JSON.stringify(recorded.toast)}`);
        return "FAIL";
      }
      // The arm still resolves: greenlight now, compact on the next idle.
      await hooks.tool!.thatch_compact.execute({}, { sessionID: "ses-qa-103c" } as any);
      await idle("ses-qa-103c");
      if (recorded.execute.length !== beforeBlock.execute + 1) {
        console.log(`  FAIL: a late compact greenlight should still trigger the compaction, got ${JSON.stringify(recorded.execute)}`);
        return "FAIL";
      }

      // Step 7: session.deleted clears a pending wrap-up.
      await arm("thatch/compact", "ses-qa-103e");
      await hooks.event!({ event: {
        type: "session.deleted",
        properties: { info: { id: "ses-qa-103e" } } } as any,
      });
      await idle("ses-qa-103e");
      if (recorded.execute.length !== beforeBlock.execute + 1) {
        console.log("  FAIL: pending wrap-up fired after session.deleted");
        return "FAIL";
      }

      // Steps 8-11: the v2 adapter leg. Same greenlight protocol, asserted
      // at the v2 boundary: the compact action is a session.compact call,
      // the exit action is the exit-tab-closed rpc event (a TUI-only close
      // of the session's own tab). The armed journal row is the resolution
      // observable - the greenlit branch deletes it, so its absence proves
      // the branch ran to completion.
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
      const wrapupArmed = (sessionID: string) => runtimeStateRow(ctx.env.THATCH_DB_PATH, "wrapup", sessionID) !== null;

      // Steps 8-9: compact and exit greenlights on the v2 adapter.
      const v2 = makeV2Harness(ctx.dir, { compact: true });
      let disposeV2: (() => Promise<void>) | undefined;
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      try {
        disposeV2 = (await setupV2(v2.context as any)) as () => Promise<void>;
      } finally {
        process.env.XDG_CONFIG_HOME = prevXdg;
        process.env.THATCH_DB_PATH = prevDb;
      }
      try {
        const compactCmd = v2.commands.find((c) => c.name === "thatch/compact")!;
        const exitCmd = v2.commands.find((c) => c.name === "thatch/exit")!;
        const exitTool = v2.addedTools.find((t) => t.name === "thatch_exit")!;
        await compactCmd.execute({ sessionID: "ses-qa-103-v2a" });
        await v2.addedTools.find((t) => t.name === "thatch_compact")!.execute({}, { sessionID: "ses-qa-103-v2a" });
        await v2.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2a" } });
        if (!(await v2wait("v2 compact call", () => v2.calls.compact.length === 1))) return "FAIL";
        if (v2.calls.compact[0].sessionID !== "ses-qa-103-v2a") {
          console.log(`  FAIL: v2 compact greenlight should call session.compact with the session's id, got ${JSON.stringify(v2.calls.compact)}`);
          return "FAIL";
        }

        await exitCmd.execute({ sessionID: "ses-qa-103-v2b" });
        await exitTool.execute({}, { sessionID: "ses-qa-103-v2b" });
        await v2.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2b" } });
        if (!(await v2wait("v2 exit-tab-closed emit", () => v2.calls.emitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT)))) return "FAIL";
        const closed = v2.calls.emitted.find((e) => e.name === EXIT_TAB_CLOSED_EVENT)!;
        // TUI-only payload: the runtime's death callback runs synchronously
        // before the action (registry cancellation + project capture; the
        // durable row write rides the async continuation), and the pump
        // never translates this event (a tab-closed-style payload would
        // invite that).
        if (closed.data.sessionID !== "ses-qa-103-v2b") {
          console.log(`  FAIL: v2 exit greenlight should emit exit-tab-closed {sessionID}, got ${JSON.stringify(closed.data)}`);
          return "FAIL";
        }
      } finally {
        await disposeV2?.();
      }

      // Step 10: the older-SDK floor (no session.compact member) degrades
      // to a logged no-op, not a crash - the wrap-up checklist and flush
      // still ran. The greenlight is the tool call.
      const v2floor = makeV2Harness(ctx.dir, { compact: false });
      let disposeFloor: (() => Promise<void>) | undefined;
      const { result: floorResult, lines: floorLog } = await captureConsoleError(async () => {
        process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
        process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
        try {
          disposeFloor = (await setupV2(v2floor.context as any)) as () => Promise<void>;
          const floorCmd = v2floor.commands.find((c) => c.name === "thatch/compact")!;
          await floorCmd.execute({ sessionID: "ses-qa-103-v2c" });
          await v2floor.addedTools.find((t) => t.name === "thatch_compact")!.execute({}, { sessionID: "ses-qa-103-v2c" });
          await v2floor.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2c" } });
          if (!(await v2wait("floor wrap-up resolved", () => !wrapupArmed("ses-qa-103-v2c")))) return "FAIL";
          // The row delete happens BEFORE the degrade log, so the log is
          // still in flight at row-gone: settle INSIDE the capture scope
          // or the log can slip out past it.
          await new Promise((r) => setTimeout(r, 150));
          return "PASS";
        } finally {
          process.env.XDG_CONFIG_HOME = prevXdg;
          process.env.THATCH_DB_PATH = prevDb;
          await disposeFloor?.();
        }
      });
      if (floorResult !== "PASS") return "FAIL";
      if (!floorLog.some((line) => line.includes("compaction trigger unavailable"))) {
        console.log(`  FAIL: v2 floor compact should degrade with a log, got ${JSON.stringify(floorLog)}`);
        return "FAIL";
      }

      // Step 11: an un-greenlit compact arm survives an idle untouched on
      // v2 - no warning toast over the bridge (the blocked path died with
      // the token), no completion action. Registration toasts (info) may
      // land from the fall-through auto-register; find any stray warning
      // by variant + command name. The arm still resolves on a later
      // greenlight + idle.
      const v2blocked = makeV2Harness(ctx.dir, { compact: true });
      let disposeBlocked: (() => Promise<void>) | undefined;
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      try {
        disposeBlocked = (await setupV2(v2blocked.context as any)) as () => Promise<void>;
        const blockedCmd = v2blocked.commands.find((c) => c.name === "thatch/compact")!;
        await blockedCmd.execute({ sessionID: "ses-qa-103-v2d" });
        await v2blocked.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2d" } });
        await new Promise((r) => setTimeout(r, 150));
        if (!wrapupArmed("ses-qa-103-v2d")) {
          console.log("  FAIL: an un-greenlit compact arm must survive an idle on v2");
          return "FAIL";
        }
        if (
          v2blocked.calls.emitted.some(
            (e) => e.name === TOAST_EVENT && e.data?.variant === "warning" && String(e.data?.message).includes("/thatch/compact"),
          )
        ) {
          console.log(`  FAIL: an un-greenlit compact arm must not show a warning toast, got ${JSON.stringify(v2blocked.calls.emitted)}`);
          return "FAIL";
        }
        if (v2blocked.calls.compact.length !== 0) {
          console.log(`  FAIL: an un-greenlit compact arm must not call session.compact, got ${JSON.stringify(v2blocked.calls.compact)}`);
          return "FAIL";
        }
        // The arm still resolves: greenlight now, compact on the next idle.
        await v2blocked.addedTools.find((t) => t.name === "thatch_compact")!.execute({}, { sessionID: "ses-qa-103-v2d" });
        await v2blocked.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2d" } });
        if (!(await v2wait("late v2 compact call", () => v2blocked.calls.compact.length === 1))) return "FAIL";
        if (wrapupArmed("ses-qa-103-v2d")) {
          console.log("  FAIL: the resolved compact arm's journal row must be gone");
          return "FAIL";
        }
      } finally {
        process.env.XDG_CONFIG_HOME = prevXdg;
        process.env.THATCH_DB_PATH = prevDb;
        await disposeBlocked?.();
      }

      return "PASS";
    } finally {
      hooks.dispose?.();
    }
  },
};

registerUseCase(useCase);
