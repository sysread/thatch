import { $ } from "bun";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-142: the plugin regime's bundled server - stage tool + disabled-mod
 * warning (docs/plans/claude-code-holistic-integration.md, Step A).
 *
 * Automatable: the bundled server is `thatch mcp --bundled` - same stdio
 * JSON-RPC contract as the standalone server, minus the standalone-only
 * machinery (sideband, version file, auto-refresh, seeding) and plus the
 * plugin_stage tool the mod calls per prompt. The disabled-mod warning
 * (a stale mod liveness stamp prepended to the first tools/call response)
 * is exercised by stamping an old liveness file directly.
 */

const useCase: UseCase = {
  name: "UC-142-plugin-stage-server",
  preconditions: [
    "- No live host needed: the bundled server is a stdio JSON-RPC process on an isolated THATCH_DB_PATH",
  ].join("\n"),
  steps: [
    "1. Seed the extraction queue for a session, then spawn `thatch mcp --bundled`.",
    "2. tools/list: plugin_stage IS listed; call it with the queued session's id -",
    "   the response text is the inline extraction nudge, and the mod liveness",
    "   file is stamped.",
    "3. Stamp the liveness file OLD, start a fresh server, and make any",
    "   tools/call - the response is prepended with the disabled-mod warning.",
  ].join("\n"),
  expected: [
    "- The bundled server lists plugin_stage (standalone servers do not -",
    "  pinned in tests/mcp.test.ts).",
    "- The stage response carries the inline nudge: the fact-extractor",
    "  instruction, the bare ack contract (no session id - the bundled",
    "  server resolves the acking session through its raw-id anchor), the",
    "  payload JSON, and no dispatch wording; the liveness stamp file",
    "  exists afterward.",
    "- With a stale liveness stamp, the FIRST tools/call response is",
    "  prepended with the plugin-not-delivering warning, exactly once.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env, THATCH_MODEL: "mock" };
    const failures: string[] = [];
    const sessionID = "uc133-lane";

    const seed = await $`echo ${JSON.stringify({ session_id: sessionID, tool_calls: [{ tool_name: "Read", tool_input: { file_path: "/a" }, tool_response: "a" }] })} | ${bin} buffer-batch`.env(env).quiet().nothrow();
    if (seed.exitCode !== 0) failures.push("buffer-batch seed failed");

    /** A JSON-RPC client over one spawned server: ONE stdout reader shared
     *  by every call (a stream re-getReader per call locks up after the
     *  first), reading until the response with the sent id arrives. */
    const client = (proc: { stdin: { write(b: Uint8Array): unknown; flush(): void }; stdout: ReadableStream<Uint8Array> }) => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let idSeq = 1;
      return {
        request(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, any>> {
          const id = idSeq++;
          proc.stdin.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
          proc.stdin.flush();
          const deadline = Date.now() + timeoutMs;
          const poll = async (): Promise<Record<string, any>> => {
            if (Date.now() > deadline) { reader.cancel().catch(() => {}); failures.push(`timeout waiting for ${method} (id ${id})`); return {}; }
            const { value, done } = await reader.read();
            if (done) { failures.push(`server closed before answering ${method} (id ${id})`); return {}; }
            buf += dec.decode(value);
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.id === id) return msg;
              } catch { /* not JSON - skip */ }
            }
            return poll();
          };
          return poll();
        },
        close() {
          reader.cancel().catch(() => {});
        },
      };
    };

    // Step 1+2: the bundled server serves plugin_stage and stamps liveness.
    const proc = Bun.spawn([bin, "mcp", "--bundled"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    try {
      const c = client(proc);
      await c.request("initialize", {});
      const list = await c.request("tools/list", {});
      const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
      if (!names.includes("plugin_stage")) failures.push(`bundled tools/list lacks plugin_stage (has ${names.length} tools)`);
      const stage = await c.request("tools/call", { name: "plugin_stage", arguments: { prompt: "What is the meaning of life?", session_id: sessionID } });
      const text = stage.result?.content?.[0]?.text ?? "";
      // The 2026-11-13 corrupted-id fix: the stage nudge teaches the BARE
      // ack (the bundled server resolves the acking session through its
      // raw-id anchor), so the raw session id must not appear in the ack
      // clause at all.
      if (!text.includes("fact-extractor") || !text.includes('"interactions"') || !text.includes("no session id needed")) {
        failures.push(`stage response missing the inline nudge shape: ${text.slice(0, 160)}`);
      }
      if (text.includes(`session_id "${sessionID}"`)) {
        failures.push("stage response must not teach a session id to copy");
      }
      if (text.includes("Spawn a background sub-agent") || text.includes("get_extraction_payload")) {
        failures.push("stage response must not dispatch or name a fetch tool");
      }
      // The liveness stamp: written by the stage call, under the cache dir
      // derived from the db path - stamped to EITHER tmpdir base (the
      // subprocess-boundary trap; see block 2's comment).
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update(ctx.env.THATCH_DB_PATH).digest("hex").slice(0, 16);
      const stamped = [tmpdir(), "/tmp"].some((base) => existsSync(join(base, `thatch-${hash}`, "mod-liveness")));
      if (!stamped) failures.push("the stage call did not stamp the mod liveness file");
    } finally {
      proc.kill();
    }

    // Step 3: the disabled-mod warning - a stale liveness stamp prepends
    // the warning to the FIRST tools/call response, exactly once.
    const { createHash } = await import("node:crypto");
    // The liveness path is NOT stable across the env-replacing subprocess
    // boundary (the same trap uc-009's skew stamp documents): the spawned
    // server gets ctx.env (no TMPDIR -> /tmp) while this test process
    // resolves /var/folders. Stamp BOTH candidate bases.
    const livenessPaths = (dbPath: string) => {
      const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
      return [tmpdir(), "/tmp"].map((base) => join(base, `thatch-${hash}`, "mod-liveness"));
    };
    for (const p of livenessPaths(ctx.env.THATCH_DB_PATH)) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, String(Date.now() - 60 * 60 * 1000), "utf-8");
    }
    const proc2 = Bun.spawn([bin, "mcp", "--bundled"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // Collect stderr in the background (the server logs the warning there
    // when it fires); reading to EOF only completes after kill.
    const errChunks: string[] = [];
    const errDone = (async () => {
      try {
        const reader = proc2.stderr.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          errChunks.push(dec.decode(value));
        }
      } catch { /* killed mid-read */ }
    })();
    try {
      const c2 = client(proc2);
      await c2.request("initialize", {});
      const first = await c2.request("tools/call", { name: "plugin_stage", arguments: { prompt: "What is the meaning of life?", session_id: "uc133-empty" } });
      const firstText = first.result?.content?.[0]?.text ?? "";
      if (!firstText.includes("may not be delivering")) {
        failures.push(`stale-liveness warning missing on the first call: ${firstText.slice(0, 160)}`);
      }
      const second = await c2.request("tools/call", { name: "plugin_stage", arguments: { prompt: "again", session_id: "uc133-empty" } });
      const secondText = second.result?.content?.[0]?.text ?? "";
      if (secondText.includes("may not be delivering")) {
        failures.push("the disabled-mod warning must surface once, not on every call");
      }
    } finally {
      proc2.kill();
      await errDone;
      const errText = errChunks.join("");
      if (errText) console.log(`  [debug] proc2 stderr: ${errText.slice(0, 400)}`);
    }

    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
