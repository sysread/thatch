/**
 * The embed daemon's client side: the resolver policy and the
 * RemoteEmbeddingModel it returns. One MCP server process owns one resolver
 * instance (built by resolveEmbeddingModel at src/mcp.ts's construction
 * site); the wrapper implements EmbeddingModel, so every tool and the
 * sideband see an ordinary model.
 *
 * The policy states and transitions live in docs/plans/embedding-daemon.md
 * ("State and transition matrix"): unresolved -> remote (probe or
 * spawn+handshake succeeded, model names match) or local-locked (spawn
 * failed, handshake failed, model mismatch, or the knob off - terminal for
 * the process lifetime). A failed embed while remote delegates that one
 * request to the lazy local model and does NOT change state; the next embed
 * re-probes, so recovery when a daemon returns is automatic.
 *
 * The local fallback is LAZY on purpose: a session served by a healthy
 * daemon never imports the ONNX runtime at all (the whole point of the
 * daemon - issue #26), and a dead daemon never wedges a session (each
 * request carries a timeout; a timed-out request delegates to local).
 *
 * The client NEVER unlinks socket files. The sideband client's
 * unlink-on-ECONNREFUSED convention is deliberately not copied here: the
 * daemon owns the endpoint, and a client-side unlink can kill a live
 * daemon's socket (a stale socket is unlinked by the next daemon, under
 * the lock).
 */
import { Socket } from "node:net";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import type { EmbeddingModel } from "../embeddings";
import { createEmbeddingModel } from "../embeddings";
import {
  DaemonProtocolError,
  decodeResponse,
  encodeMessage,
  type DaemonResponse,
  type EmbedRequest,
  type HelloResponse,
} from "./protocol";
import { dialSocket } from "./socket";

/**
 * The cache-dir base: /tmp/thatch-<uid> on unix (created 0700 by the
 * daemon before it binds), tmpdir() everywhere the anchor is unusable
 * (Windows, no uid, /tmp missing or unwritable).
 *
 * The base must NOT derive from tmpdir(): a direnv'd nix develop shell
 * gives every shell its own TMPDIR, and tmpdir() follows it. In
 * jowi-dev's field report (issue #26, 2026-11-19) that produced 18
 * daemons for one DB path, each holding its own lock - the single-owner
 * sqlite lock is only single-owner within one TMPDIR base. A
 * cross-process singleton anchors on something no shell can vary: /tmp
 * is shared by every shell, including the nix ones that override TMPDIR
 * but not /tmp, and <uid> scopes the dir per user on shared machines.
 *
 * Deliberate deviation: the sideband socket and the version file keep
 * tmpdir() because they are same-env by construction (hooks inherit
 * their server's env); the daemon is the only cross-session actor.
 */
function embedCacheBase(): string {
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (uid === undefined) return tmpdir();
  try {
    accessSync("/tmp", constants.W_OK);
  } catch {
    return tmpdir();
  }
  return `/tmp/thatch-${uid}`;
}

/**
 * The daemon socket path, from the DB path. The cache-dir derivation
 * (embedCacheBase()/thatch-<sha256(dbPath)[:16]>) is re-derived inline
 * rather than exported from src/version-check.ts, matching the sideband's
 * existing precedent (src/sideband.ts duplicates the same hash
 * derivation), so version-check.ts stays untouched. The socket sits in a
 * dir named thatch-<hash> like the sideband socket and the version file,
 * but under a TMPDIR-independent base (see embedCacheBase); distinct
 * filename, no collision.
 */
export function embedCacheDir(dbPath: string): string {
  const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return join(embedCacheBase(), `thatch-${hash}`);
}

export function embedSocketPath(dbPath: string): string {
  return join(embedCacheDir(dbPath), "embed.sock");
}

export function embedLockPath(dbPath: string): string {
  return join(embedCacheDir(dbPath), "embed.lock.db");
}

/** The daemon knob: `off` forces every embedding model in-process. */
export function daemonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.THATCH_EMBED_DAEMON !== "off";
}

/**
 * One daemon connection: hello is the preamble, then AT MOST ONE embed,
 * then close. Every method races the client's per-request timeout; a
 * timeout destroys the connection (close() must be safe to call twice).
 * Either method may return the ErrorResponse shape (ok: false); the client
 * treats that as a failed request and falls back.
 */
export interface DaemonConnection {
  hello(): Promise<DaemonResponse>;
  embed(kind: "query" | "passage", text: string): Promise<DaemonResponse>;
  close(): void;
}

/**
 * Opens a daemon connection. Injected so tests supply an in-memory duplex
 * pair; the default transport speaks newline-delimited JSON over a Unix
 * socket.
 */
export type Transport = (socketPath: string) => Promise<DaemonConnection>;

/** The per-request timeout's error marker. */
export class EmbedTimeoutError extends Error {
  constructor(op: string) {
    super(`embed daemon ${op} timed out`);
  }
}

export class EmbedHandshakeError extends Error {}

/** The daemon answered with an error response (ok: false): the daemon is
 *  alive and spoke. Distinct from transport failures only so the fallback
 *  note can say which failure class happened (M: the old note blamed
 *  "unreachable" for every failure class). */
class DaemonErrorResponse extends Error {}

async function defaultTransport(socketPath: string): Promise<DaemonConnection> {
  let socket: Socket;
  try {
    socket = await dialSocket(socketPath);
  } catch (err) {
    // Surface the connect failure with its errno (ENOENT, ECONNREFUSED)
    // so the resolver can classify it.
    const wrapped = new Error(`embed daemon connect failed: ${err instanceof Error ? err.message : err}`);
    (wrapped as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw wrapped;
  }

  let buf = "";
  // A request in flight when close() destroys the socket must still
  // settle: destroy emits no 'error' event, so close rejects them here.
  const orphans = new Set<(err: Error) => void>();

  function request(msg: EmbedRequest | { method: "hello" }): Promise<DaemonResponse> {
    return new Promise((resolveRequest, rejectRequest) => {
      function onError(err: Error): void {
        cleanup();
        rejectRequest(err);
      }
      function ondata(chunk: Buffer): void {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        cleanup();
        try {
          resolveRequest(decodeResponse(line));
        } catch (err) {
          rejectRequest(err);
        }
      }
      function cleanup(): void {
        socket.off("data", ondata);
        socket.off("error", onError);
        orphans.delete(rejectOrphan);
      }
      function rejectOrphan(err: Error): void {
        rejectRequest(err);
      }
      orphans.add(rejectOrphan);
      socket.on("data", ondata);
      socket.once("error", onError);
      socket.write(encodeMessage(msg));
    });
  }

  return {
    hello: () => request({ method: "hello" }),
    embed: (kind, text) => request({ method: "embed", kind, text } satisfies EmbedRequest),
    close: () => {
      for (const reject of orphans) reject(new Error("the embed daemon connection closed"));
      orphans.clear();
      socket.destroy();
    },
  };
}

export interface RemoteEmbeddingModelOptions {
  dbPath: string;
  modelName: string;
  mode: "standalone" | "bundled";
  transport?: Transport;
  /** The supervisor's spawn-once promise (default: the real one). */
  ensureDaemonRunning?: () => Promise<"running" | "failed">;
  /** Builds the local fallback model, lazily, when first needed. */
  localFactory?: () => EmbeddingModel;
  requestTimeoutMs?: number;
  timeoutThreshold?: number;
  cooldownMs?: number;
  /** The daemon knob's read (default: the THATCH_EMBED_DAEMON env read).
   *  The one knob input with a seam, so tests never mutate process.env. */
  daemonEnabled?: () => boolean;
  /** One-time stderr notes (fallbacks, locks, skew). */
  note?: (msg: string) => void;
  now?: () => number;
}

/**
 * RemoteEmbeddingModel: the resolver wrapper. Synchronously constructed
 * without probing; the policy runs once, lazily, at the first embed
 * (memoized for the process lifetime).
 */
export class RemoteEmbeddingModel implements EmbeddingModel {
  readonly name: string;
  #mode: "standalone" | "bundled";
  #socketPath: string;
  #transport: Transport;
  #ensureDaemonRunning: () => Promise<"running" | "failed">;
  #localFactory: () => EmbeddingModel;
  #requestTimeoutMs: number;
  #timeoutThreshold: number;
  #cooldownMs: number;
  #daemonEnabled: () => boolean;
  #note: (msg: string) => void;
  #now: () => number;

  #state: "unresolved" | "remote" | "local-locked" = "unresolved";
  #resolving: Promise<void> | null = null;
  #local: EmbeddingModel | null = null;
  #consecutiveTimeouts = 0;
  #cooldownUntil = 0;
  #notedReasons = new Set<string>();

  constructor(opts: RemoteEmbeddingModelOptions) {
    this.name = opts.modelName;
    this.#mode = opts.mode;
    this.#socketPath = embedSocketPath(opts.dbPath);
    this.#transport = opts.transport ?? defaultTransport;
    this.#ensureDaemonRunning = opts.ensureDaemonRunning ?? (() => import("./supervisor").then((m) => m.ensureDaemonRunning({ socketPath: this.#socketPath })));
    this.#localFactory = opts.localFactory ?? (() => createEmbeddingModel(opts.modelName));
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 2000;
    this.#timeoutThreshold = opts.timeoutThreshold ?? 3;
    this.#cooldownMs = opts.cooldownMs ?? 60_000;
    this.#daemonEnabled = opts.daemonEnabled ?? daemonEnabled;
    this.#note = opts.note ?? ((msg) => console.error(`[thatch] ${msg}`));
    this.#now = opts.now ?? Date.now;
  }

  get loaded(): boolean {
    return this.#local?.loaded ?? false;
  }

  /** The resolver's current state, for tests and diagnostics. */
  get state(): "unresolved" | "remote" | "local-locked" {
    return this.#state;
  }

  async load(): Promise<void> {
    // The daemon path needs no load (each embed is a full remote round
    // trip); the local fallback loads itself on first use. A direct load()
    // only warms an already-constructed local model.
    await this.#local?.load();
  }

  async queryEmbed(text: string): Promise<Float32Array> {
    return this.#embed("query", text);
  }

  async passageEmbed(text: string): Promise<Float32Array> {
    return this.#embed("passage", text);
  }

  async dispose(): Promise<void> {
    // Only the local model holds ONNX sessions; the daemon releases its
    // own. Awaiting keeps the dispose-before-exit contract.
    await this.#local?.dispose();
  }

  async #embed(kind: "query" | "passage", text: string): Promise<Float32Array> {
    await this.#ensureResolved();
    if (this.#state === "local-locked") return this.#localEmbed(kind, text);
    if (this.#now() < this.#cooldownUntil) return this.#localEmbed(kind, text);
    try {
      const vector = await this.#remoteEmbed(kind, text);
      // A healthy round trip resets the timeout count.
      this.#consecutiveTimeouts = 0;
      return vector;
    } catch (err) {
      if (err instanceof EmbedHandshakeError) {
        // Mid-life model mismatch: the mismatch path locked local and
        // noted it. A local-locked state can never re-probe, so the
        // generic fallback note (which promises a re-probe) would
        // contradict it - delegate quietly.
        return this.#localEmbed(kind, text);
      }
      if (err instanceof EmbedTimeoutError) {
        this.#consecutiveTimeouts += 1;
        if (this.#consecutiveTimeouts >= this.#timeoutThreshold) {
          this.#consecutiveTimeouts = 0;
          this.#cooldownUntil = this.#now() + this.#cooldownMs;
          this.#noteOnce(
            "cool-down",
            `the embed daemon stayed unresponsive (${this.#timeoutThreshold} consecutive timeouts); embedding in-process for ${Math.round(this.#cooldownMs / 1000)}s before re-probing`,
          );
        }
      }
      // One request's failure never changes state: the next embed re-probes
      // the socket, so a daemon that returns mid-life is used again. The
      // note names the failure class: a daemon that ANSWERED (an error
      // response, a malformed line) is a different animal from one that
      // could not be reached at all.
      const message = err instanceof Error ? err.message : String(err);
      const isDaemonError = err instanceof DaemonErrorResponse || err instanceof DaemonProtocolError;
      const cause = isDaemonError ? "the embed daemon answered with an error" : "the embed daemon is unreachable";
      this.#noteOnce(
        "fallback",
        `embedding in-process (${cause}: ${message}); will re-probe on the next embed`,
      );
      return this.#localEmbed(kind, text);
    }
  }

  /** The memoized resolve-time policy. See the module doc for the branches. */
  async #ensureResolved(): Promise<void> {
    this.#resolving ??= this.#resolve();
    try {
      await this.#resolving;
    } catch (err) {
      // A rejected resolve must not poison every later embed: clear the
      // memo so the next embed re-runs the policy (the same memo-clearing
      // BgeEmbeddingModel.load does for a failed model load).
      this.#resolving = null;
      throw err;
    }
  }

  async #resolve(): Promise<void> {
    if (!this.#daemonEnabled()) {
      this.#lockLocal("the embed daemon is disabled (THATCH_EMBED_DAEMON=off)");
      return;
    }
    let probed = await this.#probe();
    if (probed.ok) {
      this.#accept(probed.hello);
      return;
    }
    // No listener: the designed first-session case. One spawn attempt. A
    // THROWING spawn (EAGAIN/ENOMEM under resource pressure) locks local
    // exactly like a spawned daemon that never comes up - the rejection
    // must never escape into the resolver memo (see #ensureResolved).
    let spawned: "running" | "failed";
    try {
      spawned = await this.#ensureDaemonRunning();
    } catch (err) {
      this.#lockLocal(`the embed daemon could not be started (${err instanceof Error ? err.message : err})`);
      return;
    }
    if (spawned === "running") {
      probed = await this.#probe();
      if (probed.ok) {
        this.#accept(probed.hello);
        return;
      }
    }
    this.#lockLocal(`the embed daemon could not be started (${probed.reason})`);
  }

  #accept(hello: HelloResponse): void {
    if (hello.model !== this.name) {
      // Different model, different vector space: the daemon is UNUSABLE for
      // this session, and spawning another cannot help (the lock guarantees
      // one daemon per DB path). Locked without a spawn attempt.
      this.#lockLocal(`the embed daemon serves "${hello.model}", not "${this.name}" (model mismatch)`);
      return;
    }
    if (hello.version !== pkg.version) {
      // Version-skew warning in detectSkew's tone. Not a lock: raw embeds
      // are version-agnostic, and the stale daemon idles out once traffic
      // pauses (hellos never keep it alive).
      this.#noteOnce(
        `skew-${hello.version}`,
        `thatch was upgraded to v${pkg.version} but the embed daemon is running v${hello.version} (pid ${hello.pid}); it will be replaced once its traffic pauses`,
      );
    }
    this.#state = "remote";
  }

  #lockLocal(reason: string): void {
    this.#state = "local-locked";
    this.#noteOnce(`locked-${reason}`, `embedding in-process for this session's lifetime: ${reason}`);
  }

  #noteOnce(key: string, msg: string): void {
    if (this.#notedReasons.has(key)) return;
    this.#notedReasons.add(key);
    this.#note(`${msg} [${this.#mode}]`);
  }

  async #probe(): Promise<{ ok: true; hello: HelloResponse } | { ok: false; reason: string }> {
    let conn: DaemonConnection | null = null;
    try {
      conn = await this.#dial();
      const res = await this.#withTimeout(conn.hello(), "hello");
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true, hello: res };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      conn?.close();
    }
  }

  async #remoteEmbed(kind: "query" | "passage", text: string): Promise<Float32Array> {
    const conn = await this.#dial();
    try {
      const hello = await this.#withTimeout(conn.hello(), "hello");
      if (!hello.ok) throw new DaemonErrorResponse(hello.error);
      if (hello.model !== this.name) {
        // Mid-life model change on the daemon: same unusable-space logic as
        // resolve time. Locked for the process lifetime.
        this.#lockLocal(`the embed daemon now serves "${hello.model}", not "${this.name}" (model mismatch)`);
        throw new EmbedHandshakeError(`model mismatch: ${hello.model}`);
      }
      const res = await this.#withTimeout(conn.embed(kind, text), "embed");
      if (!res.ok) throw new DaemonErrorResponse(res.error);
      if (!("vector" in res)) throw new Error("the embed response carried no vector");
      return Float32Array.from(res.vector);
    } finally {
      conn.close();
    }
  }

  /**
   * Opens a connection under the connect timeout. A timed-out dial is
   * destroyed when (or before) it finishes connecting, so a connect-stage
   * timeout never leaks the socket fd - the module doc's "a timeout
   * destroys the connection" holds for connect too, not just hello/embed.
   */
  async #dial(): Promise<DaemonConnection> {
    const dialing = Promise.resolve(this.#transport(this.#socketPath));
    // Whoever loses the race (a timeout firing, a transport failure after
    // one) closes the connection when - or if - the dial completes.
    const closeOnArrival = () => {
      void dialing.then(
        (c) => c.close(),
        () => {},
      );
    };
    try {
      return await this.#withTimeout(dialing, "connect", closeOnArrival);
    } catch (err) {
      closeOnArrival();
      throw err;
    }
  }

  #withTimeout<T>(p: Promise<T>, op: string, onTimeout?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout?.();
        reject(new EmbedTimeoutError(op));
      }, this.#requestTimeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async #localEmbed(kind: "query" | "passage", text: string): Promise<Float32Array> {
    this.#local ??= this.#localFactory();
    return kind === "query" ? this.#local.queryEmbed(text) : this.#local.passageEmbed(text);
  }
}

/**
 * The one new symbol src/mcp.ts learns. Returns the resolver wrapper
 * synchronously - no probe, no spawn; the policy runs lazily on the first
 * embed and is memoized for the process lifetime. Bundled (plugin-regime)
 * sessions participate fully: the daemon has single-owner semantics (the
 * sqlite lock), so unlike the sideband and the version file there is no
 * collision to skip - see docs/plans/embedding-daemon.md, ruling 2.
 */
export function resolveEmbeddingModel(dbPath: string, modelName: string, mode: "standalone" | "bundled"): EmbeddingModel {
  return new RemoteEmbeddingModel({ dbPath, modelName, mode });
}
