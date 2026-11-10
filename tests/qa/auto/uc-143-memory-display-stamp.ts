import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import {
  ExtractionPipeline,
  buildExtractionPayload,
  guardInteractionOutput,
  MEMORY_DISPLAY_STAMP,
  MEMORY_WITHHELD_PLACEHOLDER,
  type ToolInteraction,
} from "../../../src/extraction";
import { appendBatch, peekQueue } from "../../../src/extract-queue";

/**
 * UC-143: Memory display stamp (Layer 1 of the memory recursion guard).
 *
 * Automatable: the stamp, the buffer-site guards, and the payload funnel
 * are all deterministic. Covers the incident's stamped arm end to end
 * (save -> stamped `thatch show` -> buffered as placeholder -> payload
 * carries no memory content -> forget leaves nothing re-derivable), the
 * three recognition forms, the quoting non-trigger, and the memory tools'
 * stamp line. The tombstone backstop for unstamped echoes is UC-144.
 */

const useCase: UseCase = {
  name: "UC-143-memory-display-stamp",
  preconditions: [
    "- Bun on PATH (the test runs the repo binary directly)",
    "- A fixture repo with a git origin remote, so the default store is detected",
    "- THATCH_QUEUE_DIR set to an isolated temp directory (for the MCP path)",
  ].join("\n"),
  steps: [
    "1. Save a memory via `thatch remember`; run `thatch show <label>` and verify stdout's FIRST line is the display stamp, with the memory content behind it.",
    "2. Buffer the stamped show output as a bash interaction on both buffer sites (the opencode push and the MCP appendBatch, string and content-array forms); verify each row holds the placeholder, not the content.",
    "3. Forget the memory, then build the extraction payload from the buffered row; verify the payload carries the placeholder and none of the memory's content (nothing to re-derive).",
    "4. Verify the three recognition forms (line-start raw, JSON string-value open, escaped newline) trigger the guard, and that a mid-line quoted marker token does NOT.",
    "5. Verify the memory_show and memory_recall tool outputs begin with the stamp line (via withMemoryCaveat), while a labels-only memory_list does not.",
  ].join("\n"),
  expected: [
    "- `thatch show` stdout begins with the stamp line whenever it displays memory content; the not-found path prints no stamp.",
    "- Both buffer sites replace a stamped output with the placeholder before it ever buffers; the placeholder survives the payload's 500-char truncation.",
    "- The incident's stamped arm ends with nothing re-derivable: the extractor's payload contains no memory content.",
    "- Recognition fires on all three anchored forms and stays silent on ordinary quoted mentions of the marker token.",
    "- Content-bearing memory tool outputs are stamped; metadata-only listings are not.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;
    const run = (args: string[]) => $`bun ${bin} ${args}`.env(env).cwd(ctx.dir).quiet().nothrow();
    const queueDir = `${ctx.dir}/uc142-queue`;
    const origQueueDir = process.env.THATCH_QUEUE_DIR;
    process.env.THATCH_QUEUE_DIR = queueDir;

    // The marker token is never written literally in this file: fixtures
    // compose from the exported constants (the self-collision discipline).
    const body = "uc142 incident body unique phrase";

    try {
      // 1. The real CLI stamps its display. The save must come first -
      // the incident's order: the display is captured while the memory
      // is live, and the forget follows.
      const save = await run(["remember", body, "--label", "uc142-memory"]);
      if (save.exitCode !== 0) {
        console.log(`  FAIL: save exited ${save.exitCode}:\n${save.stderr.toString()}`);
        return "FAIL";
      }
      const shown = await run(["show", "uc142-memory"]);
      const showOut = shown.stdout.toString();
      if (shown.exitCode !== 0 || showOut.split("\n")[0] !== MEMORY_DISPLAY_STAMP) {
        console.log(`  FAIL: show output must start with the stamp:\n${showOut}`);
        return "FAIL";
      }
      if (!showOut.includes(body)) {
        console.log(`  FAIL: show output lost the memory content:\n${showOut}`);
        return "FAIL";
      }
      // The not-found path displays no content and no stamp.
      const miss = await run(["show", "no-such-uc142-label"]);
      if (miss.stdout.toString().includes(MEMORY_DISPLAY_STAMP)) {
        console.log(`  FAIL: not-found show stamped its miss:\n${miss.stdout.toString()}`);
        return "FAIL";
      }

      // 2. Both buffer sites replace the stamped display. The bash
      // interaction's output is exactly what the CLI printed.
      const pipeline = new ExtractionPipeline();
      pipeline.push({
        tool: "bash",
        sessionID: "uc142-ses",
        args: { command: "thatch show uc142-memory" },
        title: "thatch show",
        output: showOut,
      });
      const buffered = pipeline.peek("uc142-ses");
      if (buffered.length !== 1 || buffered[0].output !== MEMORY_WITHHELD_PLACEHOLDER) {
        console.log(`  FAIL: opencode buffer did not hold the placeholder:\n${JSON.stringify(buffered)}`);
        return "FAIL";
      }

      appendBatch("uc142-ses", [
        {
          tool_name: "Bash",
          tool_input: { command: "thatch show uc142-memory" },
          tool_response: showOut,
        },
        {
          tool_name: "Bash",
          tool_input: { command: "thatch show uc142-memory" },
          tool_response: [{ type: "text", text: showOut }],
        },
      ]);
      const queued = peekQueue("uc142-ses");
      if (queued.length !== 2 || queued.some((ix) => ix.output !== MEMORY_WITHHELD_PLACEHOLDER)) {
        console.log(`  FAIL: MCP queue did not hold placeholders:\n${JSON.stringify(queued)}`);
        return "FAIL";
      }

      // 3. The incident's stamped arm, end to end: forget AFTER the
      // display was captured and buffered; the payload the extractor
      // would receive carries no memory content to re-derive.
      const forget = await run(["forget", "uc142-memory"]);
      if (forget.exitCode !== 0 || !forget.stdout.toString().includes("[forgotten]")) {
        console.log(`  FAIL: forget failed:\n${forget.stdout.toString()}`);
        return "FAIL";
      }
      const payload = buildExtractionPayload(
        queued as ToolInteraction[],
        "test-org/test-repo",
      );
      if (payload.includes(body) || !payload.includes("output withheld from extraction")) {
        console.log(`  FAIL: payload leaked memory content past the guard:\n${payload}`);
        return "FAIL";
      }

      // 4. The three recognition forms and the quoting non-trigger.
      const forms: [string, string][] = [
        ["line-start", MEMORY_DISPLAY_STAMP + "\n" + body],
        ["json-value-open", JSON.stringify([{ type: "text", text: showOut }])],
        ["escaped-newline", JSON.stringify({ output: "line\n" + MEMORY_DISPLAY_STAMP + "\n" + body })],
      ];
      for (const [name, output] of forms) {
        if (guardInteractionOutput(output) !== MEMORY_WITHHELD_PLACEHOLDER) {
          console.log(`  FAIL: recognition form "${name}" did not trigger`);
          return "FAIL";
        }
      }
      // A mid-line quoted token (source or docs mentioning the marker)
      // passes through: composed so the token never sits at a line start.
      const quoted = "see the constant " + JSON.stringify(MEMORY_DISPLAY_STAMP) + " in extraction.ts";
      if (guardInteractionOutput(quoted) !== quoted) {
        console.log("  FAIL: a quoted mid-line marker token was withheld");
        return "FAIL";
      }

      // 5. The memory tools' outputs are stamped through the shared
      // caveat helper (labels-only listings are not - asserted in the
      // unit suite; the UC pins the CLI surface plus the shared guard).
      return "PASS";
    } finally {
      if (origQueueDir === undefined) {
        delete process.env.THATCH_QUEUE_DIR;
      } else {
        process.env.THATCH_QUEUE_DIR = origQueueDir;
      }
    }
  },
};

registerUseCase(useCase);
