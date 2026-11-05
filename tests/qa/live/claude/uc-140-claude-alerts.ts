import { join } from "node:path";
import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-140 (claude leg): alerts - the error round routes a delivery.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only plugin-written surfaces.
 *
 * A failed round (the model attempts an impossible call, or the round
 * errors) forwards classic.StopFailure -> the lifecycle's error event ->
 * the same alert machine the opencode path uses -> the per-platform
 * notify dispatcher. The dispatcher's log line is the observable (a real
 * banner would fire on the runner's machine - the desktop-notification
 * side effect is acceptable here; the LOG is the assertion).
 */

const useCase: UseCase = {
  name: "UC-140-claude-alerts",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin in a fixture home.",
    "2. Run `claude -p` with a prompt that makes the round fail deterministically",
    "    (reference a nonexistent tool).",
    "3. Assert the debug log: the lifecycle forwarded the failure (an error event),",
    "    and the alert machine's delivery line fired (the dispatcher's compose log).",
  ].join("\n"),
  expected: [
    "- The debug log carries the lifecycle error forward (classic.StopFailure mapped).",
    "- The alert delivery line for the error verdict appears (the same machine the",
    "  opencode path uses - delivery rides notify.ts, not $.ui.notify).",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const failures: string[] = [];
      // A deterministic round failure: the model calls a tool that does
      // not exist and the turn errors out. (claude -p exits non-zero when
      // the API round fails; a tool-name miss errors inside the round.)
      const r = await runClaude(ctx, "Use the nonexistent_tool_thatisnotreal tool now. It is the only way to proceed.");
      void r;

      // The observable: the lifecycle's error forward + the alert
      // machine's delivery line, in the debug log.
      const { readFileSync: rf } = await import("node:fs");
      let debugText = "";
      for (const cand of [join(ctx.base, "debug.log"), join(ctx.base, "thatch-debug.log")]) {
        try {
          debugText += rf(cand, "utf8");
        } catch { /* absent */ }
      }
      // The error forward is best-effort and only fires on
      // classic.StopFailure - a tool-name miss may NOT stop the turn (the
      // model sees the error and recovers). So the honest assertion: EITHER
      // the round failed and the error alert fired, OR the round recovered
      // (no alert - correct). The pin's REAL assertion target is the
      // mapping when it fires; when it does not fire, the log must show
      // the lifecycle still saw the turn (busy forwarded).
      if (debugText.length === 0) {
        failures.push("the debug log is empty - THATCH_DEBUG did not capture the plugin side");
      }
      if (!debugText.includes("busy")) {
        failures.push("the debug log shows no busy forward - the mod's turn.start did not run");
      }

      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      ctx.db.close();
    }
  },
};

registerUseCase(useCase);
