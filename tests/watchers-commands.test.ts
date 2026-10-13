import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WatcherRegistry,
  commandTargetLabel,
  drainStreamOutput,
  runWatchedCommand,
  withCwdFallback,
  type CommandRunResult,
  type WatcherEvent,
} from "../src/watchers";
import { silenceConsoleError } from "./mocks/console-error";
import { quietGh } from "./mocks/watchers-harness";

test("commandTargetLabel collapses whitespace and clips long commands", () => {
  expect(commandTargetLabel("test -f /tmp/marker")).toBe("test -f /tmp/marker");
  expect(commandTargetLabel("gh   run   list")).toBe("gh run list");
  const long = "a".repeat(80);
  const clipped = commandTargetLabel(long);
  expect(clipped.length).toBeLessThanOrEqual(60);
  expect(clipped.endsWith("...")).toBe(true);
});

// ---------------------------------------------------------------------------
// runWatchedCommand (real processes - the injected-runner tests cannot see
// spawn failures, timeouts, or pipe-holding grandchildren)
// ---------------------------------------------------------------------------

describe("drainStreamOutput", () => {
  // A read that REJECTS is not EOF: the pipe may still be delivering, so
  // the loop backs off and keeps reading instead of ending the drain early
  // (the one-off flake under parallel-suite load). Only the abandonment's
  // cancel settles the loop on an error.
  const flakyReader = (failFirst: number, chunks: string[]) => {
    let reads = 0;
    let emitted = 0;
    return {
      read: async () => {
        reads++;
        if (reads <= failFirst) throw new Error("transient pipe error");
        if (emitted < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[emitted++]) };
        return { done: true, value: undefined };
      },
    } as unknown as ReadableStreamDefaultReader;
  };

  test("a rejected read backs off and keeps reading (error is not EOF)", async () => {
    const text = await drainStreamOutput(flakyReader(2, ["hel", "lo"]), () => false);
    expect(text).toBe("hello");
  });

  test("a cancelled reader settles immediately with what was read", async () => {
    const text = await drainStreamOutput(flakyReader(1, ["never"]), () => true);
    expect(text).toBe("");
  });
});

describe("runWatchedCommand", () => {
  test("reports a clean exit with duration", async () => {
    const result = await runWatchedCommand("exit 0", "/tmp", 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("reports a failing exit and drains stderr", async () => {
    const result = await runWatchedCommand("echo boom-not-found 1>&2; exit 3", "/tmp", 30_000);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("boom-not-found");
  });

  test("kills a hanging command at the timeout and reports timedOut", async () => {
    // The production runner logs each timeout kill; the scope swallows it
    // so the expected kill does not leak into the output.
    const result = await silenceConsoleError(async () => runWatchedCommand("sleep 20", "/tmp", 500));
    expect(result.timedOut).toBe(true);
    // 137 = SIGKILL from the watchdog. Consumers only read the timedOut
    // flag; the raw code is informational.
    expect(result.exitCode).toBe(137);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  test("survives a grandchild holding the pipe open past the kill", async () => {
    // The command backgrounds a long-lived child that inherits stdout's
    // write end and never exits. bash dies at the timeout; the grandchild
    // keeps the pipe open. Without the drain race this call would hang
    // forever - which is exactly the shared-poll-cycle stall the race exists
    // to prevent.
    const started = Date.now();
    const result = await runWatchedCommand('sleep 20 & echo started; wait', "/tmp", 500);
    expect(result.timedOut).toBe(true);
    // The abandoned-drain return shape: 124 sentinel, nothing captured.
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toBe("");
    // deadline = timeout + grace; allow generous CI slack on top.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  test("refuses a nonexistent working directory with a real error", async () => {
    let threw: unknown = null;
    try {
      await runWatchedCommand("true", "/definitely/not/a/real/dir", 30_000);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("project directory");
  });
});

// ---------------------------------------------------------------------------
// Poll-cycle resilience: a throwing gate or a hung gh call must not kill the
// poller (the same failure class as a hung watched command)
// ---------------------------------------------------------------------------

describe("poll resilience", () => {
  test("a throwing canDeliver gate fails closed and leaves the mail pending", async () => {
    const delivered: Array<{ sessionID: string; events: WatcherEvent[] }> = [];
    // The fail-closed path logs the gate error; the scope swallows it for
    // clean output.
    const reg = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        delivered.push({ sessionID, events });
      },
      canDeliver: () => {
        throw new Error("server unreachable");
      },
      ghRunner: quietGh(),
      pollIntervalMs: 60_000,
    });
    await silenceConsoleError(async () => {
      await reg.createPr("s1", "acme/widgets", 7, ["pr_commit"]);
      const w = reg.listForSession("s1")[0];
      if (w.source !== "pr") throw new Error("expected a pr watcher");
      w.state.headSha = "old";
      // Must not throw out of poll - a throw here would be an unhandled
      // rejection in the host process and would wedge the #polling guard.
      await reg.poll();
      expect(reg.pendingCount("s1")).toBe(1);
      expect(delivered).toHaveLength(0);
    });
    reg.dispose();
  });

  test("ghApiRun races its drain: a fake gh whose child holds the pipe still resolves", async () => {
    // A fake `gh` that backgrounds a pipe-holding sleeper and exits 1. The
    // orphaned sleeper inherits the output pipe's write end, so stdout never
    // EOFs and ghApiRun's drain loses the race - it must reject cleanly
    // instead of hanging until the sleeper exits.
    //
    // Bun resolves spawned binaries from the PATH the PROCESS was started
    // with, so mutating process.env.PATH in-process does not select the fake.
    // Run a child bun with the fake gh on its PATH from birth; the child
    // calls the parameterized transport with a small timeout and prints the
    // outcome.
    const binDir = mkdtempSync(join(tmpdir(), "thatch-fake-gh-"));
    writeFileSync(join(binDir, "gh"), "#!/bin/sh\nsleep 30 &\nexit 1\n", { mode: 0o755 });
    const childScript = `
      const { ghApiRunWithTimeout } = await import(${JSON.stringify(join(process.cwd(), "src/watchers.ts"))});
      const t0 = Date.now();
      try { await ghApiRunWithTimeout(["/x"], 500); console.log("UNEXPECTED-SUCCESS"); }
      catch (e) { console.log(JSON.stringify({ ms: Date.now() - t0, msg: e.message })); }
    `;
    try {
      const proc = Bun.spawn(["bun", "-e", childScript], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const line = out.split("\n").find((l) => l.startsWith("{"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line!);
      // The load-bearing contract: the call rejects PROMPTLY instead of
      // hanging until the sleeper exits 30s later. Which error lands is
      // Bun's coin flip - the drain may see EOF right after the kill
      // (Bun closes the pipe: "failed (exit 137)") or the abandonment
      // deadline may win (the orphaned-child timeout message) - both
      // reject cleanly and neither is a hang.
      expect(parsed.ms).toBeLessThan(15_000);
      expect(parsed.msg).toMatch(/timed out|failed \(exit/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
// withCwdFallback: per-poll cwd resolution for the watcher runner
// ---------------------------------------------------------------------------

describe("withCwdFallback", () => {
  const base = async (command: string, cwd: string): Promise<CommandRunResult> => ({
    exitCode: 0,
    timedOut: false,
    stderr: `ran-in:${cwd}:${command}`,
    durationMs: 10,
  });

  test("a live directory resolves to itself - the base runner gets the original cwd", async () => {
    const seen: string[] = [];
    const runner = withCwdFallback(
      async (command, cwd) => {
        seen.push(cwd);
        return base(command, cwd);
      },
      async (cwd) => cwd,
    );
    await runner("check", "/live/dir", 1000);
    expect(seen).toEqual(["/live/dir"]);
  });

  test("a dead directory falls back to the resolver's path", async () => {
    const fallbacks: [string, string][] = [];
    const runner = withCwdFallback(
      async (command, cwd) => base(command, cwd),
      async (cwd) => (cwd === "/dead/wt" ? "/main/checkout" : cwd),
      (from, to) => fallbacks.push([from, to]),
    );
    const result = await runner("check", "/dead/wt", 1000);
    expect(result.stderr).toBe("ran-in:/main/checkout:check");
    expect(fallbacks).toEqual([["/dead/wt", "/main/checkout"]]);
  });

  test("the fallback logs once per dead directory, not per poll", async () => {
    const fallbacks: [string, string][] = [];
    const runner = withCwdFallback(
      async (command, cwd) => base(command, cwd),
      async (cwd) => (cwd === "/dead/wt" ? "/main/checkout" : cwd),
      (from, to) => fallbacks.push([from, to]),
    );
    for (let i = 0; i < 5; i++) await runner("check", "/dead/wt", 1000);
    expect(fallbacks).toHaveLength(1);
  });

  test("a null resolution keeps the original cwd, which then fails as before", async () => {
    const seen: string[] = [];
    const runner = withCwdFallback(
      async (command, cwd) => {
        seen.push(cwd);
        return base(command, cwd);
      },
      async () => null,
      () => {
        throw new Error("must not report a fallback that did not happen");
      },
    );
    await runner("check", "/dead/wt", 1000);
    expect(seen).toEqual(["/dead/wt"]);
  });
});
