import { join } from "node:path";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-151: the shared embed daemon - one daemon per DB path, every MCP
 * session a client, fallback on death (docs/plans/embedding-daemon.md).
 *
 * Automatable and hermetic: THATCH_MODEL=mock gives every tier
 * deterministic vectors offline. The harness forces THATCH_EMBED_DAEMON=off
 * in the fixture env; this use case opts in on its own env copy
 * (set-and-restore on the object it passes to subprocesses - the test
 * process itself never changes).
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

    /** A JSON-RPC client over one spawned server (one shared stdout reader). */
    const client = (proc: { stdin: { write(b: Uint8Array): unknown; flush(): void }; stdout: ReadableStream<Uint8Array> }) => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let idSeq = 1;
      return {
        request(method: string, params: Record<string, unknown>, timeoutMs = 20000): Promise<Record<string, any>> {
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

    /** Hello handshake against the daemon socket, on every tmpdir base
     *  (the spawned server's env drops TMPDIR - see uc-142's note). */
    const helloAny = async (timeoutMs = 300): Promise<{ ok: true; model: string; version: string; pid: number } | null> => {
      const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
      for (const base of [...new Set([tmpdir(), "/tmp"])]) {
        const sockPath = join(base, `thatch-${hash}`, "embed.sock");
        if (!existsSync(sockPath)) continue;
        const res = await new Promise<{ ok: true; model: string; version: string; pid: number } | null>((resolve) => {
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
        if (res) return res;
      }
      return null;
    };

    const waitForDaemon = async (timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = await helloAny(300);
        if (res) return res;
        if (Date.now() > deadline) throw new Error("the embed daemon never answered hello");
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const pids = new Set<number>();
    const killDaemon = (pid: number) => {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      pids.delete(pid);
    };

    try {
      // Step 1: server A's startup seed spawns the daemon.
      const serverA = Bun.spawn([bin, "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const clientA = client(serverA);
      await clientA.request("initialize", {});
      const helloA = await waitForDaemon();
      if (helloA.model !== "mock") failures.push(`the daemon serves "${helloA.model}", expected "mock"`);
      pids.add(helloA.pid);

      // Step 2: server B shares the SAME daemon; its remember rides the
      // daemon's vectors.
      const serverB = Bun.spawn([bin, "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const clientB = client(serverB);
      await clientB.request("initialize", {});
      const remember = await clientB.request("tools/call", {
        name: "memory_remember",
        arguments: { content: "Represent this sentence for searching relevant passages: the daemon shares its vectors", label: "shared-daemon-memory" },
      });
      const rememberText = remember.result?.content?.[0]?.text ?? "";
      if (remember.result?.isError || !rememberText.includes("[saved]")) {
        failures.push(`memory_remember failed through the daemon: ${rememberText.slice(0, 160)}`);
      }
      const helloB = await waitForDaemon();
      if (helloB.pid !== helloA.pid) {
        failures.push(`two daemons for one DB path (pids ${helloA.pid} and ${helloB.pid})`);
      }
      // Cross-session vector agreement: recall on server A finds what
      // server B stored through the same daemon.
      const recall = await clientA.request("tools/call", {
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
      const fallbackRemember = await clientB.request("tools/call", {
        name: "memory_remember",
        arguments: { content: "Represent this sentence for searching relevant passages: the fallback keeps sessions alive", label: "fallback-memory" },
      });
      const fallbackText = fallbackRemember.result?.content?.[0]?.text ?? "";
      if (fallbackRemember.result?.isError || !fallbackText.includes("[saved]")) {
        failures.push(`memory_remember failed after daemon death (no fallback): ${fallbackText.slice(0, 160)}`);
      }

      // Step 4: a fresh session respawns a NEW daemon.
      const serverC = Bun.spawn([bin, "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const clientC = client(serverC);
      await clientC.request("initialize", {});
      const helloC = await waitForDaemon(20000);
      if (helloC.pid === helloA.pid) failures.push("the respawned daemon has the dead daemon's pid");
      pids.add(helloC.pid);

      clientA.close();
      clientB.close();
      clientC.close();
      serverA.kill();
      serverB.kill();
      serverC.kill();
    } finally {
      // No orphaned daemon leaves this use case.
      for (const pid of pids) killDaemon(pid);
    }

    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      return "FAIL";
    }
    return "PASS";
  },
};

registerUseCase(useCase);
