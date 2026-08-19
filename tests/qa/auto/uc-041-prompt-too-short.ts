import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-041: Prompt too short.
 *
 * Automatable: the MIN_PROMPT_LEN gate is a deterministic length check in
 * bin/thatch flush-tools (line ~378). A prompt < 10 chars skips the sideband
 * tier and falls through to the write nudge. This test exercises both
 * short and long prompts via the CLI.
 */

const useCase: UseCase = {
  name: "UC-041-prompt-too-short",
  preconditions: [
    "- Thatch active in a session (opencode or MCP host)",
    "- At least one stored memory that would match a longer version of the short prompt",
  ].join("\n"),
  steps: [
    '1. Send a prompt shorter than 10 characters (e.g. "hi", "fix", "a").',
    '2. Send the same intent as a longer prompt (e.g. "fix the bug in the parser").',
    "3. Compare the nudges fired for each.",
  ].join("\n"),
  expected: [
    "- Step 1: no recall nudge, no prediction nudge, no behavior nudge. The prompt-length gate skips the sideband tier.",
    "- With an empty extraction queue, tier 1 is skipped, tier 2 is skipped (prompt too short), tier 3 fires: the write nudge.",
    "- Step 2: the longer prompt passes the length gate. The sideband tier is attempted (though with no server, it falls through to the write nudge).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env, THATCH_MODEL: "mock" };

    // Short prompt (< 10 chars): tier 2 is skipped, tier 3 fires.
    const shortInput = JSON.stringify({ session_id: "uc041-short", prompt: "hi" });
    const shortResult = await $`echo ${shortInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (shortResult.exitCode !== 0) {
      console.log("  FAIL: short prompt exited non-zero");
      return "FAIL";
    }
    const shortOut = shortResult.stdout.toString();
    if (!shortOut.includes("did you learn")) {
      console.log(`  FAIL: short prompt should produce write nudge, got: ${shortOut.slice(0, 200)}`);
      return "FAIL";
    }

    // Long prompt (>= 10 chars) with no sideband server: tier 2 attempts
    // sideband (fails), falls through to tier 3 write nudge.
    const longInput = JSON.stringify({ session_id: "uc041-long", prompt: "fix the bug in the parser" });
    const longResult = await $`echo ${longInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (longResult.exitCode !== 0) {
      console.log("  FAIL: long prompt exited non-zero");
      return "FAIL";
    }
    const longOut = longResult.stdout.toString();
    if (!longOut.includes("did you learn")) {
      console.log(`  FAIL: long prompt with no server should produce write nudge, got: ${longOut.slice(0, 200)}`);
      return "FAIL";
    }

    // Both produce the write nudge, but the code paths differ:
    // - Short: skips sideband entirely (promptText.length < 10)
    // - Long: attempts sideband (fails with null), then falls through
    // The observable result is the same (write nudge), which is correct:
    // the prompt-length gate prevents noisy embeddings, not the write nudge.

    // Edge case: exactly 10 chars should pass the gate (>= 10).
    const edgeInput = JSON.stringify({ session_id: "uc041-edge", prompt: "1234567890" });
    const edgeResult = await $`echo ${edgeInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (edgeResult.exitCode !== 0) {
      console.log("  FAIL: 10-char prompt exited non-zero");
      return "FAIL";
    }
    const edgeOut = edgeResult.stdout.toString();
    if (!edgeOut.includes("did you learn")) {
      console.log(`  FAIL: 10-char prompt should produce write nudge (no server), got: ${edgeOut.slice(0, 200)}`);
      return "FAIL";
    }

    // 9 chars should also produce write nudge (via the short path).
    const nineInput = JSON.stringify({ session_id: "uc041-nine", prompt: "123456789" });
    const nineResult = await $`echo ${nineInput} | ${bin} flush-tools`.env(env).quiet().nothrow();
    if (nineResult.exitCode !== 0) {
      console.log("  FAIL: 9-char prompt exited non-zero");
      return "FAIL";
    }
    const nineOut = nineResult.stdout.toString();
    if (!nineOut.includes("did you learn")) {
      console.log(`  FAIL: 9-char prompt should produce write nudge, got: ${nineOut.slice(0, 200)}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
