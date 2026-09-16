import { mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

// Mock @huggingface/transformers before src/index loads BgeEmbeddingModel
// (same pattern as tests/plugin.test.ts): hash-based vectors, no download.
// This is the only UC in the barrel that imports src/index, so this mock is
// the first resolution of the transformers module in the QA process.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async (text: string) => {
    const clean = text.startsWith(QUERY_PREFIX) ? text.slice(QUERY_PREFIX.length) : text;
    let h = 0;
    for (let i = 0; i < clean.length; i++) {
      h = ((h << 5) - h) + clean.charCodeAt(i);
      h |= 0;
    }
    h ^= 0x9e3779b9;
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h |= 0;
      vec[i] = h / 0x80000000;
    }
    return { data: vec };
  },
  // BgeEmbeddingModel's default factory sets env.cacheDir before building the
  // pipeline, so the mock must expose a writable env object (same contract as
  // tests/plugin.test.ts).
  env: {},
}));

import { server } from "../../../src/index";
import { installOpencodeCommands } from "../../../src/commands";

/**
 * UC-103: Wrap-up commands (/thatch/compact, /thatch/exit).
 *
 * Automatable: yes — drives the real plugin server() with a mock SDK client,
 * so the greenlight protocol is exercised end-to-end with no logic
 * replication. The TUI actions are asserted at the client boundary
 * (executeCommand / publish payloads), which is as far as a headless test
 * can go: the TUI-side rendering of those actions needs a live session
 * (manual verification).
 */

const useCase: UseCase = {
  name: "UC-103-wrapup-commands",
  preconditions: [
    "- The opencode plugin installed (src/index.ts server export)",
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
  ].join("\n"),
  expected: [
    "- The command files exist under the fixture's opencode/command/thatch/ after plugin load, each carrying its token and a description frontmatter.",
    "- installOpencodeCommands returns an empty list when everything is current.",
    "- A trailing greenlight token triggers compact via executeCommand('session_compact') and exit via publish of tui.command.execute 'app.exit'.",
    "- A missing or non-trailing token never triggers; a warning toast fires instead.",
    "- session.deleted clears a pending wrap-up so a later idle cannot fire it.",
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

      return "PASS";
    } finally {
      hooks.dispose?.();
    }
  },
};

registerUseCase(useCase);
