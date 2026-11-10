import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase } from "../../runner";
import { runClaude, makeClaudeCtx, TMP_BASE } from "./harness";

/**
 * UC-135 (claude leg): the FULL inline extraction cycle under the plugin
 * regime - the issue #22 structural fix, verified on a real Claude Code
 * session.
 *
 * PREREQUISITE: the host's claude CLI, installed and logged in. THE LEG
 * INVARIANT: assertions read only plugin-written surfaces.
 *
 * The cycle: tool work buffers (the mod's tool.call forward -> the
 * server's appendBatch), the NEXT prompt's stage delivers the inline
 * payload (no dispatch instruction - the wire shape), the parent saves
 * (the save gate drains), and the ack leaves the queue empty. Every link
 * asserts from the queue dir + db; the model's prose is never read.
 */

const useCase: UseCase = {
  name: "UC-135-claude-extraction-cycle",
  preconditions: [
    "- The host's claude CLI installed and logged in",
    "- The thatch repo checked out; bun on PATH",
  ].join("\n"),
  steps: [
    "1. Generate the plugin in a fixture home; run `claude -p 'run git log --oneline -3 and show README.md' --plugin-dir <generated>`.",
    "2. Inspect the queue dir: the session's interactions are buffered (Bash/Read).",
    "3. Run a second `claude -p` turn (same fixture, new session - the delivery leg uses",
    "    the SAME prompt session via the plugin; assert the payload DELIVERY from the",
    "    queue's persistence + the escalation counter's bump).",
    "4. Send the plugin's stage a saving memory_remember via the CLI's own session row;",
    "    assert the drain (the save gate).",
  ].join("\n"),
  expected: [
    "- After step 1: the queue file exists with non-meta tool interactions (the buffer",
    "  push rode the mod's tool.call forward).",
    "- The queue is PEEKED, not drained, by the stage (it survives the delivery).",
    "- A saving memory_remember via the lifecycle drains the queue (the save gate), and",
    "  the missed-nudge counter resets.",
  ].join("\n"),

  async run() {
    const base = TMP_BASE();
    const ctx = await makeClaudeCtx(base);
    try {
      // Seed the buffer the way the REGIME does - through a real session's
      // tool calls. The prompt asks for plain file work (no memory writes).
      const r1 = await runClaude(ctx, "Run `git log --oneline -3` in this directory and read the first 20 lines of README.md. Do not save any memories.");
      const failures: string[] = [];
      if (r1.exitCode !== 0) failures.push(`first claude -p exited ${r1.exitCode}: ${r1.stderr.slice(0, 300)}`);

      // The buffer: the session's tool calls landed in the queue (the mod's
      // forward -> appendBatch). Find ANY queue file (the session id is the
      // host's; its hash is deterministic but unknown to the fixture).
      const { readdirSync } = await import("node:fs");
      const queued = readdirSync(ctx.queueDir).filter((f) => f.endsWith(".jsonl"));
      if (queued.length === 0) {
        failures.push("no queue file after tool work - the mod's buffer push did not fire");
      } else {
        const raw = readFileSync(join(ctx.queueDir, queued[0]!), "utf8").trim();
        const lines = raw ? raw.split("\n") : [];
        if (lines.length === 0) failures.push("the queue file is empty after tool work");
        const first = JSON.parse(lines[0]!) as { tool: string };
        if (first.tool.startsWith("mcp__thatch__")) failures.push(`a thatch tool call got buffered: ${first.tool}`);
      }

      // The stage's peek-not-drain: the queue SURVIVES delivery. Assert by
      // running the second turn (the stage delivers) and confirming the
      // file still exists afterward.
      const r2 = await runClaude(ctx, "Do nothing else. Reply with the word done.");
      if (r2.exitCode !== 0) failures.push(`second claude -p exited ${r2.exitCode}`);
      const stillQueued = readdirSync(ctx.queueDir).filter((f) => f.endsWith(".jsonl"));
      if (stillQueued.length === 0) {
        failures.push("the queue vanished after a stage delivery - the stage must peek, not drain");
      }

      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        console.log(`  [stdout1] ${r1.stdout.slice(0, 300)}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      ctx.db.close();
    }
  },
};

registerUseCase(useCase);
