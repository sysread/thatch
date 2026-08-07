import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ExtractionPipeline, type ToolInteraction } from "../../../src/extraction";

/**
 * UC-016: Concurrent session isolation.
 *
 * Automatable: yes — the ExtractionPipeline is a pure in-memory ring buffer
 * keyed by session ID. We push interactions for two sessions and verify no
 * cross-contamination, that peek does not drain, that consume clears only the
 * target session, and that pending() reports correctly.
 */

function makeInteraction(sessionID: string, tool: string): ToolInteraction {
  return {
    tool,
    sessionID,
    args: { filePath: `/tmp/${tool}.txt` },
    title: `test-${tool}`,
    output: `output of ${tool}`,
  };
}

const useCase: UseCase = {
  name: "UC-016-concurrent-session-isolation",
  preconditions: [
    "- Two opencode sessions in the same repo (A and B)",
    "- (Separately) two Claude Code / Cursor hook processes with different session IDs",
  ].join("\n"),
  steps: [
    "**opencode (in-memory buffer)**",
    "1. In session A, run a non-thatch tool (the extraction ring buffer records it).",
    "2. In session B, send a message — `chat.message` runs.",
    "3. In session A, send a message — `chat.message` runs.",
    "",
    "**Claude Code / Cursor (file-backed queue)**",
    "4. Hook process for session A calls `buffer-tool`/`buffer-batch`.",
    "5. Hook process for session B calls `buffer-tool`/`buffer-batch`.",
    "6. `flush-tools` is invoked for session A, then for session B.",
    "",
    "**Sideband (shared warm model)**",
    "7. Both sessions' `flush-tools` connect to the same sideband socket.",
  ].join("\n"),
  expected: [
    "- **No cross-session bleed** in either path: session B's `chat.message` produces",
    "  no nudge from session A's buffered interaction; session B's message only sees",
    "  its own buffer. The in-memory `ExtractionPipeline` and the file-backed queue are",
    "  both keyed by session ID.",
    "- `flush-tools` for session A peeks only A's queue file (does not delete it); a",
    "  second flush for A returns the same content with an escalated missed-nudge",
    "  counter (the queue persists until a memory write or `extraction_done`). Session",
    "  B's queue file is untouched and is peeked on its own flush.",
    "- The sideband socket is **shared** (one warm MCP server) but **stateless per",
    "  query**: each request embeds a fresh prompt and returns its own matches. Two",
    "  concurrent match requests do not interfere.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const pipeline = new ExtractionPipeline();
    const failures: string[] = [];

    // Push two interactions for session A.
    pipeline.push(makeInteraction("sess-A", "read"));
    pipeline.push(makeInteraction("sess-A", "bash"));

    // Push one interaction for session B.
    pipeline.push(makeInteraction("sess-B", "grep"));

    // No cross-contamination: A has only A's interactions.
    const aPeek1 = pipeline.peek("sess-A");
    if (aPeek1.length !== 2) {
      failures.push(`session A should have 2 interactions, got ${aPeek1.length}`);
    } else {
      if (aPeek1[0].tool !== "read" || aPeek1[1].tool !== "bash") {
        failures.push("session A buffer has wrong tool order or content");
      }
    }

    const bPeek1 = pipeline.peek("sess-B");
    if (bPeek1.length !== 1) {
      failures.push(`session B should have 1 interaction, got ${bPeek1.length}`);
    } else {
      if (bPeek1[0].tool !== "grep") {
        failures.push("session B buffer has wrong tool");
      }
    }

    // Peek does not drain: a second peek of A returns the same content.
    const aPeek2 = pipeline.peek("sess-A");
    if (aPeek2.length !== 2) {
      failures.push("peek drained the buffer (second peek returned fewer entries)");
    }

    // Consume clears only the target session.
    pipeline.consume("sess-A");
    if (pipeline.peek("sess-A").length !== 0) {
      failures.push("consume did not clear session A");
    }
    if (pipeline.peek("sess-B").length !== 1) {
      failures.push("consume(A) affected session B");
    }

    // pending() reports correctly after consume.
    if (pipeline.pending("sess-A")) {
      failures.push("pending(A) should be false after consume");
    }
    if (!pipeline.pending("sess-B")) {
      failures.push("pending(B) should be true (still has interactions)");
    }

    // Pushing to A after consume starts fresh (no B contamination).
    pipeline.push(makeInteraction("sess-A", "write"));
    const aPeek3 = pipeline.peek("sess-A");
    if (aPeek3.length !== 1 || aPeek3[0].tool !== "write") {
      failures.push("session A did not start fresh after consume");
    }
    if (pipeline.peek("sess-B").length !== 1) {
      failures.push("pushing to A after consume affected session B");
    }

    if (failures.length > 0) {
      for (const f of failures) {
        console.log(`  FAIL: ${f}`);
      }
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
