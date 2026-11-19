/**
 * The embed daemon's process body: one long-lived process per DB path that
 * holds the embedding model and serves raw embed requests over a Unix
 * socket (the wire contract lives in protocol.ts). Spawned detached by the
 * supervisor; also runnable by hand via `thatch embed-daemon`.
 *
 * Lifecycle invariants, each pinned by a unit test:
 *
 * - BIND BEFORE LOAD: the socket binds and hello is answered before the
 *   model loads (the model is lazy, on the first embed). A slow model load
 *   can never convert cold starts into local-locked sessions - the
 *   supervisor's ~2s wait must run at process-start speed.
 * - THE LOCK IS SQLITE'S OWN: a dedicated embed.lock.db beside the socket,
 *   `busy_timeout = 0`, and a `BEGIN EXCLUSIVE` transaction held for the
 *   daemon's whole lifetime. The kernel owns the lock, releases it the
 *   moment the holder dies, and there is no stale-lock recovery path at
 *   all. It is deliberately NOT a held transaction on thatch.db: that
 *   would starve every MCP server, hook, and plugin instance of writes.
 *   A losing daemon's BEGIN EXCLUSIVE fails immediately (SQLITE_BUSY) and
 *   it exits 0 quietly BEFORE touching the socket, so the winner's live
 *   socket is never unlinked. No unlink, no steal, no read-back: a dead
 *   holder's locks vanish with the process, so a new daemon never
 *   mistakes a dead holder's pid for a live one.
 * - IDLE EXIT: the daemon exits after idleMs with no EMBED requests. Hello
 *   NEVER re-arms the timer - hellos are free to the daemon's lifetime, so
 *   a daemon whose model no session wants (the THATCH_MODEL-change case)
 *   idles out even under heavy session churn. An in-flight request is
 *   never interrupted (the shutdown awaits the in-flight embeds).
 * - DISPOSE BEFORE EVERY EXIT PATH: ONNX sessions must be explicitly
 *   released before process exit or Bun's NAPI finalizers panic
 *   (oven-sh/bun#34664; the same contract the MCP teardown enforces).
 */
import { Database } from "bun:sqlite";
import { createServer, Socket, type Server } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createDebugLog, type DebugLog } from "../debug";
import { createEmbeddingModel, DEFAULT_EMBEDDING_MODEL, type EmbeddingModel } from "../embeddings";
import { loadConfig } from "../config";
import {
  DaemonProtocolError,
  decodeRequest,
  encodeMessage,
  type DaemonResponse,
  type EmbedRequest,
  type HelloResponse,
} from "./protocol";
import { embedLockPath, embedSocketPath } from "./client";
import { dialSocket } from "./socket";
import pkg from "../../package.json";

/** The built-in idle exit: 30 minutes (see docs/plans/embedding-daemon.md,
 *  ruling 3). Precedence: this default < config.json's
 *  embedDaemon.idleExitMinutes < THATCH_EMBED_DAEMON_IDLE_MS. */
export const DEFAULT_IDLE_EXIT_MS = 30 * 60 * 1000;

/**
 * Resolves the daemon's idle-exit window. Explicit env beats the
 * preference file beats the built-in default: the env knob is the
 * per-process escape hatch, the config file the user's standing
 * preference.
 */
export function embedIdleExitMs(
  dbPath: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.THATCH_EMBED_DAEMON_IDLE_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const configured = loadConfig(dbPath).config.embedDaemon?.idleExitMinutes;
  if (typeof configured === "number" && configured > 0) return configured * 60_000;
  return DEFAULT_IDLE_EXIT_MS;
}

export interface EmbedDaemonDeps {
  dbPath: string;
  /** The model name hello reports (and the factory builds lazily). */
  modelName?: string;
  /** Builds the model lazily on the first embed. Default: the embedding
   *  factory (which honors THATCH_MODEL=mock - the daemon tests' seam). */
  modelFactory?: () => EmbeddingModel;
  version?: string;
  socketPath?: string;
  lockPath?: string;
  /** Idle-exit window; <= 0 disables the idle exit. Default:
   *  embedIdleExitMs(dbPath). */
  idleMs?: number;
  log?: DebugLog;
}

/** The stale-socket probe's connect timeout. */
const STALE_PROBE_TIMEOUT_MS = 250;

export type DaemonExitReason = "busy" | "socket-live" | "eaddrinuse" | "idle" | "signal" | "error";

export interface DaemonExit {
  code: number;
  reason: DaemonExitReason;
}

export class EmbedDaemon {
  #socketPath: string;
  #lockPath: string;
  #idleMs: number;
  #log: DebugLog;
  #modelName: string;
  #version: string;
  #modelFactory: () => EmbeddingModel;

  #server: Server | null = null;
  #lockDb: Database | null = null;
  #model: EmbeddingModel | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = 0;
  #shuttingDown = false;
  #shutdownPromise: Promise<DaemonExit> | null = null;
  #resolveExit: ((exit: DaemonExit) => void) | null = null;
  #signalHandler: (() => void) | null = null;

  constructor(deps: EmbedDaemonDeps) {
    this.#modelName = deps.modelName ?? process.env.THATCH_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.#version = deps.version ?? pkg.version;
    this.#socketPath = deps.socketPath ?? embedSocketPath(deps.dbPath);
    this.#lockPath = deps.lockPath ?? embedLockPath(deps.dbPath);
    this.#idleMs = deps.idleMs ?? embedIdleExitMs(deps.dbPath);
    this.#log = deps.log ?? createDebugLog(deps.dbPath);
    this.#modelFactory = deps.modelFactory ?? (() => createEmbeddingModel(this.#modelName));
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  /**
   * Runs until the idle exit, a signal, or a formation failure. Resolves
   * with the exit code; the CLI subcommand maps it to process.exit.
   */
  async serve(): Promise<DaemonExit> {
    mkdirSync(dirname(this.#socketPath), { recursive: true });

    // Formation, step 1: the lock. A second daemon loses here and exits
    // BEFORE touching the socket - see the module doc for why the lock is
    // sqlite's own and why there is no stale-lock path. SQLITE_BUSY is the
    // designed loss; every other failure (a corrupt or unwritable lock db)
    // exits with an error - classifying it as "busy" would block formation
    // forever with no diagnostic.
    try {
      this.#lockDb = new Database(this.#lockPath, { create: true });
      this.#lockDb.exec("PRAGMA busy_timeout = 0");
      this.#lockDb.exec("BEGIN EXCLUSIVE");
    } catch (err) {
      this.#lockDb?.close();
      this.#lockDb = null;
      if (isSqliteBusy(err)) {
        this.#log("embed-daemon:lock", `another daemon holds the lock: ${err}`);
        return { code: 0, reason: "busy" };
      }
      this.#log("embed-daemon:lock", `the lock database is unusable: ${err}`);
      return { code: 1, reason: "error" };
    }

    // Formation, step 2: a stale socket file (an idle-exit leftover) is
    // unlinked here and nowhere else - under the lock, after a failed
    // connect probe proves no live daemon owns it.
    if (existsSync(this.#socketPath)) {
      const live = await this.#probeSocketLive();
      if (live) {
        this.#lockDb.close();
        this.#lockDb = null;
        return { code: 0, reason: "socket-live" };
      }
      try {
        unlinkSync(this.#socketPath);
      } catch {
        // Already gone - fine.
      }
    }

    // The exit promise exists BEFORE the bind: shutdown() must be able to
    // resolve serve() from the moment serving starts. (Gating this on the
    // listen callback is a bug bun punishes hard: its listen callback can
    // fire arbitrarily late even while the socket already serves - observed
    // under bun test - so anything awaited on it stalls the resolver for
    // seconds at a time.)
    const exitPromise = new Promise<DaemonExit>((resolve) => {
      this.#resolveExit = resolve;
    });

    // Formation, step 3: bind. EADDRINUSE exits 0 quietly (a daemon that
    // raced us to the bind is serving; losing to it is success). The bind
    // is fire-and-forget: readiness is measured by hello answering (the
    // supervisor polls), not by the listen callback.
    this.#server = createServer((socket) => this.#handleConnection(socket));
    this.#server.once("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "EADDRINUSE") {
        this.#log("embed-daemon:bind", `socket already bound: ${this.#socketPath}`);
        void this.shutdown("eaddrinuse");
      } else {
        this.#log("embed-daemon:bind", `bind failed: ${err}`);
        void this.shutdown("error");
      }
    });
    this.#server.listen(this.#socketPath);

    // Serving. The idle timer arms now and re-arms per embed; hello never
    // re-arms it. Signals share the shutdown path with the idle exit, so
    // the model's dispose runs on every exit path.
    this.#armIdle();
    // One named handler per daemon, removed at shutdown: instances come
    // and go in tests, and a leaked handler would shut a dead instance
    // down twice.
    const signalHandler = () => {
      void this.shutdown("signal");
    };
    this.#signalHandler = signalHandler;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, signalHandler);
    }
    this.#log("embed-daemon:ready", `serving ${this.#modelName} at ${this.#socketPath} (pid ${process.pid})`);
    return exitPromise;
  }

  /**
   * The shutdown path: idempotent, awaits in-flight embeds, and releases
   * the model's ONNX sessions BEFORE the process can exit (Bun #34664).
   * The socket file is left in place - the idle-exit leftover is by
   * design; the next daemon unlinks it under the lock.
   */
  async shutdown(reason: DaemonExitReason): Promise<DaemonExit> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      // The gate goes up FIRST: every embed arriving after this point is
      // refused at the socket. Serving one mid-shutdown would construct or
      // use a model that is being (or has been) disposed - a lazy
      // re-load nothing will ever release, or live ONNX sessions carried
      // into process.exit (Bun #34664).
      this.#shuttingDown = true;
      this.#clearIdle();
      // Stop listening before waiting on in-flight requests: no new
      // connection can start an embed past the close. Established
      // connections keep serving until their request finishes.
      if (this.#server) {
        await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
        this.#server = null;
      }
      // An in-flight embed finishes before the model releases; re-checked
      // after the close, since a request could still have been arriving.
      while (this.#inFlight > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await this.#model?.dispose();
      this.#model = null;
      if (this.#lockDb) {
        this.#lockDb.close();
        this.#lockDb = null;
      }
      if (this.#signalHandler) {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          process.off(signal, this.#signalHandler);
        }
        this.#signalHandler = null;
      }
      this.#log("embed-daemon:exit", reason);
      const exit: DaemonExit = { code: reason === "error" ? 1 : 0, reason };
      this.#resolveExit?.(exit);
      return exit;
    })();
    return this.#shutdownPromise;
  }

  #armIdle(): void {
    if (this.#idleMs <= 0) return;
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.shutdown("idle");
    }, this.#idleMs);
    // The idle timer must never hold the host process open on its own.
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #modelForEmbed(): EmbeddingModel {
    // The lazy load happens HERE, never at hello: bind-before-load keeps
    // cold starts at process-start speed.
    this.#model ??= this.#modelFactory();
    return this.#model;
  }

  async #probeSocketLive(): Promise<boolean> {
    try {
      const socket = await dialSocket(this.#socketPath, STALE_PROBE_TIMEOUT_MS);
      socket.destroy();
      return true;
    } catch {
      return false;
    }
  }

  #handleConnection(socket: Socket): void {
    // A connection arriving during shutdown is destroyed immediately:
    // serving it would touch the model being torn down.
    if (this.#shuttingDown) {
      socket.destroy();
      return;
    }
    let buf = "";
    // Per-connection lifecycle: hello, its response, AT MOST ONE embed,
    // close (protocol.ts states it once; this is its enforcement).
    let sawHello = false;
    let embeds = 0;
    socket.on("data", (chunk: Buffer) => {
      // An ESTABLISHED connection sending an embed mid-shutdown gets a
      // clean refusal, so the client falls back to its local model
      // instead of waiting on a teardown.
      if (this.#shuttingDown) {
        this.#respond(socket, { ok: false, error: "the embed daemon is shutting down" });
        socket.destroy();
        return;
      }
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let req;
        try {
          req = decodeRequest(line);
        } catch (err) {
          this.#respond(socket, { ok: false, error: err instanceof DaemonProtocolError ? err.message : "Invalid JSON" });
          socket.destroy();
          return;
        }

        if (req.method === "hello") {
          // The preamble, answered from configuration alone - the model is
          // NOT loaded here (bind-before-load). Hello also never re-arms
          // the idle timer: hellos must be free to a daemon whose model no
          // session wants.
          sawHello = true;
          const hello: HelloResponse = { ok: true, model: this.#modelName, version: this.#version, pid: process.pid };
          this.#respond(socket, hello);
          continue;
        }

        if (!sawHello) {
          this.#respond(socket, { ok: false, error: "hello required before embed" });
          socket.destroy();
          return;
        }
        if (embeds > 0) {
          this.#respond(socket, { ok: false, error: "one embed per connection" });
          socket.destroy();
          return;
        }
        embeds += 1;
        // The idle timer re-arms per embed request; a timer that fired
        // mid-request would dispose the model this embed is about to use.
        this.#armIdle();
        this.#inFlight += 1;
        void this.#embedRequest(req).then(
          (vector) => {
            this.#respond(socket, {
              ok: true,
              vector: Array.from(vector),
              model: this.#modelName,
              version: this.#version,
              pid: process.pid,
            });
          },
          (err) => {
            this.#respond(socket, { ok: false, error: err instanceof Error ? err.message : String(err) });
          },
        ).finally(() => {
          this.#inFlight -= 1;
        });
      }
    });
    socket.on("error", () => {
      // Client went away (its own timeout, most likely) - nothing to do.
    });
  }

  async #embedRequest(req: EmbedRequest): Promise<Float32Array> {
    const model = this.#modelForEmbed();
    return req.kind === "query" ? model.queryEmbed(req.text) : model.passageEmbed(req.text);
  }

  #respond(socket: Socket, res: DaemonResponse): void {
    if (!socket.destroyed) socket.write(encodeMessage(res));
  }
}

/** Runs the daemon with production wiring; resolves when the daemon exits. */
export function runEmbedDaemon(deps: EmbedDaemonDeps): Promise<DaemonExit> {
  const daemon = new EmbedDaemon(deps);
  return daemon.serve();
}

/**
 * SQLITE_BUSY (a held lock) is the lock protocol's designed outcome; every
 * other sqlite failure (a corrupt or unwritable lock db) is an error the
 * operator must see, never a "busy" that blocks formation forever.
 */
function isSqliteBusy(err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === "SQLITE_BUSY") return true;
  return err instanceof Error && /database is locked/.test(err.message);
}

/** How the embed daemon's lock db reads: free, held by a live daemon, or
 *  unusable (a corrupt or unwritable file - the doctor's finding). */
export type LockProbe = "free" | "held" | "unusable";

/**
 * Read-only diagnostic for the doctor: is the embed daemon's lock held?
 * Opens the lock db (existsSync-guarded, so nothing is created) and tries
 * its own BEGIN EXCLUSIVE; SQLITE_BUSY means a live daemon holds it. A
 * lock db that cannot be opened or read is "unusable" - a finding for the
 * doctor to report, never a crash.
 */
export function probeEmbedLock(lockPath: string): LockProbe {
  if (!existsSync(lockPath)) return "free";
  let db: Database;
  try {
    db = new Database(lockPath);
  } catch {
    return "unusable";
  }
  try {
    db.exec("PRAGMA busy_timeout = 0");
    try {
      db.exec("BEGIN EXCLUSIVE");
      db.exec("ROLLBACK");
      return "free";
    } catch (err) {
      return isSqliteBusy(err) ? "held" : "unusable";
    }
  } finally {
    db.close();
  }
}
