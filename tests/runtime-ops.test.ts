import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, sleep, spawn, spawnSync, which } from "../src/runtime-ops";
import { mcpSessionID } from "../src/chat";

/**
 * The runtime-ops layer (src/runtime-ops.ts) replaced bun's runtime
 * globals with node-API implementations so the same source runs under
 * node and bun (docs/plans/node-sqlite-driver.md, D14). The SHA-256
 * parity case is the load-bearing one: chat identities are STORED under
 * the hex digest the old Bun.SHA256.hash call produced, so the node
 * crypto path must be byte-identical or every stored identity splits.
 */

describe("sha256Hex parity with Bun.SHA256.hash", () => {
  const cases = [
    ["empty", ""],
    ["ascii", "hello world"],
    ["unicode", "grüße // 日本語 // 🐗"],
    ["session-id shape", "abc123-DEFG-hijklmnop-4567"],
    ["long", "x".repeat(10_000)],
  ] as const;

  for (const [name, text] of cases) {
    test(`byte-identical hex: ${name}`, () => {
      expect(sha256Hex(text)).toBe(Bun.SHA256.hash(text, "hex"));
    });
  }

  test("mcpSessionID digest shape is unchanged (64-hex slice of 12)", () => {
    const id = mcpSessionID("sess_test_0001");
    expect(id).toMatch(/^mcp_[0-9a-f]{12}$/);
    expect(id.slice(4)).toBe(sha256Hex("sess_test_0001").slice(0, 12));
  });
});

describe("spawnSync", () => {
  test("captures the exit code and piped stdout", () => {
    const res = spawnSync(["echo", "thatch-spawn-sync"], { stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("thatch-spawn-sync\n");
  });

  test("a missing binary arrives as exitCode null, not a throw", () => {
    const res = spawnSync(["thatch-definitely-not-a-binary-xyz"], { stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode).toBeNull();
  });

  test("inherited streams yield empty buffers", () => {
    const res = spawnSync(["echo", "inherit-me"], { stdout: "inherit", stderr: "inherit" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("");
  });
});

describe("spawn", () => {
  test("exposes the pipes as web readers and the exit code via exited", async () => {
    const proc = spawn(["sh", "-c", "echo out-line; echo err-line 1>&2"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(stdout).toBe("out-line\n");
    expect(stderr).toBe("err-line\n");
    expect(code).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  test("kill settles exited with bun's 128+signal shape", async () => {
    const proc = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    proc.kill("SIGKILL");
    expect(await proc.exited).toBe(137);
  });

  test("a nonexistent cwd and a missing binary throw at the call site (bun parity)", () => {
    expect(() => spawn(["true"], { cwd: "/definitely/not/a/real/dir" })).toThrow(/ENOENT|no such file/);
    expect(() => spawn(["thatch-definitely-not-a-binary-xyz"])).toThrow("ENOENT");
  });
});

describe("which", () => {
  test("finds an executable on a stub PATH and ignores a non-executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-runtime-ops-which-"));
    try {
      const bin = join(dir, "stubbed-bin");
      writeFileSync(bin, "#!/bin/sh\ntrue\n");
      chmodSync(bin, 0o755);
      const plain = join(dir, "stubbed-plain");
      writeFileSync(plain, "not executable");
      const found = withPath(dir, () => which("stubbed-bin"));
      expect(found).toBe(bin);
      const notFound = withPath(dir, () => which("stubbed-plain"));
      expect(notFound).toBeNull();
      expect(withPath(dir, () => which("absent-binary-name"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stdinText", () => {
  test("reads a piped payload from a child process", () => {
    // Run stdinText in a child with piped stdin: the test process's own
    // stdin belongs to the test runner.
    const modulePath = join(import.meta.dir, "..", "src", "runtime-ops.ts");
    const script = `const { stdinText } = require(${JSON.stringify(modulePath)}); stdinText().then((t) => console.log("GOT:" + t.trim()));`;
    const res = spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", input: "payload-from-pipe\n" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("GOT:payload-from-pipe");
  });
});

function withPath<T>(dir: string, fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = dir;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}

describe("sleep", () => {
  test("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
