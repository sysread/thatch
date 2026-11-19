import { join, basename } from "node:path";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { bootStdioJsonRpcClient, type StdioJsonRpcClient } from "../../helpers/stdio-client";
import { embedCacheDir } from "../../../src/embed-daemon/client";
import { mockEmbeddingVector, QUERY_PREFIX } from "../../../src/embeddings";
import type { HelloResponse } from "../../../src/embed-daemon/protocol";

/**
 * UC-151: the shared embed daemon - one daemon per DB path, every MCP
 * session a client, fallback on death (docs/plans/embedding-daemon.md).
 *
 * Automatable and hermetic: THATCH_MODEL=mock gives every tier
 * deterministic vectors offline. The harness forces THATCH_EMBED_DAEMON=off
 * in the fixture env; this use case opts in on its own env copy passed to
 * subprocesses - the shared fixture env and the test process never change.
 */

const useCase: UseCase = {
  name: "UC-151-embed-daemon-share-fallback",
  preconditions: [
    "- No live host needed: the servers are stdio JSON-RPC processes on an isolated THATCH_DB_PATH",
    "- The fixture env forces THATCH_EMBED_DAEMON=off; this UC opts in on its own env copy",
  ].join("\n"),
  steps: [
    "1. Spawn server A (`thatch mcp`, mock model); its startup seed embeds,",
    "   which spawns the daemon. Probe the socket with a hello handshake:",
    "   serving, with a pid.",
    "2. Spawn server B on the SAME db; remember a memory. Probe hello again:",
    "   the SAME pid (one daemon per DB path). Recall from server A finds",
    "   what server B stored (both ride the same daemon vectors).",
    "3. SIGTERM the daemon. Server B remembers again - still succeeds (the",
    "   per-embed fallback to the local model).",
    "4. Spawn server C: a NEW daemon appears (a fresh session respawns).",
  ].join("\n"),
  expected: [
    "- One daemon per DB path: hello pids agree across servers A and B.",
    "- Cross-session vector agreement: memory_recall on server A surfaces",
    "  the memory server B stored (deterministic mock vectors, same daemon).",
    "- Daemon death never fails a session: memory_remember still lands via",
    "  the local fallback.",
    "- A fresh session spawns a fresh daemon (different pid).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    // Opt IN to the daemon on this UC's env copy; the harness default is off.
    const env = { ...ctx.env, THATCH_EMBED_DAEMON: "on", THATCH_MODEL: "mock" };
    const dbPath = ctx.env.THATCH_DB_PATH;
    const failures: string[] = [];
    // Every spawned server is reaped in the finally (a mid-test throw - a
    // waitForDaemon timeout included - must not orphan one), along with
    // every daemon pid seen and the daemon's cache dir.
    const servers: StdioJsonRpcClient[] = [];
    const pids = new Set<number>();
    const killDaemon = (pid: number) => {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      pids.delete(pid);
    };
    const cacheDirs = [...new Set([tmpdir(), "/tmp"].map((base) => join(base, basename(embedCacheDir(dbPath)))))];

    /** Hello handshake against the daemon socket, on every tmpdir base
     *  (the spawned server's env drops TMPDIR - see uc-142's note). The
     *  found socket path is remembered for the embed-level probe. */
    let socketPath: string | null = null;
    const helloAny = async (timeoutMs = 300): Promise<HelloResponse | null> => {
      for (const base of [...new Set([tmpdir(), "/tmp"])]) {
        const sockPath = join(base, basename(embedCacheDir(dbPath)), "embed.sock");
        if (!existsSync(sockPath)) continue;
        const res = await new Promise<HelloResponse | null>((resolve) => {
          const socket = new Socket();
          let buf = "";
          const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
          socket.once("error", () => { clearTimeout(timer); resolve(null); });
          socket.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(buf.slice(0, nl));
              resolve(parsed.ok ? parsed : null);
            } catch {
              resolve(null);
            } finally {
              socket.destroy();
            }
          });
          socket.once("connect", () => socket.write(Buffer.from(JSON.stringify({ method: "hello" }) + "\n")));
          socket.connect(sockPath);
        });
        if (res) {
          socketPath = sockPath;
          return res;
        }
      }
      return null;
    };

    /** One embed over a fresh daemon connection: hello, ack, embed. Every
     *  failure carries its reason - a timeout, a connect miss, a malformed
     *  line, and a daemon-answered error are different symptoms, and the
     *  failure message must say which happened. */
    type DaemonEmbedResult = { ok: true; vector: number[] } | { ok: false; reason: string };
    const daemonEmbed = (path: string | null, kind: "query" | "passage", text: string): Promise<DaemonEmbedResult> => {
      if (!path) return Promise.resolve({ ok: false, reason: "no daemon socket was found" });
      return new Promise((resolve) => {
        const socket = new Socket();
        let buf = "";
        let sawHello = false;
        const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, reason: "timed out" }); }, 2000);
        socket.once("error", (err) => { clearTimeout(timer); resolve({ ok: false, reason: `connect failed: ${err.message}` }); });
        socket.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            if (!sawHello) {
              sawHello = true;
              socket.write(Buffer.from(JSON.stringify({ method: "embed", kind, text }) + "\n"));
              continue;
            }
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(line);
              resolve(parsed.ok ? { ok: true, vector: parsed.vector } : { ok: false, reason: `the daemon answered with an error: ${parsed.error}` });
            } catch {
              resolve({ ok: false, reason: "malformed embed response" });
            } finally {
              socket.destroy();
            }
            return;
          }
        });
        socket.once("connect", () => socket.write(Buffer.from(JSON.stringify({ method: "hello" }) + "\n")));
        socket.connect(path);
      });
    };

    const waitForDaemon = async (timeoutMs = 20000): Promise<HelloResponse> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = await helloAny(300);
        if (res) return res;
        if (Date.now() > deadline) throw new Error("the embed daemon never answered hello");
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    try {
      // Step 1: server A's startup seed spawns the daemon.
      const serverA = bootStdioJsonRpcClient([bin, "mcp"], env, { report: (m) => failures.push(m) });
      servers.push(serverA);
      await serverA.request("initialize", {});
      const helloA = await waitForDaemon();
      if (helloA.model !== "mock") failures.push(`the daemon serves "${helloA.model}", expected "mock"`);
      pids.add(helloA.pid);

      // Step 2: server B shares the SAME daemon; its remember rides the
      // daemon's vectors.
      const serverB = bootStdioJsonRpcClient([bin, "mcp"], env, { report: (m) => failures.push(m) });
      servers.push(serverB);
      await serverB.request("initialize", {});
      const remember = await serverB.request("tools/call", {
        name: "memory_remember",
        arguments: { content: QUERY_PREFIX + "the daemon shares its vectors", label: "shared-daemon-memory" },
      });
      const rememberText = remember.result?.content?.[0]?.text ?? "";
      if (remember.result?.isError || !rememberText.includes("[saved]")) {
        failures.push(`memory_remember failed through the daemon: ${rememberText.slice(0, 160)}`);
      }
      const helloB = await waitForDaemon();
      if (helloB.pid !== helloA.pid) {
        failures.push(`two daemons for one DB path (pids ${helloA.pid} and ${helloB.pid})`);
      }
      // Exact-vector agreement across processes: an embed over the daemon
      // socket must equal the mock's deterministic derivation for the same
      // text (query prefix included) - the hermetic vector contract itself.
      const daemonVector = await daemonEmbed(socketPath, "query", "the daemon shares its vectors");
      const expected = mockEmbeddingVector(QUERY_PREFIX + "the daemon shares its vectors");
      if (!daemonVector.ok || [...daemonVector.vector].join() !== [...expected].join()) {
        failures.push(`the daemon's embed probe failed (${daemonVector.ok ? "vector mismatch" : daemonVector.reason})`);
      }
      // Recall keeps working end to end: server A's recall surfaces what
      // server B stored through the same daemon.
      const recall = await serverA.request("tools/call", {
        name: "memory_recall",
        arguments: { query: "the daemon shares its vectors" },
      });
      const recallText = recall.result?.content?.[0]?.text ?? "";
      if (recall.result?.isError || !recallText.includes("shared-daemon-memory")) {
        failures.push(`server A's recall missed server B's daemon-stored memory: ${recallText.slice(0, 160)}`);
      }

      // Step 3: daemon death - the sessions fall back and keep working.
      killDaemon(helloA.pid);
      const deadDeadline = Date.now() + 10000;
      for (;;) {
        const res = await helloAny(200);
        if (!res) break;
        if (Date.now() > deadDeadline) { failures.push("the daemon socket never stopped answering"); break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      const fallbackRemember = await serverB.request("tools/call", {
        name: "memory_remember",
        arguments: { content: QUERY_PREFIX + "the fallback keeps sessions alive", label: "fallback-memory" },
      });
      const fallbackText = fallbackRemember.result?.content?.[0]?.text ?? "";
      if (fallbackRemember.result?.isError || !fallbackText.includes("[saved]")) {
        failures.push(`memory_remember failed after daemon death (no fallback): ${fallbackText.slice(0, 160)}`);
      }

      // Step 4: a fresh session respawns a NEW daemon.
      const serverC = bootStdioJsonRpcClient([bin, "mcp"], env, { report: (m) => failures.push(m) });
      servers.push(serverC);
      await serverC.request("initialize", {});
      const helloC = await waitForDaemon(20000);
      if (helloC.pid === helloA.pid) failures.push("the respawned daemon has the dead daemon's pid");
      pids.add(helloC.pid);
    } finally {
      for (const s of servers.splice(0)) await s.close().catch(() => {});
      // No orphaned daemon leaves this use case.
      for (const pid of pids) killDaemon(pid);
      // The daemon's cache dir sits outside the runner's stale-root GC
      // families; this is its cleanup.
      for (const dir of cacheDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }

    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
