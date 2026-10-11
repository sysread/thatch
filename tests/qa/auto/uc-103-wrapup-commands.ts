import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

// The transformers mock the adapter's runtime needs (no model download in
// QA) is registered by the shared harness module below, at import time.
import { server } from "../../../src/index";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { installOpencodeCommands } from "../../../src/commands";
import { EXIT_TAB_CLOSED_EVENT, TOAST_EVENT } from "../../../src/session-tab-shared";
import { Database } from "bun:sqlite";
import { makeV2Harness } from "../../mocks/v2-harness";

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
    "1. Load the plugin server. Verify the command files were synced into the fixture's config home (opencode/command/thatch/compact.md and exit.md) and that the templates carry the greenlight tokens.",
    "2. Verify installOpencodeCommands is idempotent (second run rewrites nothing).",
    "3. Simulate /thatch/compact: fire command.execute.before, make the last assistant message end with THATCH_COMPACT_READY, then fire session.status idle.",
    "4. Verify client.tui.executeCommand was called with the legacy alias 'session_compact' and publish was not used.",
    "5. Simulate /thatch/exit with a THATCH_EXIT_READY greenlight. Verify client.tui.publish sent tui.command.execute with 'app.exit'.",
    "6. Simulate /thatch/compact with a response that lacks the token. Verify no TUI action fires and a warning toast is shown.",
    "7. Simulate /thatch/compact with the token mid-text (not trailing). Verify it does not greenlight.",
    "8. Fire session.deleted for a session with a pending wrap-up, then its idle. Verify no action fires.",
    "9. v2 leg: load the v2 adapter with a mock promise context (with session.compact) and run the registered /thatch/compact command to a THATCH_COMPACT_READY greenlight over an execution.succeeded idle. Verify session.compact was called with the session's id.",
    "10. v2 leg: run /thatch/exit to a THATCH_EXIT_READY greenlight. Verify the adapter emitted the exit-tab-closed rpc event (a TUI-only close of the session's own tab).",
    "11. v2 leg: reload the adapter on a context WITHOUT session.compact (the older-SDK floor) and run /thatch/compact to a greenlight. Verify it degrades without crashing or calling anything.",
    "12. v2 leg: run /thatch/compact with a response that lacks the token. Verify a warning toast is emitted over the rpc bridge (the TUI feedback channel) and no completion action fires.",
  ].join("\n"),
  expected: [
    "- The command files exist under the fixture's opencode/command/thatch/ after plugin load, each carrying its token and a description frontmatter.",
    "- installOpencodeCommands returns an empty list when everything is current.",
    "- A trailing greenlight token triggers compact via executeCommand('session_compact') and exit via publish of tui.command.execute 'app.exit'.",
    "- A missing or non-trailing token never triggers; a warning toast fires instead (the bridge's toast event on v2).",
    "- session.deleted clears a pending wrap-up so a later idle cannot fire it.",
    "- v2: a compact greenlight calls session.compact({sessionID}); an exit greenlight emits the exit-tab-closed rpc event {sessionID}; the older-SDK floor degrades to a logged no-op.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const recorded = { execute: [] as any[], publish: [] as any[], toast: [] as any[] };
    let messages: any[] = [];
    const mockClient = {
      session: {
        prompt: async () => {},
        promptAsync: async () => {},
        create: async () => ({ data: { id: "qa-103-child" } }),
        delete: async () => {},
        get: async () => ({ data: { title: "QA wrap-up session" } }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: messages }),
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
      if (!compact.includes("THATCH_COMPACT_READY") || !compact.includes("description:")) {
        console.log("  FAIL: compact.md missing token or description frontmatter");
        return "FAIL";
      }
      if (!exit.includes("THATCH_EXIT_READY") || !exit.includes("description:")) {
        console.log("  FAIL: exit.md missing token or description frontmatter");
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
      const assistant = (text: string) => [
        { info: { id: "msg-x", role: "user" }, parts: [{ type: "text", text: "prompt" }] },
        { info: { id: "msg-y", role: "assistant" }, parts: [{ type: "text", text }] },
      ];

      // Length reads go through a helper: inline `arr.length !== n` lets TS
      // narrow the length to a literal and reject later comparisons.
      const count = (arr: any[]) => arr.length;

      // Step 3-4: compact greenlight -> executeCommand with legacy alias.
      messages = assistant("All clear.\nTHATCH_COMPACT_READY");
      await arm("thatch/compact", "ses-qa-103a");
      await idle("ses-qa-103a");
      if (count(recorded.execute) !== 1 || recorded.execute[0].body.command !== "session_compact") {
        console.log(`  FAIL: compact greenlight should call executeCommand('session_compact'), got ${JSON.stringify(recorded.execute)}`);
        return "FAIL";
      }
      if (count(recorded.publish) !== 0) {
        console.log("  FAIL: compact greenlight must not use publish");
        return "FAIL";
      }

      // Step 5: exit greenlight -> publish app.exit.
      messages = assistant("Nothing pending.\nTHATCH_EXIT_READY");
      await arm("thatch/exit", "ses-qa-103b");
      await idle("ses-qa-103b");
      if (
        count(recorded.publish) !== 1 ||
        recorded.publish[0].body.type !== "tui.command.execute" ||
        recorded.publish[0].body.properties.command !== "app.exit"
      ) {
        console.log(`  FAIL: exit greenlight should publish tui.command.execute 'app.exit', got ${JSON.stringify(recorded.publish)}`);
        return "FAIL";
      }

      // Step 6: missing token -> toast, no trigger.
      const beforeBlock = { execute: count(recorded.execute), publish: count(recorded.publish) };
      messages = assistant("Outstanding: fix the failing test first.");
      await arm("thatch/compact", "ses-qa-103c");
      await idle("ses-qa-103c");
      if (recorded.execute.length !== beforeBlock.execute || recorded.publish.length !== beforeBlock.publish) {
        console.log("  FAIL: blocked wrap-up must not trigger a TUI action");
        return "FAIL";
      }
      // A blocked wrap-up's warning toast - find it by variant + command
      // name, not by position: a first-idle registration toast may land
      // after it (the blocked path falls through to auto-register).
      const warn = recorded.toast.find(
        (t) => t.body.variant === "warning" && t.body.message.includes("/thatch/compact"),
      );
      if (!warn) {
        console.log(`  FAIL: blocked wrap-up should show a warning toast naming the command, got ${JSON.stringify(recorded.toast)}`);
        return "FAIL";
      }

      // Step 7: mid-text token does not greenlight.
      messages = assistant("The token is THATCH_COMPACT_READY but one todo is still open.");
      await arm("thatch/compact", "ses-qa-103d");
      await idle("ses-qa-103d");
      if (recorded.execute.length !== beforeBlock.execute) {
        console.log("  FAIL: mid-text token must not greenlight");
        return "FAIL";
      }

      // Step 8: session.deleted clears a pending wrap-up.
      messages = assistant("THATCH_COMPACT_READY");
      await arm("thatch/compact", "ses-qa-103e");
      await hooks.event!({ event: {
        type: "session.deleted",
        properties: { info: { id: "ses-qa-103e" } } } as any,
      });
      await idle("ses-qa-103e");
      if (recorded.execute.length !== beforeBlock.execute) {
        console.log("  FAIL: pending wrap-up fired after session.deleted");
        return "FAIL";
      }

      // Steps 9-11: the v2 adapter leg. Same greenlight protocol, asserted
      // at the v2 boundary: the compact action is a session.compact call,
      // the exit action is the exit-tab-closed rpc event (a TUI-only close
      // of the session's own tab). The armed journal row is the resolution
      // observable - the branch deletes it whether or not the token
      // matched, so its absence proves the branch ran to completion.
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
      const wrapupArmed = (sessionID: string) => {
        const db = new Database(ctx.env.THATCH_DB_PATH, { readonly: true });
        try {
          return db.query("SELECT 1 FROM runtime_state WHERE kind = 'wrapup' AND session_id = ?").get(sessionID) != null;
        } finally {
          db.close();
        }
      };

      // Steps 9-10: compact and exit greenlights on the v2 adapter.
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
        v2.setAssistant("All clear.\nTHATCH_COMPACT_READY");
        await compactCmd.execute({ sessionID: "ses-qa-103-v2a" });
        await v2.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2a" } });
        if (!(await v2wait("v2 compact call", () => v2.calls.compact.length === 1))) return "FAIL";
        if (v2.calls.compact[0].sessionID !== "ses-qa-103-v2a") {
          console.log(`  FAIL: v2 compact greenlight should call session.compact with the session's id, got ${JSON.stringify(v2.calls.compact)}`);
          return "FAIL";
        }

        v2.setAssistant("Nothing pending.\nTHATCH_EXIT_READY");
        await exitCmd.execute({ sessionID: "ses-qa-103-v2b" });
        await v2.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2b" } });
        if (!(await v2wait("v2 exit-tab-closed emit", () => v2.calls.emitted.some((e) => e.name === EXIT_TAB_CLOSED_EVENT)))) return "FAIL";
        const closed = v2.calls.emitted.find((e) => e.name === EXIT_TAB_CLOSED_EVENT)!;
        // TUI-only payload: the runtime records the session's watcher deaths
        // synchronously before the action, and the pump never translates
        // this event (a tab-closed-style payload would invite that).
        if (closed.data.sessionID !== "ses-qa-103-v2b") {
          console.log(`  FAIL: v2 exit greenlight should emit exit-tab-closed {sessionID}, got ${JSON.stringify(closed.data)}`);
          return "FAIL";
        }
      } finally {
        await disposeV2?.();
      }

      // Step 11: the older-SDK floor (no session.compact member) degrades
      // to a logged no-op, not a crash - the wrap-up checklist and flush
      // still ran.
      const v2floor = makeV2Harness(ctx.dir, { compact: false });
      let disposeFloor: (() => Promise<void>) | undefined;
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      try {
        disposeFloor = (await setupV2(v2floor.context as any)) as () => Promise<void>;
        const floorCmd = v2floor.commands.find((c) => c.name === "thatch/compact")!;
        v2floor.setAssistant("All clear.\nTHATCH_COMPACT_READY");
        await floorCmd.execute({ sessionID: "ses-qa-103-v2c" });
        await v2floor.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2c" } });
        if (!(await v2wait("floor wrap-up resolved", () => !wrapupArmed("ses-qa-103-v2c")))) return "FAIL";
        // The row delete happens BEFORE the token check, so the branch may
        // still be mid-flight at row-gone: settle before asserting the log.
        await new Promise((r) => setTimeout(r, 150));
        if (!errors.some((line) => line.includes("compaction trigger unavailable"))) {
          console.log(`  FAIL: v2 floor compact should degrade with a log, got ${JSON.stringify(errors)}`);
          return "FAIL";
        }
      } finally {
        console.error = originalError;
        process.env.XDG_CONFIG_HOME = prevXdg;
        process.env.THATCH_DB_PATH = prevDb;
        await disposeFloor?.();
      }

      // Step 12: a blocked wrap-up (no token) shows its toast over the
      // bridge on v2 - the TUI feedback channel for the "resolve the
      // items above" nudge.
      const v2blocked = makeV2Harness(ctx.dir, { compact: true });
      let disposeBlocked: (() => Promise<void>) | undefined;
      process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      try {
        disposeBlocked = (await setupV2(v2blocked.context as any)) as () => Promise<void>;
        const blockedCmd = v2blocked.commands.find((c) => c.name === "thatch/compact")!;
        v2blocked.setAssistant("Outstanding: the migration is half-applied.");
        await blockedCmd.execute({ sessionID: "ses-qa-103-v2d" });
        await v2blocked.queue({ type: "session.execution.succeeded", location: { directory: ctx.dir }, data: { sessionID: "ses-qa-103-v2d" } });
        if (!(await v2wait("blocked wrap-up resolved", () => !wrapupArmed("ses-qa-103-v2d")))) return "FAIL";
        // Find the toast by variant + command name, not by position: the
        // blocked path falls through to auto-register, which can emit its
        // own toast after it.
        if (
          !(await v2wait(
            "blocked toast emitted",
            () =>
              v2blocked.calls.emitted.some(
                (e) => e.name === TOAST_EVENT && e.data?.variant === "warning" && String(e.data?.message).includes("/thatch/compact"),
              ),
          ))
        ) {
          return "FAIL";
        }
        // The blocked path must not fire the completion action.
        if (v2blocked.calls.compact.length !== 0) {
          console.log(`  FAIL: blocked wrap-up must not call session.compact, got ${JSON.stringify(v2blocked.calls.compact)}`);
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
