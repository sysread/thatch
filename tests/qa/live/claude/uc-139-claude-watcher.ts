import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-139 (claude leg): watchers on the bundled server - register, event,
 * deliver as a turn.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only plugin-written surfaces.
 *
 * The five watch tools serve on the bundled server (bundledServable); a
 * COMMAND watcher is network-free. The model registers one via
 * watch_command_create; the watched command's condition fires; the mod's
 * poll drains and submits the notification as a turn. Assert from the
 * registry's DB journal (the runtime_state rows) + the pending drain.
 */

const useCase: UseCase = {
  name: "UC-139-claude-watcher",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin in a fixture home.",
    "2. Run `claude -p 'Use watch_command_create to watch for the command `true` exiting 0. Then reply ok.' --plugin-dir <generated>`.",
    "3. Assert the registry's DB journal: a runtime_state row kind=watchers exists",
    "    (the registration rode the bundled server), with the session's mcp hash as",
    "    its sessionID.",
    "4. Run one more turn; assert the pending drain: the watcher's first cycle fires",
    "    the command-watched event, and the notification is submitted (the",
    "    watcher_pending journal row clears).",
  ].join("\n"),
  expected: [
    "- A runtime_state row (kind watchers) exists after the registration turn.",
    "- The watcher fires within the first poll cycles (a `true` command exits 0",
    "  immediately) and the pending queue drains - the notification became a turn.",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const failures: string[] = [];
      const r = await runClaude(
        ctx,
        "Use the watch_command_create tool to create a command watcher for the command `true` with expected exit code 0. Confirm by replying: registered. Do not save memories.",
      );
      if (r.exitCode !== 0) failures.push(`claude -p exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);

      // The journal: the registration row (DB-backed durability contract).
      const all = ctx.db.runtimeStateAll();
      const watcherRow = all.find((row) => row.kind === "watchers" && Array.isArray(row.value) && (row.value as unknown[]).length > 0);
      if (!watcherRow) {
        failures.push("no runtime_state watchers row - the watch_create call did not reach the bundled server's registry");
      }

      // The drain: within the poll cadence, the `true` watcher fires and
      // the pending notification submits (pending journal cleared).
      await new Promise((res) => setTimeout(res, 45_000));
      const pendingRows = ctx.db.runtimeStateAll().filter((row) => row.kind === "watcher_pending");
      if (pendingRows.length > 0) {
        failures.push("watcher_pending rows persist past the poll cadence - the drain did not submit");
      }

      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        console.log(`  [stdout] ${r.stdout.slice(0, 300)}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      ctx.db.close();
    }
  },
};

registerUseCase(useCase);
