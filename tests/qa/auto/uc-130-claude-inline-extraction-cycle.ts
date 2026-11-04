import { $ } from "bun";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-130: Claude Code inline extraction cycle (docs/plans/claude-code-inline-extraction.md).
 *
 * Automatable: the whole cycle is deterministic CLI + MCP-server plumbing
 * with no LLM in the loop. This exercises the FULL inline shape end to end:
 * buffer-batch seeds the queue, flush-tools delivers the inline nudge with
 * the payload printed (no dispatch instruction, no fetch tool), the parent's
 * "processing" tool calls run in both orders (save-first re-feeds the
 * post-save tail; verify-first's later save consumes the unread verifying
 * interactions), and the parent's extraction_done ack — sent through the
 * REAL MCP server, since on the inline path the ack IS the drain — leaves
 * the queue empty.
 */

const useCase: UseCase = {
  name: "UC-130-claude-inline-extraction-cycle",
  preconditions: [
    "- A Claude Code setup (`PostToolBatch` -> `buffer-batch`, `UserPromptSubmit` -> `flush-tools`)",
    "- The thatch MCP server reachable (`thatch mcp`) on an isolated THATCH_DB_PATH",
  ].join("\n"),
  steps: [
    "1. Seed the queue via `buffer-batch` with real tool calls (session_id).",
    "2. Run `thatch flush-tools` (session_id) - the inline nudge should deliver",
    "   the payload with the session ID and NO dispatch instruction or fetch tool.",
    "3. Save-first order: `buffer-batch` a saving memory_remember FOLLOWED by a",
    "   verifying Read in the same batch, then flush again - the save-first",
    "   drain re-feeds only the post-save interaction.",
    "4. With the re-fed tail still queued, send `extraction_done` with the",
    "   session id through the REAL MCP server - on the inline path the ack IS",
    "   the drain of a delivered (re-delivered) payload.",
    "5. Verify-first order: buffer a verifying Bash, flush (it delivers), then a",
    "   LATER batch with a saving memory_remember - the save consumes the",
    "   unread verifying entry (the documented bounded loss). The next flush",
    "   (and the no-op ack on the empty queue) leave nothing queued.",
  ].join("\n"),
  expected: [
    "- Step 2's nudge carries the session ID and the payload JSON",
    "  (\"interactions\"), names the fact-extractor skill and the ack contract,",
    "  and contains NO \"Spawn a background sub-agent\" and NO",
    "  \"get_extraction_payload\".",
    "- The queue is peeked, not drained, by the nudge.",
    "- Step 3: the save-first batch drains the delivered payload and queues the",
    "  post-save Read; the next flush re-nudges for it (the re-feed tail).",
    "- Step 4: the later saving batch consumes the unread verifying entry",
    "  (save-first, then verify - the ordering the nudge instructs), and the",
    "  server-side `extraction_done` with the session id drains anything",
    "  remaining. The final flush carries NO extraction nudge.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env, THATCH_MODEL: "mock" };
    const sessionID = "uc130-inline";
    const failures: string[] = [];
    const flush = async (id: string) => {
      const input = JSON.stringify({ session_id: id, prompt: "What is the meaning of life?" });
      const res = await $`echo ${input} | ${bin} flush-tools`.env(env).quiet().nothrow();
      return { code: res.exitCode, out: res.stdout.toString() };
    };
    const batch = async (calls: unknown[]) => {
      const input = JSON.stringify({ session_id: sessionID, tool_calls: calls });
      const res = await $`echo ${input} | ${bin} buffer-batch`.env(env).quiet().nothrow();
      return res.exitCode === 0;
    };

    try {
      // Step 1: seed the queue with real work.
      const seeded = await batch([
        { tool_name: "Bash", tool_input: { command: "git log --oneline -3" }, tool_response: "a1b2c1 fix parser\nb2c3d2 add tests" },
        { tool_name: "Read", tool_input: { file_path: "/repo/src/parser.ts" }, tool_response: "export function parse() {}" },
      ]);
      if (!seeded) failures.push("buffer-batch seed failed");

      // Step 2: the inline nudge delivers the payload.
      const first = await flush(sessionID);
      if (first.code !== 0) failures.push("flush-tools exited non-zero on the seeded queue");
      if (!first.out.includes("fact-extractor") || !first.out.includes("queued tool interactions are ready")) {
        failures.push(`inline nudge missing process instructions: ${first.out.slice(0, 160)}`);
      }
      if (!first.out.includes(sessionID) || !first.out.includes('"interactions"')) {
        failures.push(`inline nudge missing session id or payload: ${first.out.slice(0, 160)}`);
      }
      if (first.out.includes("Spawn a background sub-agent") || first.out.includes("get_extraction_payload")) {
        failures.push("inline nudge must not dispatch or name a fetch tool");
      }

      // Step 3: save-first order - the save drains the delivered payload;
      // the verifying Read (same batch, after the save) re-feeds.
      await batch([
        { tool_name: "mcp__thatch__memory_remember", tool_input: { label: "uc130", content: "x" }, tool_response: "[saved] test/repo :: uc130" },
        { tool_name: "Read", tool_input: { file_path: "/repo/src/verify.ts" }, tool_response: "verified" },
      ]);
      const refeed = await flush(sessionID);
      if (!refeed.out.includes("1 queued tool interaction is ready")) {
        failures.push(`save-first re-feed expected 1 queued interaction: ${refeed.out.slice(0, 160)}`);
      }

      // The re-fed tail is still queued: the parent's ack through the REAL
      // MCP server IS the drain on the inline path - exercise it on a
      // NON-empty queue, the contract the whole path rests on. (Step 4 in
      // the steps list; the ack lands BEFORE the verify-first exercise,
      // which then runs against an empty queue and ends it empty.)
      const proc = Bun.spawn([bin, "mcp"], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      try {
        const enc = new TextEncoder();
        // initialize + the ack, then read until the ack's response arrives.
        proc.stdin.write(enc.encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"));
        proc.stdin.write(enc.encode(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "extraction_done", arguments: { session_id: sessionID } } }) + "\n"));
        proc.stdin.flush();
        const reader = proc.stdout.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let acked = false;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !acked) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === 2) {
                acked = true;
                const text = msg.result?.content?.[0]?.text ?? "";
                if (text !== "[acknowledged]") failures.push(`extraction_done ack unexpected: ${text}`);
              }
            } catch { /* not JSON - skip */ }
          }
        }
        reader.cancel().catch(() => {});
        if (!acked) failures.push("MCP server did not answer the extraction_done ack");
      } finally {
        proc.kill();
      }

      // Step 5 (verify-first order): a verifying Bash buffers, the flush
      // delivers it, and a LATER saving batch consumes it unread (the
      // documented bounded loss - the save drains the whole queue). The
      // ack on the now-empty queue is a no-op; the cycle ends empty.
      await batch([
        { tool_name: "Bash", tool_input: { command: "git status" }, tool_response: "clean" },
      ]);
      const preSave = await flush(sessionID);
      if (!preSave.out.includes("1 queued tool interaction is ready")) {
        failures.push(`verify-first tail expected 1 queued interaction: ${preSave.out.slice(0, 160)}`);
      }
      await batch([
        { tool_name: "mcp__thatch__memory_remember", tool_input: { label: "uc130-verify", content: "y" }, tool_response: "[saved] test/repo :: uc130-verify" },
      ]);
      const postSave = await flush(sessionID);
      if (postSave.out.includes("queued tool interaction")) {
        failures.push("verify-first: the later save should have consumed the unread verifying entry");
      }

      // The final flush carries no extraction nudge - the cycle ends empty.
      const final = await flush(sessionID);
      if (final.out.includes("queued tool interaction")) {
        failures.push(`queue should be drained after the ack: ${final.out.slice(0, 160)}`);
      }
      if (!final.out.includes("did you learn")) {
        failures.push(`post-ack flush should fall through to the write nudge: ${final.out.slice(0, 160)}`);
      }

      if (failures.length > 0) {
        for (const f of failures) console.log(`  FAIL: ${f}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      // Nothing to clean by hand: every artifact of this run (queue dir,
      // db, version file) lives under the runner's isolated env paths.
    }
  },
};

registerUseCase(useCase);
