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
 * winner's socket (a stale socket is unlinked by the next daemon, under
 * the lock).
 */
import { Socket } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import type { EmbeddingModel } from "../embeddings";
import { createEmbeddingModel } from "../embeddings";
import {
  decodeResponse,
  encodeMessage,
  type DaemonResponse,
  type EmbedRequest,
  type HelloResponse,
} from "./protocol";

/**
 * The daemon socket path, from the DB path. The cache-dir derivation
 * (tmpdir()/thatch-<sha256(dbPath)[:16]>) is re-derived inline rather than
 * exported from src/version-check.ts, matching the sideband's existing
 * precedent (src/sideband.ts duplicates the same hash derivation), so
 * version-check.ts stays untouched. The socket sits in the same hash-named,
 * thatch--prefixed tmpdir family as the sideband socket and the version
 * file; distinct filename, no collision.
 */
export function embedCacheDir(dbPath: string): string {
  const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return join(tmpdir(), `thatch-${hash}`);
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

function defaultTransport(socketPath: string): Promise<DaemonConnection> {
  return new Promise((resolveTransport, rejectTransport) => {
    // Handlers attach BEFORE the dial: bun can surface a connect failure
    // (ENOENT on a stale socket path) synchronously, and an error listener
    // attached after connect() would miss it.
    const socket: Socket = new Socket();
    let buf = "";

    const fail = (err: Error) => {
      socket.destroy();
      rejectTransport(err);
    };
    socket.once("error", (err: NodeJS.ErrnoException) => {
      // Surface the connect failure with its errno (ENOENT, ECONNREFUSED)
      // so the resolver can classify it; later (post-connect) errors are
      // delivered through the pending request's rejection instead.
      const wrapped = new Error(`embed daemon connect failed: ${err.message}`);
      (wrapped as NodeJS.ErrnoException).code = err.code;
      fail(wrapped);
    });
    socket.once("connect", () => {
      resolveTransport({
        hello: () => request({ method: "hello" }),
        embed: (kind, text) => request({ method: "embed", kind, text } satisfies EmbedRequest),
        close: () => socket.destroy(),
      });
    });
    socket.connect(socketPath);

    function request(msg: EmbedRequest | { method: "hello" }): Promise<DaemonResponse> {
      return new Promise((resolveRequest, rejectRequest) => {
        socket.write(encodeMessage(msg));
        const ondata = (chunk: Buffer) => {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          socket.off("data", ondata);
          try {
            resolveRequest(decodeResponse(line));
          } catch (err) {
            rejectRequest(err);
          }
        };
        socket.on("data", ondata);
        socket.once("error", (err: Error) => rejectRequest(err));
      });
    }
  });
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
    // own. Awaiting keeps the dispose-before-exit contract (Bun #34664).
    await this.#local?.dispose();
  }

  async #embed(kind: "query" | "passage", text: string): Promise<Float32Array> {
    await this.#ensureResolved();
    if (this.#state === "local-locked") return this.#localEmbed(kind, text);
    if (this.#now() < this.#cooldownUntil) return this.#localEmbed(kind, text);
    try {
      const vector = await this.#remoteEmbed(kind, text);
      // A healthy round trip resets the wedge counter.
      this.#consecutiveTimeouts = 0;
      return vector;
    } catch (err) {
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
      // the socket, so a daemon that returns mid-life is used again.
      this.#noteOnce(
        "fallback",
        `embedding in-process (the embed daemon is unreachable: ${err instanceof Error ? err.message : err}); will re-probe on the next embed`,
      );
      return this.#localEmbed(kind, text);
    }
  }

  /** The memoized resolve-time policy. See the module doc for the branches. */
  async #ensureResolved(): Promise<void> {
    if (this.#state !== "unresolved") return;
    this.#resolving ??= this.#resolve();
    await this.#resolving;
  }

  async #resolve(): Promise<void> {
    if (!daemonEnabled()) {
      this.#lockLocal("the embed daemon is disabled (THATCH_EMBED_DAEMON=off)");
      return;
    }
    let probed = await this.#probe();
    if (probed.ok) {
      this.#accept(probed.hello);
      return;
    }
    // No listener: the designed first-session case. One spawn attempt.
    const spawned = await this.#ensureDaemonRunning();
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
    try {
      const conn = await this.#withTimeout(Promise.resolve(this.#transport(this.#socketPath)), "connect");
      try {
        const res = await this.#withTimeout(conn.hello(), "hello");
        if (!res.ok) return { ok: false, reason: res.error };
        return { ok: true, hello: res };
      } finally {
        conn.close();
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async #remoteEmbed(kind: "query" | "passage", text: string): Promise<Float32Array> {
    const conn = await this.#withTimeout(Promise.resolve(this.#transport(this.#socketPath)), "connect");
    try {
      const hello = await this.#withTimeout(conn.hello(), "hello");
      if (!hello.ok) throw new Error(hello.error);
      if (hello.model !== this.name) {
        // Mid-life model change on the daemon: same unusable-space logic as
        // resolve time. Locked for the process lifetime.
        this.#lockLocal(`the embed daemon now serves "${hello.model}", not "${this.name}" (model mismatch)`);
        throw new EmbedHandshakeError(`model mismatch: ${hello.model}`);
      }
      const res = await this.#withTimeout(conn.embed(kind, text), "embed");
      if (!res.ok) throw new Error(res.error);
      if (!("vector" in res)) throw new Error("the embed response carried no vector");
      return Float32Array.from(res.vector);
    } finally {
      conn.close();
    }
  }

  #withTimeout<T>(p: Promise<T>, op: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
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
