import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
    "2. Run `claude -p 'Use watch_command_create to watch for the command `test -f <fixture>/watch-marker` exiting 0; do not create that file. Then reply ok.' --plugin-dir <generated>`.",
    "    (The command must NOT be already-true: the tool runs it once at registration",
    "    as validation and REFUSES a condition that already exits a watched code -",
    "    `true` always exits 0, so it is refused by design.)",
    "3. Assert the registry's DB journal: a runtime_state row kind=watchers exists",
    "    (the registration rode the bundled server), with the session's mcp hash as",
    "    its sessionID.",
    "4. Create the marker file (the condition becomes true), then assert the drain:",
    "    the watcher's next cycle fires the command-watched event and the",
    "    notification is submitted (the watcher_pending journal row clears).",
  ].join("\n"),
  expected: [
    "- A runtime_state row (kind watchers) exists after the registration turn.",
    "- The registration survives (a `test -f` on an ABSENT file exits 1 - not yet",
    "  watched-done - so the tool accepts it).",
    "- The watcher fires within the first poll cycles after the marker appears and",
    "  the pending queue drains - the notification became a turn.",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const failures: string[] = [];
      const r = await runClaude(
        ctx,
        `Use the watch_command_create tool to create a command watcher for the command 'test -f ${join(ctx.base, "watch-marker")}' with expected exit code 0. Do NOT create that file yourself. Confirm by replying: registered. Do not save memories.`,
      );
      if (r.exitCode !== 0) failures.push(`claude -p exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);

      // The journal: the registration row (DB-backed durability contract).
      const all = ctx.db.runtimeStateAll();
      const watcherRow = all.find((row) => row.kind === "watchers" && Array.isArray(row.value) && (row.value as unknown[]).length > 0);
      if (!watcherRow) {
        failures.push("no runtime_state watchers row - the watch_create call did not reach the bundled server's registry");
      }

      // The condition becomes true: the watcher's next cycle fires.
      writeFileSync(join(ctx.base, "watch-marker"), "1");
      // The drain: within the poll cadence, the pending notification
      // submits (pending journal cleared).
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
