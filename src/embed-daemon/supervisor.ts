/**
 * The embed daemon's spawn-once logic: ensureDaemonRunning. Called by the
 * client resolver when the initial probe found no listener; a manual
 * `thatch embed-daemon` run fills the same role by hand, without this
 * spawn step.
 *
 * ONE spawn attempt per process, guarded by a module-level promise - the
 * `activeChecker` singleton idiom from src/version-check.ts. Deterministic
 * lifecycle is the point: per-embed spawn attempts would stampede under
 * race conditions (N sessions mass-starting on one DB path), and a session
 * that failed once should not retry in a loop while the machine is busy.
 * A new daemon arrives when a new session resolves, or when someone runs
 * `thatch embed-daemon` by hand.
 *
 * All inputs are injected for tests (the connect probe, the spawn command
 * builder, the wait timeout); _resetForTesting clears the memo between
 * cases, because bun shares one process across all test files.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { DaemonProtocolError, decodeResponse, encodeMessage } from "./protocol";
import type { HelloResponse } from "./protocol";
import { dialSocket } from "./socket";
import type { Socket } from "node:net";

export type ProbeResult = { ok: true; hello: HelloResponse } | { ok: false; reason: string };

export interface SupervisorDeps {
  socketPath: string;
  /** Builds the spawn command. Defaults to this process's own binary plus
   *  the `embed-daemon` subcommand: process.execPath + process.argv[1] is
   *  the bin script in both the standalone and the bundled mode, so the
   *  daemon always runs the same checkout as the session that spawned it. */
  spawnCommand?: () => string[];
  /** Performs the spawn. Default: detached, stdio ignored, env inherited. */
  spawn?: (cmd: string[]) => void;
  /** The connect probe (a hello handshake). Default: a real socket client. */
  probe?: () => Promise<ProbeResult>;
  /** How long to wait for the socket after spawning. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export type SupervisorOutcome = "running" | "failed";

function defaultSpawnCommand(): string[] {
  return [process.execPath, process.argv[1] ?? "", "embed-daemon"];
}

function defaultSpawn(cmd: string[]): void {
  const proc = nodeSpawn(cmd[0]!, cmd.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
}

/**
 * The real connect probe: one hello handshake against the socket. Read-only
 * by contract - unlike the sideband client, NO unlink on failure (the
 * daemon owns the endpoint; the next daemon unlinks a stale socket under
 * the lock).
 */
export function helloProbe(socketPath: string, timeoutMs = 500): () => Promise<ProbeResult> {
  return async () => {
    let socket: Socket;
    try {
      socket = await dialSocket(socketPath, timeoutMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return { ok: false, reason: `connect failed (${code ?? (err instanceof Error ? err.message : String(err))})` };
    }
    return await new Promise<ProbeResult>((resolve) => {
      let buf = "";
      const done = (result: ProbeResult) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, reason: "hello timed out" }), timeoutMs);
      socket.once("error", (err: NodeJS.ErrnoException) => {
        done({ ok: false, reason: `connect failed (${err.code ?? err.message})` });
      });
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        try {
          const res = decodeResponse(buf.slice(0, nl));
          if (res.ok) done({ ok: true, hello: res });
          else done({ ok: false, reason: res.error });
        } catch (err) {
          done({ ok: false, reason: err instanceof DaemonProtocolError ? err.message : "malformed hello" });
        }
      });
      socket.write(encodeMessage({ method: "hello" }));
    });
  };
}

async function runOnce(deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const probe = deps.probe ?? helloProbe(deps.socketPath);
  // A daemon another session spawned may already be up between the
  // resolver's probe and this one - probe first, spawn only on a miss.
  if ((await probe()).ok) return "running";

  const cmd = (deps.spawnCommand ?? defaultSpawnCommand)();
  (deps.spawn ?? defaultSpawn)(cmd);

  const waitTimeoutMs = deps.waitTimeoutMs ?? 2000;
  const pollIntervalMs = deps.pollIntervalMs ?? 50;
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    if (Date.now() >= deadline) return "failed";
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    // Bind-before-load: the daemon answers hello before its model loads, so
    // this wait runs at process-start speed, never model-load speed.
    if ((await probe()).ok) return "running";
  }
}

let active: Promise<SupervisorOutcome> | null = null;

export function ensureDaemonRunning(deps: SupervisorDeps): Promise<SupervisorOutcome> {
  active ??= runOnce(deps).catch((err) => {
    // A rejected attempt clears the memo so a later caller can retry (the
    // same memo-clearing BgeEmbeddingModel.load does) - a memoized
    // rejection would poison every embed for the process lifetime.
    active = null;
    throw err;
  });
  return active;
}

export function _resetForTesting(): void {
  active = null;
}
