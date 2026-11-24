import { describe, test, expect, beforeEach } from "bun:test";
import { ensureDaemonRunning, _resetForTesting, type ProbeResult } from "../../src/embed-daemon/supervisor";
import pkg from "../../package.json";

// The spawn-once unit tier: injected probe/spawn, _resetForTesting between
// cases (bun shares one process across all test files).

let spawnCalls: string[][];

function fakeDeps(over: Partial<Parameters<typeof ensureDaemonRunning>[0]> = {}) {
  const probes: ProbeResult[] = [];
  return {
    deps: {
      socketPath: "/tmp/fake-embed.sock",
      probe: async (): Promise<ProbeResult> => probes.length > 0 ? probes.shift()! : { ok: false, reason: "connect failed (ENOENT)" },
      spawn: (cmd: string[]) => {
        spawnCalls.push(cmd);
      },
      spawnCommand: () => ["fake-bin", "embed-daemon"],
      waitTimeoutMs: 200,
      pollIntervalMs: 10,
      ...over,
    },
    // setProbes scripts the subsequent probes: the probe function consumes
    // the list front-first (the initial probe, then one per poll).
    setProbes: (results: ProbeResult[]) => {
      probes.length = 0;
      probes.push(...results);
    },
  };
}

beforeEach(() => {
  spawnCalls = [];
  _resetForTesting();
});

describe("ensureDaemonRunning", () => {
  test("a probe hit skips the spawn", async () => {
    const { deps, setProbes } = fakeDeps();
    // The version value is inert here: ensureDaemonRunning's probe path
    // never compares it (only the connected client's skew detector does).
    setProbes([{ ok: true, hello: { ok: true, model: "mock", version: pkg.version, pid: 1 } }]);
    const outcome = await ensureDaemonRunning(deps);
    expect(outcome).toBe("running");
    expect(spawnCalls).toHaveLength(0);
  });

  test("one spawn attempt per process, however many callers", async () => {
    const { deps, setProbes } = fakeDeps();
    setProbes([{ ok: true, hello: { ok: true, model: "mock", version: pkg.version, pid: 1 } }]);
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    expect(spawnCalls).toHaveLength(0);
  });

  test("spawns when the first probe misses, then runs at socket speed", async () => {
    // The daemon comes up after three poll misses: the initial probe and
    // the first two polls miss, the third poll hits.
    const { deps, setProbes } = fakeDeps();
    setProbes([
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: true, hello: { ok: true, model: "mock", version: pkg.version, pid: 2 } },
    ]);
    const outcome = await ensureDaemonRunning(deps);
    expect(outcome).toBe("running");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(["fake-bin", "embed-daemon"]);
  });

  test("the daemon never coming up fails the wait", async () => {
    const { deps } = fakeDeps();
    const outcome = await ensureDaemonRunning(deps);
    expect(outcome).toBe("failed");
    expect(spawnCalls).toHaveLength(1);
  });

  test("a throwing spawn rejects once and clears the memo for a later retry", async () => {
    // Bun.spawn can throw synchronously (EAGAIN/ENOMEM). The rejection
    // reaches the caller once; the memo must clear so a later caller
    // retries instead of rethrowing the poisoned promise forever.
    let spawnAttempts = 0;
    const { deps, setProbes } = fakeDeps({
      spawn: () => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) throw new Error("spawn failed: EAGAIN");
      },
    });
    setProbes([
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: true, hello: { ok: true, model: "mock", version: pkg.version, pid: 3 } },
    ]);
    await expect(ensureDaemonRunning(deps)).rejects.toThrow("EAGAIN");
    expect(spawnAttempts).toBe(1);
    // The memo cleared: the next caller runs the policy again (its probe
    // hits, so no second spawn).
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    expect(spawnAttempts).toBe(1);
  });
});
