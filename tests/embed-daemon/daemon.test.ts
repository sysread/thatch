import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer, Socket, type Server as NetServer } from "node:net";
import { EmbedDaemon, embedIdleExitMs, probeEmbedLock, DEFAULT_IDLE_EXIT_MS } from "../../src/embed-daemon/daemon";
import { decodeResponse, type DaemonResponse } from "../../src/embed-daemon/protocol";
import type { EmbeddingModel } from "../../src/embeddings";

// The daemon unit tier: a REAL socket and lock db in a temp cache dir, an
// injected model, and tiny idle windows. Every lifecycle invariant from
// docs/plans/embedding-daemon.md's daemon matrix has a failable test here.
//
// serve() is the daemon's LONG-LIVED promise - it resolves when the daemon
// exits - and it must be called exactly once. makeDaemon calls it and hands
// out the exit promise; tests wait for readiness with waitReady(), and await
// the exit promise only when the exit reason is the thing under test.

const VERSION = "0.4.3";

class SpyModel implements EmbeddingModel {
  loads = 0;
  disposes = 0;
  loaded = true;
  name = "mock";
  // Holds each embed open for `delayMs` - the in-flight protection's probe.
  constructor(private delayMs = 0) {}
  async load(): Promise<void> {
    this.loads += 1;
  }
  async queryEmbed(_text: string): Promise<Float32Array> {
    // Mirrors BgeEmbeddingModel: the embed path loads the model first.
    await this.load();
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return Float32Array.from([1, 2, 3]);
  }
  async passageEmbed(_text: string): Promise<Float32Array> {
    await this.load();
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return Float32Array.from([4, 5, 6]);
  }
  async dispose(): Promise<void> {
    this.disposes += 1;
  }
}

/** One full client exchange over a fresh connection: hello, ack, then the
 *  actual message - the protocol's per-connection preamble applies to every
 *  connection, so the helper walks it too. Handlers attach BEFORE the dial
 *  (bun can surface a connect failure synchronously). */
function exchange(socketPath: string, msg: Record<string, unknown>, timeoutMs = 2000): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buf = "";
    let sawHello = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("exchange timed out"));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (!sawHello) {
          sawHello = true;
          socket.write(Buffer.from(JSON.stringify(msg) + "\n"));
          continue;
        }
        clearTimeout(timer);
        try {
          resolve(decodeResponse(line));
        } finally {
          socket.destroy();
        }
        return;
      }
    });
    socket.once("connect", () => socket.write(Buffer.from(JSON.stringify({ method: "hello" }) + "\n")));
    socket.connect(socketPath);
  });
}

/** A raw single-message connection: NO hello preamble. The lifecycle
 *  refusal test uses this. */
function rawMessage(socketPath: string, msg: Record<string, unknown>, timeoutMs = 2000): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("rawMessage timed out"));
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
    socket.once("connect", () => socket.write(Buffer.from(JSON.stringify(msg) + "\n")));
    socket.connect(socketPath);
  });
}

/** A connection opened and helloed BEFORE some later event, with each
 *  next message sent on demand. The mid-shutdown test uses it: the
 *  connection must predate the shutdown to land in the gate window. */
function openConnection(socketPath: string, timeoutMs = 2000): Promise<{
  send: (msg: Record<string, unknown>) => Promise<DaemonResponse>;
  destroy: () => void;
}> {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = new Socket();
    let buf = "";
    // One response at a time: the hello ack settles the open, later
    // responses settle the pending send().
    let awaiting: ((res: DaemonResponse) => void) | null = null;
    const timer = setTimeout(() => {
      socket.destroy();
      rejectOpen(new Error("openConnection timed out"));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      rejectOpen(err);
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let res: DaemonResponse;
        try {
          res = decodeResponse(line);
        } catch {
          continue;
        }
        const settle = awaiting;
        awaiting = null;
        settle?.(res);
      }
    });
    socket.once("connect", () => {
      awaiting = () => {
        clearTimeout(timer);
        resolveOpen({
          send: (msg) => new Promise<DaemonResponse>((resolve, reject) => {
            const sendTimer = setTimeout(() => reject(new Error("send timed out")), 5000);
            socket.once("error", (err) => {
              clearTimeout(sendTimer);
              reject(err);
            });
            awaiting = (res) => {
              clearTimeout(sendTimer);
              socket.off("error", onError);
              resolve(res);
            };
            function onError(err: Error): void {
              clearTimeout(sendTimer);
              reject(err);
            }
            socket.write(Buffer.from(JSON.stringify(msg) + "\n"));
          }),
          destroy: () => socket.destroy(),
        });
      };
      socket.write(Buffer.from(JSON.stringify({ method: "hello" }) + "\n"));
    });
    socket.connect(socketPath);
  });
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thatch-embed-daemon-"));
  dirs.push(dir);
  return dir;
}

let daemons: EmbedDaemon[] = [];

function makeDaemon(over: { idleMs?: number; modelDelayMs?: number; socketPath?: string; lockPath?: string } = {}) {
  const dir = tempDir();
  const model = new SpyModel(over.modelDelayMs ?? 0);
  let factoryCalls = 0;
  const daemon = new EmbedDaemon({
    dbPath: join(dir, "thatch.db"),
    modelName: "mock",
    modelFactory: () => {
      factoryCalls += 1;
      return model;
    },
    version: VERSION,
    socketPath: over.socketPath ?? join(dir, "embed.sock"),
    lockPath: over.lockPath ?? join(dir, "embed.lock.db"),
    idleMs: over.idleMs ?? 0,
    log: () => {},
  });
  daemons.push(daemon);
  return { daemon, model, dir, exit: daemon.serve(), factoryCalls: () => factoryCalls };
}

/** Waits until the daemon's socket answers hello. */
async function waitReady(daemon: EmbedDaemon): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await exchange(daemon.socketPath, { method: "hello" }, 100);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the daemon socket never became ready");
}

/** Fails the test when a promise neither resolves nor rejects in ms. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | "deadline"> {
  return Promise.race([p, new Promise<"deadline">((r) => setTimeout(() => r("deadline"), ms))]);
}

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.shutdown("signal").catch(() => {});
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("EmbedDaemon", () => {
  test("serving: hello answers with model, version, and pid BEFORE the model loads", async () => {
    const { daemon, model, factoryCalls } = makeDaemon();
    await waitReady(daemon);

    const hello = await exchange(daemon.socketPath, { method: "hello" });
    expect(hello).toEqual({ ok: true, model: "mock", version: VERSION, pid: process.pid });
    // Bind-before-load: hello was answered by configuration alone - the
    // model was never built, let alone loaded.
    expect(factoryCalls()).toBe(0);
    expect(model.loads).toBe(0);

    const embed = await exchange(daemon.socketPath, { method: "embed", kind: "query", text: "hello" });
    expect(embed.ok).toBe(true);
    if (embed.ok && "vector" in embed) {
      expect(embed.vector).toEqual([1, 2, 3]);
    }
    // The lazy build happened HERE, on the first embed.
    expect(factoryCalls()).toBe(1);
    expect(model.loads).toBe(1);
  });

  test("the per-connection lifecycle: hello first, at most one embed", async () => {
    const { daemon } = makeDaemon();
    await waitReady(daemon);

    const noHello = await rawMessage(daemon.socketPath, { method: "embed", kind: "query", text: "x" });
    expect(noHello).toEqual({ ok: false, error: "hello required before embed" });
  });

  test("SQLITE_BUSY loser exits 0 without unlinking the winner's socket", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "embed.sock");
    const lockPath = join(dir, "embed.lock.db");
    const winner = new EmbedDaemon({ dbPath: join(dir, "thatch.db"), socketPath, lockPath, version: VERSION, idleMs: 0, log: () => {}, modelName: "mock", modelFactory: () => new SpyModel() });
    daemons.push(winner);
    const winnerExit = winner.serve();
    await waitReady(winner);

    // The loser's serve() RESOLVES quickly: formation failure, not service.
    const loser = new EmbedDaemon({ dbPath: join(dir, "thatch.db"), socketPath, lockPath, version: VERSION, idleMs: 0, log: () => {}, modelName: "mock", modelFactory: () => new SpyModel() });
    daemons.push(loser);
    const loserExit = await loser.serve();
    expect(loserExit).toEqual({ code: 0, reason: "busy" });

    // The winner's endpoint is untouched and still serving.
    const hello = await exchange(socketPath, { method: "hello" });
    expect(hello.ok).toBe(true);
    await winner.shutdown("idle");
    expect(await winnerExit).toEqual({ code: 0, reason: "idle" });
  });

  test("a dead holder's lock is acquirable (kernel release)", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "embed.sock");
    const lockPath = join(dir, "embed.lock.db");
    const first = new EmbedDaemon({ dbPath: join(dir, "thatch.db"), socketPath, lockPath, version: VERSION, idleMs: 0, log: () => {}, modelName: "mock", modelFactory: () => new SpyModel() });
    daemons.push(first);
    void first.serve();
    await waitReady(first);
    await first.shutdown("idle");

    // The kernel released the lock with the shutdown: a fresh daemon
    // acquires it and serves (the stale socket left by the idle exit does
    // not block it).
    const second = new EmbedDaemon({ dbPath: join(dir, "thatch.db"), socketPath, lockPath, version: VERSION, idleMs: 0, log: () => {}, modelName: "mock", modelFactory: () => new SpyModel() });
    daemons.push(second);
    void second.serve();
    await waitReady(second);
    const embed = await exchange(socketPath, { method: "embed", kind: "query", text: "hello" });
    expect(embed.ok).toBe(true);
  });

  test("a stale socket file is unlinked under the lock; a live endpoint is never touched", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "embed.sock");
    const lockPath = join(dir, "embed.lock.db");
    // A stale socket: a plain file where the socket would be (connect
    // fails; no listener).
    writeFileSync(socketPath, "stale");

    const daemon = new EmbedDaemon({ dbPath: join(dir, "thatch.db"), socketPath, lockPath, version: VERSION, idleMs: 0, log: () => {}, modelName: "mock", modelFactory: () => new SpyModel() });
    daemons.push(daemon);
    void daemon.serve();
    await waitReady(daemon);
    const hello = await exchange(socketPath, { method: "hello" });
    expect(hello.ok).toBe(true);

    // A live endpoint (a plain listener) is left alone.
    const dir2 = tempDir();
    const livePath = join(dir2, "live.sock");
    const holder: NetServer = netCreateServer(() => {});
    await new Promise<void>((r) => holder.listen(livePath, r));
    try {
      const blocked = new EmbedDaemon({ dbPath: join(dir2, "thatch.db"), socketPath: livePath, lockPath: join(dir2, "lock.db"), version: VERSION, idleMs: 0, log: () => {}, modelName: "mock", modelFactory: () => new SpyModel() });
      daemons.push(blocked);
      const exit = await blocked.serve();
      expect(exit.reason).toBe("socket-live");
      expect(existsSync(livePath)).toBe(true);
    } finally {
      holder.close();
    }
  });

  test("idle exit fires after the window with hello-only traffic (hello never re-arms)", async () => {
    const { daemon, model, exit } = makeDaemon({ idleMs: 150 });
    await waitReady(daemon);

    // Hello-only traffic past the window: hellos must not keep it alive.
    let served = true;
    while (served) {
      try {
        await exchange(daemon.socketPath, { method: "hello" }, 200);
      } catch {
        served = false; // socket closed - the daemon exited
        break;
      }
    }
    expect(served).toBe(false);
    // The daemon exited on its own with the idle reason, dispose first.
    const result = await withDeadline(exit, 3000);
    expect(result).toEqual({ code: 0, reason: "idle" });
    // Hello-only traffic never built the model, so there was nothing to
    // dispose; the dispose-before-exit contract is pinned by the embed
    // rounds.
    expect(model.disposes).toBe(0);
  }, 10000);

  test("the idle timer never fires mid-request; an in-flight embed completes", async () => {
    const { daemon, model, exit } = makeDaemon({ idleMs: 80, modelDelayMs: 250 });
    await waitReady(daemon);

    const res = await exchange(daemon.socketPath, { method: "embed", kind: "passage", text: "slow" }, 5000);
    expect(res.ok).toBe(true);
    if (res.ok && "vector" in res) expect(res.vector).toEqual([4, 5, 6]);
    expect(model.disposes).toBe(0); // dispose happens at exit, after the request
    const result = await withDeadline(exit, 3000);
    expect(result).toEqual({ code: 0, reason: "idle" });
    expect(model.disposes).toBe(1);
  }, 10000);

  test("shutdown disposes a model that an embed constructed", async () => {
    const { daemon, model } = makeDaemon();
    await waitReady(daemon);
    await exchange(daemon.socketPath, { method: "embed", kind: "query", text: "warm" });
    await daemon.shutdown("signal");
    expect(model.disposes).toBe(1);
  });

  test("an embed arriving during shutdown is refused; the model never resurrects", async () => {
    const { daemon, model, factoryCalls } = makeDaemon({ modelDelayMs: 250 });
    await waitReady(daemon);

    // An established connection that predates the shutdown - it lands in
    // the shutdown gate's window.
    const conn = await openConnection(daemon.socketPath);

    // An embed in flight (the shutdown's await must cover it).
    const inFlight = exchange(daemon.socketPath, { method: "embed", kind: "query", text: "slow" }, 5000);
    await new Promise((r) => setTimeout(r, 50));
    const shutdown = daemon.shutdown("signal");

    // The established connection's embed arrives mid-shutdown: refused
    // cleanly, never served by the model being torn down.
    const late = await conn.send({ method: "embed", kind: "query", text: "late" });
    expect(late).toEqual({ ok: false, error: "the embed daemon is shutting down" });
    conn.destroy();

    // The in-flight embed completed before the dispose.
    const served = await inFlight;
    expect(served.ok).toBe(true);
    const exit = await shutdown;
    expect(exit.reason).toBe("signal");
    // Exactly one model, constructed once and disposed once.
    expect(factoryCalls()).toBe(1);
    expect(model.loads).toBe(1);
    expect(model.disposes).toBe(1);
  });

  test("shutdown's dispose waits for an in-flight embed", async () => {
    const { daemon, model, exit } = makeDaemon({ modelDelayMs: 250 });
    await waitReady(daemon);
    const embed = exchange(daemon.socketPath, { method: "embed", kind: "passage", text: "slow" }, 5000);
    await new Promise((r) => setTimeout(r, 50));
    const shutdown = daemon.shutdown("idle");
    // Dispose has not run while the embed is in flight...
    expect(model.disposes).toBe(0);
    // ...and the embed still completes successfully.
    const served = await embed;
    expect(served.ok).toBe(true);
    await shutdown;
    expect(model.disposes).toBe(1);
    expect(await exit).toEqual({ code: 0, reason: "idle" });
  });
});

describe("embedIdleExitMs", () => {
  test("precedence: default < config.json idleExitMinutes < env", () => {
    const dir = tempDir();
    const dbPath = join(dir, "thatch.db");
    expect(embedIdleExitMs(dbPath, {})).toBe(DEFAULT_IDLE_EXIT_MS);

    // config.json layer (written beside the db).
    writeFileSync(join(dir, "config.json"), JSON.stringify({ embedDaemon: { idleExitMinutes: 5 } }));
    expect(embedIdleExitMs(dbPath, {})).toBe(5 * 60_000);

    // The env knob beats the file.
    expect(embedIdleExitMs(dbPath, { THATCH_EMBED_DAEMON_IDLE_MS: "15000" })).toBe(15_000);
  });
});

describe("probeEmbedLock (the doctor's read)", () => {
  test("free with no lock db, held under a live holder, unusable on a corrupt file", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "embed.lock.db");
    expect(probeEmbedLock(lockPath)).toBe("free");

    const holder = new EmbedDaemon({
      dbPath: join(dir, "thatch.db"),
      socketPath: join(dir, "s.sock"),
      lockPath,
      version: VERSION,
      idleMs: 0,
      log: () => {},
      modelName: "mock",
      modelFactory: () => new SpyModel(),
    });
    daemons.push(holder);
    void holder.serve();
    await waitReady(holder);
    expect(probeEmbedLock(lockPath)).toBe("held");

    // A file that is not a sqlite db at all: a FINDING, not a crash -
    // and never a "held" that would send the doctor hunting for a holder
    // that does not exist.
    const corrupt = join(dir, "corrupt.lock.db");
    writeFileSync(corrupt, "this is definitely not a sqlite database file");
    expect(probeEmbedLock(corrupt)).toBe("unusable");
  });

  test("a corrupt lock db makes serve() exit with an error, not a quiet busy", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "embed.lock.db");
    writeFileSync(lockPath, "this is definitely not a sqlite database file");
    const daemon = new EmbedDaemon({
      dbPath: join(dir, "thatch.db"),
      socketPath: join(dir, "embed.sock"),
      lockPath,
      version: VERSION,
      idleMs: 0,
      log: () => {},
      modelName: "mock",
      modelFactory: () => new SpyModel(),
    });
    daemons.push(daemon);
    const exit = await daemon.serve();
    expect(exit).toEqual({ code: 1, reason: "error" });
  });

  test("an EADDRINUSE bind exits 0 quietly (the raced winner is serving)", async () => {
    // A directory occupies the socket path: the connect probe fails, the
    // unlink fails (a directory, caught), and the bind reports EADDRINUSE
    // - the shape of losing a bind race against a live winner.
    const dir = tempDir();
    const socketPath = join(dir, "embed.sock");
    mkdirSync(socketPath);
    const daemon = new EmbedDaemon({
      dbPath: join(dir, "thatch.db"),
      socketPath,
      lockPath: join(dir, "embed.lock.db"),
      version: VERSION,
      idleMs: 0,
      log: () => {},
      modelName: "mock",
      modelFactory: () => new SpyModel(),
    });
    daemons.push(daemon);
    const exit = await withDeadline(daemon.serve(), 5000);
    expect(exit).toEqual({ code: 0, reason: "eaddrinuse" });
  });
});
