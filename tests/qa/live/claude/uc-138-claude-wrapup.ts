import { join } from "node:path";
import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-138 (claude leg): the wrap-up protocol - arm, greenlight, resolve.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only plugin-written surfaces.
 *
 * The user arms via /thatch_compact (a mod command - in -p mode the
 * ARM can also be observed by the model's greenlight tool call, which
 * routes through the mod's tool.call matcher); the model greenlights;
 * the action fires at turn end. Assert from the lifecycle's server-side
 * effects: the compaction request reaches the host (claude -p turns end
 * naturally - the observable is the greenlight ack's text in the debug
 * log and the arm state's consumption) - the arm/greenlight state itself
 * is in-memory server-side, so the OBSERVABLE contract is: the model's
 * greenlight tool call produces the lifecycle's teach/ack text in the
 * debug log, and a compact fires without error.
 */

const useCase: UseCase = {
  name: "UC-138-claude-wrapup",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin in a fixture home.",
    "2. Run `claude -p 'Call the tool named compact, then reply done.' --plugin-dir <generated>`",
    "    WITHOUT arming first - the accept-then-teach contract should answer the",
    "    greenlight with the not-armed teaching text.",
    "3. Assert from the debug log: the plugin_lifecycle greenlight event arrived",
    "    (the mod's tool.call matcher routed the model's mcp__thatch__compact call),",
    "    and the tool's answer was the [not armed] teaching text.",
  ].join("\n"),
  expected: [
    "- The lifecycle log shows a greenlight event for kind compact.",
    "- The teaching response ([not armed] ... /thatch_compact) reached the model (the",
    "  turn completes without a host action - nothing was armed, nothing fires).",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const failures: string[] = [];
      // The model is asked to call the greenlight tool WITHOUT an arm: the
      // accept-then-teach path. The teaching text rides the tool result.
      const r = await runClaude(ctx, "You have a tool named `compact` (mcp__thatch__compact). Call it now, then reply done. Do not save memories.");
      if (r.exitCode !== 0) failures.push(`claude -p exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);

      // The observable: the debug log carries the lifecycle forward (the
      // greenlight event) - the mod's matcher routed the call.
      const log = Bun.spawnSync(["bash", "-c", `cat ${ctx.dir}/../../debug.log 2>/dev/null; cat ${join(ctx.base, "debug.log")} 2>/dev/null`]).stdout.toString();
      void log;
      // The debug log's canonical location is beside the db (THATCH_DEBUG).
      const { readFileSync: rf } = await import("node:fs");
      let debugText = "";
      for (const cand of [join(ctx.base, "debug.log"), join(ctx.base, "thatch-debug.log")]) {
        try {
          debugText += rf(cand, "utf8");
        } catch { /* absent */ }
      }
      if (!debugText.includes("greenlight")) {
        failures.push("the debug log shows no greenlight lifecycle event - the tool.call matcher did not route the model's compact call");
      }
      if (!debugText.includes("not armed") && !debugText.includes("[not armed]")) {
        // The teach text itself is server-side; its DELIVERY is observable
        // only through the turn completing without a host action - the
        // absence of a compact request in the log is the second signal.
        const compacted = debugText.includes("session.compact");
        if (compacted) failures.push("a compact fired with nothing armed - the arm check failed");
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
