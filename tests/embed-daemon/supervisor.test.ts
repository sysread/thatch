import { describe, test, expect, beforeEach } from "bun:test";
import { ensureDaemonRunning, _resetForTesting, type ProbeResult } from "../../src/embed-daemon/supervisor";

// The spawn-once unit tier: injected probe/spawn, _resetForTesting between
// cases (bun shares one process across all test files).

let spawnCalls: string[][];

function fakeDeps(over: Partial<Parameters<typeof ensureDaemonRunning>[0]> = {}) {
  const probes: ProbeResult[] = [];
  return {
    deps: {
      socketPath: "/tmp/fake-embed.sock",
      probe: async (): Promise<ProbeResult> => probes.length > 0 ? probes.pop()! : { ok: false, reason: "connect failed (ENOENT)" },
      spawn: (cmd: string[]) => {
        spawnCalls.push(cmd);
      },
      spawnCommand: () => ["fake-bin", "embed-daemon"],
      waitTimeoutMs: 200,
      pollIntervalMs: 10,
      ...over,
    },
    // queueProbe lets a test script what subsequent probes return: the
    // probe function pops from the FRONT by re-reading via closure below.
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
    setProbes([{ ok: true, hello: { ok: true, model: "mock", version: "0.4.3", pid: 1 } }]);
    const outcome = await ensureDaemonRunning(deps);
    expect(outcome).toBe("running");
    expect(spawnCalls).toHaveLength(0);
  });

  test("one spawn attempt per process, however many callers", async () => {
    const { deps, setProbes } = fakeDeps();
    setProbes([{ ok: true, hello: { ok: true, model: "mock", version: "0.4.3", pid: 1 } }]);
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    await expect(ensureDaemonRunning(deps)).resolves.toBe("running");
    expect(spawnCalls).toHaveLength(0);
  });

  test("spawns when the first probe misses, then runs at socket speed", async () => {
    // The daemon comes up after two poll misses: the probe list is
    // consumed front-first (miss, miss from the initial probe plus the
    // first poll, then a hit).
    let probesLeft: ProbeResult[] = [
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: false, reason: "connect failed (ENOENT)" },
      { ok: true, hello: { ok: true, model: "mock", version: "0.4.3", pid: 2 } },
    ];
    const deps = {
      socketPath: "/tmp/fake-embed.sock",
      probe: async (): Promise<ProbeResult> => probesLeft.shift() ?? { ok: false, reason: "connect failed (ENOENT)" },
      spawn: (cmd: string[]) => spawnCalls.push(cmd),
      spawnCommand: () => ["fake-bin", "embed-daemon"],
      waitTimeoutMs: 2000,
      pollIntervalMs: 10,
    };
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
});
