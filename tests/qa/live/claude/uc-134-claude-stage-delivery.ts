import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-134 (claude leg): stage delivery - the plugin regime's core crossing.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only surfaces the plugin writes (debug log,
 * db, queue dir, files) - never the model's prose.
 *
 * Verifies from the plugin's side: the mod's prompt.submit fires per user
 * prompt, calls the bundled server's plugin_stage tool (the $.mcp.call
 * envelope pin, confirmed by a delivered nudge's server-side side
 * effects: the liveness stamp + the regime marker the setup wrote).
 */

const useCase: UseCase = {
  name: "UC-134-claude-stage-delivery",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin via the real setup (--plugin --global) in a fixture home.",
    "2. Run `claude -p 'What is the meaning of life?' --plugin-dir <generated>`.",
    "3. Inspect the plugin-written surfaces: the mod liveness stamp exists and is fresh",
    "    (the stage tool ran; the $.mcp.call envelope pin holds).",
  ].join("\n"),
  expected: [
    "- The regime marker sits beside the fixture db (setup ran).",
    "- The mod liveness stamp file exists with a timestamp from THIS run - the stage",
    "  tool executed through the mod's prompt.submit -> $.mcp.call crossing.",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      const result = await runClaude(ctx, "What is the meaning of life?");
      const failures: string[] = [];
      if (result.exitCode !== 0) {
        failures.push(`claude -p exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`);
      }
      // The regime marker: setup's own artifact (beside the db, durable form).
      if (!existsSync(join(base, "home", ".config", "thatch", "regime-claude"))) {
        failures.push("the regime marker is missing - setup did not run or wrote elsewhere");
      }
      // The liveness stamp: the stage tool's server-side side effect,
      // fresh from THIS run (the candidate bases: the env-resolved tmpdir
      // AND /tmp - the subprocess tmpdir trap the auto UCs document).
      const hash = createHash("sha256").update(ctx.dbPath).digest("hex").slice(0, 16);
      const candidates = [tmpdir(), "/tmp"].map((b) => join(b, `thatch-${hash}`, "mod-liveness"));
      const found = candidates.find((c) => {
        try {
          return Number(readFileSync(c, "utf8")) > Date.now() - 600_000;
        } catch {
          return false;
        }
      });
      if (!found) failures.push(`no fresh mod liveness stamp at: ${candidates.join(", ")}`);
      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        console.log(`  [stdout] ${result.stdout.slice(0, 400)}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      ctx.db.close();
    }
  },
};

registerUseCase(useCase);
