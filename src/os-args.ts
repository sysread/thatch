import { readFileSync } from "node:fs";

/**
 * Parses the session id a harness was started to continue from an argument
 * list (`opencode -s <id>` / `--session <id>` / `--session=<id>`). Pure:
 * the caller supplies the list (see startupSessionId for where it comes
 * from). The framework passes no session id to plugins and resuming a
 * session fires no events, so the command line is the only signal that a
 * fresh harness is the new home of a continued session.
 */
export function startupSessionIdFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-s" || arg === "--session") return argv[i + 1] ?? null;
    if (arg.startsWith("--session=")) return arg.slice("--session=".length) || null;
  }
  return null;
}

/**
 * Whether the harness was started with `-c`/`--continue` (continue the most
 * recent session). Pure. Yargs-style boolean flags only: `--continue=false`
 * reads as the negation, everything else as a plain switch. The session id
 * itself is not on the command line - the harness resolves "most recent
 * top-level session" at startup, which the plugin replicates via the SDK
 * (continuesLastSessionId).
 */
export function continuesLastSessionFromArgv(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "-c" || arg === "--continue") return true;
    if (arg.startsWith("--continue=")) return arg.slice("--continue=".length) !== "false";
  }
  return false;
}

/**
 * Picks the session `opencode -c` continues: the most recently updated
 * top-level session. Pure; the caller supplies the session list from
 * client.session.list() (directory-scoped, like the plugin's own client).
 * The server's list order is not trusted - the TUI re-sorts by
 * time.updated before picking, and so does this.
 */
export function continuesLastSessionId(
  sessions: { id: string; parentID?: string; time?: { updated?: number } }[],
): string | null {
  return (
    [...sessions]
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .find((s) => !s.parentID)?.id ?? null
  );
}

// The plugin does not run in the process's main thread: opencode's TUI
// spawns a worker thread (cli/tui/worker.js) to host the server, and worker
// threads get their own argv (just the worker script) with none of the CLI
// flags. The thread still shares the process's pid, so the OS-level command
// line for our own pid is the real `opencode -s ses_...` invocation. Read it
// from /proc on Linux or via ps on macOS. Returns [] when unavailable;
// callers treat that as "no session flag". The readers are injectable so
// tests can drive each branch without a real /proc or ps.
export interface OsArgsDeps {
  /** Reads a file as UTF-8, throwing when it does not exist. */
  readFile: (path: string) => string;
  /** Runs `ps -p <pid> -o args=`; returns its exit code and stdout. */
  ps: (pid: number) => { exitCode: number; stdout: string };
}

const defaultOsArgsDeps: OsArgsDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  ps: (pid) => {
    const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]);
    return { exitCode: res.exitCode, stdout: res.stdout.toString() };
  },
};

export function osProcessArgs(deps: OsArgsDeps = defaultOsArgsDeps, pid = process.pid): string[] {
  try {
    // Linux: cmdline is NUL-separated argv, exact and cheap.
    return deps.readFile("/proc/self/cmdline").split("\0").filter(Boolean);
  } catch {
    // macOS has no /proc; ask ps for this pid's full command. Splitting on
    // whitespace is safe for our purpose: session ids never contain spaces.
    try {
      const res = deps.ps(pid);
      if (res.exitCode !== 0) return [];
      return res.stdout.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }
}

// Resolve the session id this harness was launched to resume, if any:
// prefer the thread-local argv (covers tests and any non-worker host), then
// fall back to the process's OS-level command line (the real harness path).
// The caller passes the OS command line in so it is read once per init.
export function startupSessionId(osArgs: string[]): string | null {
  return startupSessionIdFromArgv(process.argv) ?? startupSessionIdFromArgv(osArgs);
}
