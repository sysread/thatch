import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-136 (claude leg): the escalation ladder under the plugin regime.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only plugin-written surfaces.
 *
 * The missed-nudge counter (missedCount) is server state: consecutive
 * prompts without a save or ack bump it, and the stage's delivered nudge
 * escalates tone (escalationLevel: 0 polite, >= 2 insistent, >= 3
 * shouting - identifiers verbatim). Assert from the counter + the queue's
 * persistence, NOT from reading the model's context: the counter is the
 * state the tone derives from.
 */

const useCase: UseCase = {
  name: "UC-136-claude-escalation",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin in a fixture home; pre-seed the queue via the CLI",
    "    (`thatch buffer-batch`, session hashed from a KNOWN host id - no session needed:",
    "    the stage bumps whatever it finds).",
    "2. Run three `claude -p` turns instructing the model to NOT save memories.",
    "3. Assert the missed-nudge counter reached 3 (the state under the shouting tier)",
    "    and the queue still exists (delivery never drains).",
  ].join("\n"),
  expected: [
    "- The missed-nudge counter file (cache dir, beside the queue contract) shows the",
    "  count climbing per ignored prompt: 1 -> 2 -> 3.",
    "- The queue file persists after every delivery (peek-not-drain at every level).",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const failures: string[] = [];
      // Seed via the CLI the way the auto UCs do (the contract is the same
      // file the mod's push writes).
      const seed = Bun.spawnSync(
        ["bash", "-c", `echo '{"session_id":"uc136-host","tool_calls":[{"tool_name":"Read","tool_input":{"path":"/a"},"tool_response":"a"}]}' | bun ${ctx.dir}/../../../../bin/thatch buffer-batch`],
        { cwd: ctx.dir, env: ctx.env, stdout: "pipe", stderr: "pipe" },
      );
      if (seed.exitCode !== 0) failures.push(`buffer-batch seed failed: ${seed.stderr.toString().slice(0, 200)}`);

      // Three ignored nudges: each prompt tells the model not to save.
      for (let i = 0; i < 3; i++) {
        const r = await runClaude(ctx, "Do not save any memories. Just reply: ok.");
        if (r.exitCode !== 0) failures.push(`turn ${i + 1} exited ${r.exitCode}`);
      }

      // The counter's state (the tier's input): getMissedCount's file.
      const { getMissedCount } = await import("../../../../src/extract-queue");
      const missed = getMissedCount("uc136-host");
      if (missed < 3) {
        failures.push(`missedCount is ${missed}, expected >= 3 after three ignored nudges`);
      }
      // The queue survives (peek-not-drain at every escalation level).
      const { readdirSync } = await import("node:fs");
      if (readdirSync(ctx.queueDir).filter((f) => f.endsWith(".jsonl")).length === 0) {
        failures.push("the queue was drained by deliveries - peek-not-drain violated");
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
