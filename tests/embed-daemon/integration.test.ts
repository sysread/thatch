import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { decodeResponse, type DaemonResponse } from "../../src/embed-daemon/protocol";
import { QUERY_PREFIX } from "../../src/embeddings";

// The integration tier: REAL server and daemon processes over real stdio
// and sockets, on a temp DB, hermetic via THATCH_MODEL=mock (the
// deterministic-vector seam; no network, no ONNX). This is the share-and-
// fallback contract from docs/plans/embedding-daemon.md's testing strategy:
// two MCP servers on one DB resolve to ONE daemon (hello pid); killing the
// daemon leaves the servers serving via their local fallback; a fresh
// server spawns a new daemon.

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BIN = join(REPO_ROOT, "bin", "thatch");

interface SpawnedServer {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
  close: () => Promise<void>;
}

function bootServer(env: Record<string, string>, args: string[] = []): SpawnedServer {
  const proc = Bun.spawn([BIN, "mcp", ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idSeq = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const id = idSeq++;
    proc.stdin.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    proc.stdin.flush();
    const poll = async (): Promise<Record<string, any>> => {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server closed before answering ${method} (id ${id})`);
      buf += dec.decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
      }
      return poll();
    };
    return poll();
  };
  return {
    proc,
    request,
    close: async () => {
      reader.cancel().catch(() => {});
      proc.kill();
      await proc.exited;
    },
  };
}

/** One hello probe against the daemon socket. */
function helloProbe(socketPath: string, timeoutMs = 500): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("hello probe timed out"));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolve(decodeResponse(buf.slice(0, nl)));
      } finally {
        socket.destroy();
      }
    });
    socket.once("connect", () => socket.write(Buffer.from(JSON.stringify({ method: "hello" }) + "\n")));
    socket.connect(socketPath);
  });
}

/**
 * The daemon socket path, computed for BOTH tmpdir bases: the spawned
 * server's env drops TMPDIR while this test process resolves /var/folders,
 * so the daemon's cache-dir derivation can land on either base (the same
 * subprocess-boundary trap uc-142 documents for the liveness stamp).
 */
function daemonSocketCandidates(dbPath: string): string[] {
  // Inline the hash derivation (client.ts's own shape).
  const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return [...new Set([tmpdir(), "/tmp"].map((base) => join(base, `thatch-${hash}`, "embed.sock"))) ];
}

async function probeAnySocket(dbPath: string, timeoutMs = 500): Promise<DaemonResponse | null> {
  for (const path of daemonSocketCandidates(dbPath)) {
    try {
      return await helloProbe(path, timeoutMs);
    } catch {
      // try the next base
    }
  }
  return null;
}

const spawned: SpawnedServer[] = [];
const daemons: Bun.Subprocess<"ignore", "ignore", "ignore">[] = [];

afterEach(async () => {
  for (const s of spawned.splice(0)) await s.close().catch(() => {});
  for (const d of daemons.splice(0)) {
    try { d.kill(); } catch { /* already dead */ }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const dirs: string[] = [];

function sandbox(): { dir: string; env: Record<string, string>; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "thatch-embed-integration-"));
  dirs.push(dir);
  const env: Record<string, string> = {
    THATCH_DB_PATH: join(dir, "thatch.db"),
    THATCH_QUEUE_DIR: join(dir, "queue"),
    THATCH_MODEL: "mock",
    THATCH_NO_NOTIFY: "1",
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CACHE_HOME: join(dir, "cache"),
    HOME: join(dir, "home"),
    CLAUDE_PROJECT_DIR: join(dir, "project"),
    PATH: process.env.PATH ?? "",
  };
  return { dir, env, dbPath: join(dir, "thatch.db") };
}

async function waitForDaemon(dbPath: string, timeoutMs = 15000): Promise<Extract<DaemonResponse, { ok: true }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await probeAnySocket(dbPath, 300);
    if (res?.ok) return res;
    if (Date.now() > deadline) throw new Error("the embed daemon never answered hello");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("embed daemon integration (real processes, mock model)", () => {
  test("two servers on one DB share one daemon; daemon death falls back; a fresh server respawns", async () => {
    const { env, dbPath } = sandbox();

    // Server 1: the first standalone session - its startup behavior seed
    // embeds, which is the de-facto resolution point (it spawns the daemon).
    const server1 = bootServer(env);
    spawned.push(server1);
    await server1.request("initialize", {});

    const hello1 = await waitForDaemon(dbPath);
    expect(hello1.model).toBe("mock");
    const firstPid = hello1.pid;

    // Server 2: the second session on the same DB must SHARE the daemon.
    const server2 = bootServer(env);
    spawned.push(server2);
    await server2.request("initialize", {});
    const remember2 = await server2.request("tools/call", {
      name: "memory_remember",
      arguments: { content: QUERY_PREFIX + "the resolver pins the daemon", label: "shared-daemon" },
    });
    expect(remember2.result?.isError).toBe(false);

    // Still one daemon: the same pid answers (a second spawn would lose the
    // sqlite lock race anyway; the pid pin is the observable).
    const hello2 = await waitForDaemon(dbPath);
    expect(hello2.pid).toBe(firstPid);

    // Cross-process vector agreement: server 2 stored via the daemon;
    // server 1 recalls the same text through the SAME daemon vectors.
    const recall1 = await server1.request("tools/call", {
      name: "memory_recall",
      arguments: { query: "the resolver pins the daemon" },
    });
    expect(recall1.result?.isError).toBe(false);
    const recallText1 = recall1.result?.content?.[0]?.text ?? "";
    expect(recallText1).toContain("shared-daemon");

    // Kill the daemon: both servers keep serving via their LOCAL fallback.
    process.kill(firstPid, "SIGTERM");
    // The socket dies asynchronously; wait for it to stop answering.
    const deadDeadline = Date.now() + 10_000;
    for (;;) {
      const res = await probeAnySocket(dbPath, 200).catch(() => null);
      if (res === null) break;
      if (Date.now() > deadDeadline) throw new Error("the daemon socket never stopped answering");
      await new Promise((r) => setTimeout(r, 100));
    }
    const rememberAfterDeath = await server2.request("tools/call", {
      name: "memory_remember",
      arguments: { content: QUERY_PREFIX + "the fallback keeps the session alive", label: "fallback-works" },
    });
    expect(rememberAfterDeath.result?.isError).toBe(false);

    // A fresh server spawns a NEW daemon (recovery does not respawn in the
    // surviving sessions - the new session is what brings one back).
    const server3 = bootServer(env);
    spawned.push(server3);
    await server3.request("initialize", {});
    const hello3 = await waitForDaemon(dbPath, 20000);
    expect(hello3.pid).not.toBe(firstPid);

    // No orphaned daemon left behind: the test's own cleanup.
    try { process.kill(hello3.pid, "SIGTERM"); } catch { /* already dead */ }
  }, 120000);
});
