import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { decodeResponse, type DaemonResponse } from "../../src/embed-daemon/protocol";
import { embedSocketPath } from "../../src/embed-daemon/client";
import { QUERY_PREFIX } from "../../src/embeddings";
import { bootStdioJsonRpcClient, type StdioJsonRpcClient } from "../helpers/stdio-client";

// The integration tier: REAL server and daemon processes over real stdio
// and sockets, on a temp DB, hermetic via THATCH_MODEL=mock (the
// deterministic-vector seam; no network, no ONNX). This is the share-and-
// fallback contract from docs/plans/embedding-daemon.md's testing strategy:
// two MCP servers on one DB resolve to ONE daemon (hello pid); killing the
// daemon leaves the servers serving via their local fallback; a fresh
// server spawns a new daemon.

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BIN = join(REPO_ROOT, "bin", "thatch");

function bootServer(env: Record<string, string>, args: string[] = []): StdioJsonRpcClient {
  return bootStdioJsonRpcClient([BIN, "mcp", ...args], env);
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
 * The daemon socket path, from the DB path. Every process - this test
 * and the spawned servers, whatever each inherits for TMPDIR - resolves
 * the same TMPDIR-independent base (embedCacheBase), so there is exactly
 * one candidate path; the old both-bases probe machinery existed because
 * the tmpdir()-based derivation could land on either side of the
 * subprocess boundary.
 */
function daemonSocketCandidates(dbPath: string): string[] {
  return [embedSocketPath(dbPath)];
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

const spawned: StdioJsonRpcClient[] = [];

afterEach(async () => {
  for (const s of spawned.splice(0)) await s.close().catch(() => {});
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
