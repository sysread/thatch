import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginLifecycle, type PluginLifecycleDeps } from "../src/claude-plugin/lifecycle";
import type { Config } from "../src/config";

// The plugin lifecycle's verdicts, pure against spies (no db, no model
// touch: the alerts machine's roundShape comes from the mod's turn
// reports; delivery is a spy). The classifier itself is covered by
// tests/alerts.test.ts - these pin the plugin-regime MAPPING.

function makeLifecycle(alertOverrides?: Partial<Config["alerts"]>) {
  // Per-harness spy: delivery is fire-and-forget, so a SHARED array would
  // let one test's late delivery pollute the next test's window.
  const notified: { kind: string; message: string }[] = [];
  const deps: PluginLifecycleDeps = {
    db: { findChatSession: () => ({ session_id: "x", name: "lifecyc-under-test", topic: null, project: "p", host_kind: "mcp", registered_at: "", last_seen: "", worktree: "" }) } as never,
    model: {} as never,
    repo: "test/repo",
    dbPath: "/tmp/unused.db",
    config: {
      notifications: { mode: "banner" },
      alerts: { pause: { mode: "none" }, done: { mode: "banner" }, error: { mode: "banner" }, ...alertOverrides },
    } as unknown as Config,
    notify: async (input) => {
      notified.push({ kind: input.kind, message: input.message });
    },
  };
  return { lifecycle: createPluginLifecycle(deps), notified };
}

const spyAlerts = (overrides?: Partial<Config["alerts"]>) => {
  const { lifecycle, notified } = makeLifecycle(overrides);
  return {
    lc: lifecycle,
    notified,
    run: async (event: Parameters<ReturnType<typeof createPluginLifecycle>["handle"]>[0]) => lifecycle.handle(event),
  };
};

describe("plugin lifecycle: alert mapping", () => {
  test("busy + realwork + complete (clean, real work) -> done alert", async () => {
    const h = spyAlerts();
    await h.run({ event: "busy", sessionID: "s1" });
    await h.run({ event: "realwork", sessionID: "s1", tool: "Bash" });
    await h.run({ event: "complete", sessionID: "s1", isAborted: false });
    expect(h.notified.map((n) => n.kind)).toEqual(["done"]);
  });

  test("the meta/no-work tool filter: meta tools and todowrite never mark work", async () => {
    const h = spyAlerts();
    await h.run({ event: "busy", sessionID: "s2" });
    await h.run({ event: "realwork", sessionID: "s2", tool: "mcp__thatch__memory_recall" });
    await h.run({ event: "realwork", sessionID: "s2", tool: "todowrite" });
    await h.run({ event: "realwork", sessionID: "s2", tool: "question" });
    await h.run({ event: "complete", sessionID: "s2", isAborted: false });
    // No real work -> the done alert stays silent (the machine's verdict
    // is silence; the only delivery here would be a "done" whose absence
    // is the point).
    expect(h.notified.map((n) => n.kind)).toEqual([]);
  });

  test("abort maps to the silent error class: no alert on complete", async () => {
    const h = spyAlerts();
    await h.run({ event: "busy", sessionID: "s3" });
    await h.run({ event: "realwork", sessionID: "s3", tool: "Bash" });
    await h.run({ event: "complete", sessionID: "s3", isAborted: true });
    expect(h.notified).toEqual([]);
  });

  test("a provider error (classic.StopFailure) routes the verdict to error", async () => {
    const h = spyAlerts();
    await h.run({ event: "busy", sessionID: "s4" });
    await h.run({ event: "error", sessionID: "s4", error: "ProviderError" });
    await h.run({ event: "complete", sessionID: "s4", isAborted: false });
    expect(h.notified.map((n) => n.kind)).toEqual(["error"]);
  });
});

describe("plugin lifecycle: wrap-up arms", () => {
  test("arm -> greenlight -> complete resolves the action once", async () => {
    const h = spyAlerts();
    const arm = await h.run({ event: "arm", sessionID: "w1", kind: "compact" });
    expect(arm.text).toContain("Wrap-up armed");
    const gl = await h.run({ event: "greenlight", sessionID: "w1", kind: "compact" });
    expect(gl.text).toContain("[greenlit]");
    const done = await h.run({ event: "complete", sessionID: "w1", isAborted: false });
    expect(done.wrapup).toBe("compact");
    // The arm is consumed: a second complete resolves nothing.
    const again = await h.run({ event: "complete", sessionID: "w1", isAborted: false });
    expect(again.wrapup).toBeUndefined();
  });

  test("greenlight without arm teaches the contract (accept-then-teach)", async () => {
    const h = spyAlerts();
    const gl = await h.run({ event: "greenlight", sessionID: "w2", kind: "exit" });
    expect(gl.text).toContain("[not armed]");
    expect(gl.text).toContain("/thatch_exit");
  });

  test("arms are per-session and per-kind", async () => {
    const h = spyAlerts();
    await h.run({ event: "arm", sessionID: "w3", kind: "compact" });
    const wrongSession = await h.run({ event: "greenlight", sessionID: "w4", kind: "compact" });
    expect(wrongSession.text).toContain("[not armed]");
    const wrongKind = await h.run({ event: "greenlight", sessionID: "w3", kind: "exit" });
    expect(wrongKind.text).toContain("[not armed]");
  });
});

describe("plugin lifecycle: pause asks", () => {
  test("ask notifies once per request id; resolved clears it", async () => {
    const h = spyAlerts({ pause: { mode: "banner" } });
    await h.run({ event: "ask", sessionID: "a1", kind: "permission", requestID: "r1" });
    await h.run({ event: "ask", sessionID: "a1", kind: "permission", requestID: "r1" });
    expect(h.notified.filter((n) => n.kind === "pause").length).toBe(1);
    await h.run({ event: "resolved", sessionID: "a1", requestID: "r1" });
    await h.run({ event: "ask", sessionID: "a1", kind: "permission", requestID: "r1" });
    expect(h.notified.filter((n) => n.kind === "pause").length).toBe(2);
  });
});

describe("plugin lifecycle: the buffer push (Step D)", () => {
  test("realwork buffers the interaction with input + result (THATCH_QUEUE_DIR isolated)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-buffer-"));
    process.env.THATCH_QUEUE_DIR = dir;
    try {
      const h = spyAlerts();
      await h.run({ event: "busy", sessionID: "b1" });
      await h.run({ event: "realwork", sessionID: "b1", tool: "Bash", args: { command: "ls" }, result: "file1" });
      // The push IS the buffer: the queue file now holds the interaction.
      const { peekQueue } = await import("../src/extract-queue");
      const queued = peekQueue("b1");
      expect(queued.length).toBe(1);
      expect(queued[0].tool).toBe("Bash");
      expect(queued[0].args).toEqual({ command: "ls" });
      expect(queued[0].output).toBe("file1");
      // And the work mark rode the same site.
      await h.run({ event: "complete", sessionID: "b1", isAborted: false });
      expect(h.notified.map((n) => n.kind)).toEqual(["done"]);
    } finally {
      delete process.env.THATCH_QUEUE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("meta tools and thatch-spelled calls neither buffer nor mark work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-buffer2-"));
    process.env.THATCH_QUEUE_DIR = dir;
    try {
      const h = spyAlerts();
      await h.run({ event: "busy", sessionID: "b2" });
      await h.run({ event: "realwork", sessionID: "b2", tool: "mcp__thatch__chat_read", args: {}, result: "mail" });
      await h.run({ event: "realwork", sessionID: "b2", tool: "Skill", args: {}, result: "loaded" });
      const { peekQueue } = await import("../src/extract-queue");
      expect(peekQueue("b2")).toEqual([]);
      await h.run({ event: "complete", sessionID: "b2", isAborted: false });
      expect(h.notified).toEqual([]);
    } finally {
      delete process.env.THATCH_QUEUE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the memory_remember save drains the queue (the appendBatch gate, server-side)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-buffer3-"));
    process.env.THATCH_QUEUE_DIR = dir;
    try {
      const h = spyAlerts();
      await h.run({ event: "busy", sessionID: "b3" });
      await h.run({ event: "realwork", sessionID: "b3", tool: "Bash", args: { command: "ls" }, result: "x" });
      expect((await import("../src/extract-queue")).peekQueue("b3").length).toBe(1);
      await h.run({ event: "realwork", sessionID: "b3", tool: "mcp__thatch__memory_remember", args: { label: "x" }, result: "[saved] test/repo :: x" });
      // The SAVE gate: a memory_remember that actually saved drains the
      // queue + resets the counter - the opencode hook's drain semantics,
      // wired server-side on the plugin path (the meta-skip never reaches
      // appendBatch's own gate).
      expect((await import("../src/extract-queue")).peekQueue("b3").length).toBe(0);
    } finally {
      delete process.env.THATCH_QUEUE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
