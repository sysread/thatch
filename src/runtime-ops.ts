/**
 * Runtime operations over the Node.js APIs, ported off bun's runtime
 * globals for the node:sqlite driver plan (docs/plans/node-sqlite-driver.md,
 * D14). Both supported runtimes implement the node: builtins used here
 * (node >= 22.13, bun >= 1.4.2), so the same source runs under either;
 * before this module the call sites coupled to Bun.spawn, Bun.spawnSync,
 * Bun.SHA256.hash, Bun.which, Bun.stdin, and Bun.sleep.
 *
 * The surfaces keep their bun shapes so call sites change only their
 * import line: spawn returns web-stream readers, an `exited` promise,
 * and kill (the subset of bun's Bun.Subprocess the call sites use);
 * spawnSync returns `exitCode` plus Buffers. Tests inject mocks through
 * each site's existing injectable-deps pattern; the defaults here are
 * the real implementations.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, accessSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

/**
 * SHA-256 of a UTF-8 string as lowercase hex. Byte-identical to bun's
 * `Bun.SHA256.hash(text, "hex")` - pinned by tests/runtime-ops.test.ts,
 * because chat identities are STORED under the digest this function
 * produces (a different byte sequence would split every stored identity).
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Resolves after `ms` milliseconds - the Bun.sleep shape. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

/** All of stdin as UTF-8 text - the Bun.stdin.text() shape. Resolves
 * empty on a TTY (no payload is coming) and rejects on a read error. */
export function stdinText(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolveStdin, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolveStdin(Buffer.concat(chunks).toString()));
    process.stdin.on("error", reject);
  });
}

/** The absolute path of an executable, null when absent - the Bun.which
 * shape. Bare names scan PATH for an executable regular file; paths
 * (absolute or ./relative) resolve against the cwd. */
export function which(bin: string): string | null {
  const candidates = isAbsolute(bin) || bin.includes("/")
    ? [resolve(bin)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not a file or not executable here; keep scanning.
    }
  }
  return null;
}

/** stdio modes the spawn sites use; bun's spellings, mapped to node's. */
export type StdioMode = "pipe" | "ignore" | "inherit";

export interface SpawnOptions {
  stdout?: StdioMode;
  stderr?: StdioMode;
  cwd?: string;
  detached?: boolean;
}

/**
 * The subset of bun's Bun.Subprocess surface the call sites use: web
 * readers over the pipes (proc.stdout.getReader(), Response consumption),
 * the exited promise, kill, and unref. The streams are node streams
 * wrapped with Readable.toWeb, so the bun-era drain code reads them
 * unchanged.
 */
export interface Subprocess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;  exited: Promise<number | null>;
  /** The exit code once `exited` resolved; null while running or when
   * the child died to a signal. */
  readonly exitCode: number | null;
  kill(signal?: string): void;
  unref(): void;
}

function toStdio(mode: StdioMode | undefined): "pipe" | "ignore" | "inherit" {
  return mode ?? "pipe";
}

export function spawn(cmd: string[], opts: SpawnOptions = {}): Subprocess {
  assertSpawnable(cmd[0]!, opts.cwd);
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    detached: opts.detached,
    // No call site feeds the child's stdin; bun's default (ignore) is
    // kept so a child cannot block on a never-written pipe.
    stdio: ["ignore", toStdio(opts.stdout), toStdio(opts.stderr)],
  });
  // Failure to start (ENOEXEC-class) arrives as an async node error
  // event; swallow it and let `exited` settle - bun's spawn THROWS at
  // the call site instead, which assertSpawnable already did for the
  // two cases the call sites actually exercise (bad cwd, missing binary).
  child.on("error", () => {});
  let exitCode: number | null = null;
  const webStdout = () =>
    child.stdout ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>) : emptyStream();
  const webStderr = () =>
    child.stderr ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>) : emptyStream();
  return {
    get stdout() {
      return webStdout();
    },
    get stderr() {
      return webStderr();
    },
    exited: new Promise<number | null>((resolveExit) => {
      // "close", not "exit": with piped stdio, exit fires before the
      // pipes drain, and the exit code is only final once the streams
      // close. A signal death arrives as (null, signal); bun's exited
      // reports it as 128+signal (137 for the SIGKILL watchdog paths).
      child.on("close", (code, signal) => {
        const result = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : null);
        exitCode = result;
        resolveExit(result);
      });
    }),
    get exitCode() {
      return exitCode;
    },
    kill(signal = "SIGTERM") {
      child.kill(signal as never);
    },
    unref() {
      child.unref();
    },
  };
}

/** Bun's spawn throws at the CALL SITE when the child cannot start; node
 * defers to an async error event. The call sites' error handling (and the
 * tests pinning it) expects the synchronous throw, so the two cases that
 * occur in practice - a nonexistent cwd and an unresolvable binary - are
 * checked up front. */
function assertSpawnable(bin: string, cwd: string | undefined): void {
  if (cwd !== undefined) statSync(cwd);
  if (bin.includes("/")) {
    try {
      statSync(bin);
    } catch {
      throw spawnEnoent(bin);
    }
    return;
  }
  if (which(bin) === null) throw spawnEnoent(bin);
}

function spawnEnoent(bin: string): Error {
  const err: Error & { code?: string } = new Error(`spawn ${bin} ENOENT`);
  err.code = "ENOENT";
  return err;
}

export interface SpawnSyncResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Synchronous subprocess run - the Bun.spawnSync shape: `exitCode`
 * plus Buffers for the piped streams (empty when inherited). A missing
 * binary arrives as exitCode null, not a throw. `input` feeds the
 * child's stdin as UTF-8. */
export function spawnSync(
  cmd: string[],
  opts: { stdout?: StdioMode; stderr?: StdioMode; input?: string; cwd?: string } = {},
): SpawnSyncResult {
  const res = nodeSpawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    stdio: [opts.input === undefined ? "ignore" : "pipe", toStdio(opts.stdout), toStdio(opts.stderr)],
    input: opts.input,
  });
  return {
    exitCode: res.status ?? null,
    stdout: (res.stdout as Buffer | null) ?? Buffer.alloc(0),
    stderr: (res.stderr as Buffer | null) ?? Buffer.alloc(0),
  };
}

/** A closed stream for the stdio modes that carry no data ("ignore",
 * "inherit"): bun's Subprocess still exposes stream objects there. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
