import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryAvailable, guardDelivery } from "../src/runtime";
import type { DebugLog } from "../src/debug";

/** Records promptSession calls; assertions read calls and debug lines. */
function makeHarness(directory: string) {
  const calls: { sessionID: string; body: unknown; mode: string }[] = [];
  const promptSession = async (sessionID: string, body: { parts: unknown[] }, mode: "sync" | "async") => {
    calls.push({ sessionID, body, mode });
  };
  const lines: string[] = [];
  const debug: DebugLog = (tag, msg) => lines.push(`[${tag}] ${msg}`);
  return { guard: guardDelivery(promptSession, directory, debug), calls, lines };
}

describe("directoryAvailable", () => {
  test("true for an existing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    expect(directoryAvailable(dir)).toBe(true);
  });

  test("false for a deleted directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    rmSync(dir, { recursive: true });
    expect(directoryAvailable(dir)).toBe(false);
  });

  test("false when a path component is a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    expect(directoryAvailable(join(file, "child"))).toBe(false);
  });
});

describe("guardDelivery", () => {
  test("skips the attempt for a gone directory: no throw, no call, debug line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    rmSync(dir, { recursive: true });
    const { guard, calls, lines } = makeHarness(dir);
    await guard("ses_gone", { parts: [] }, "async");
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("runtime:delivery") && l.includes("ses_gone") && l.includes(dir))).toBe(true);
  });

  test("resumes delivery when the directory exists again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    rmSync(dir, { recursive: true });
    const { guard, calls } = makeHarness(dir);
    await guard("ses_back", { parts: [] }, "async");
    expect(calls).toHaveLength(0);
    // A worktree recreated at the same path must receive mail again - the
    // check runs fresh on every attempt, nothing is cached or suppressed.
    mkdirSync(dir, { recursive: true });
    await guard("ses_back", { parts: [] }, "async");
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe("ses_back");
  });

  test("passes the attempt through unchanged for a live directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    const { guard, calls } = makeHarness(dir);
    const body = { parts: [{ type: "text" as const, text: "nudge", synthetic: true }] };
    await guard("ses_live", body, "sync");
    expect(calls).toEqual([{ sessionID: "ses_live", body, mode: "sync" }]);
  });

  test("forwards a rejection from the wrapped promptSession", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    const boom = async () => {
      throw new Error("host rejected");
    };
    const lines: string[] = [];
    const guard = guardDelivery(boom as Parameters<typeof guardDelivery>[0], dir, (_t, m) => lines.push(m));
    await expect(guard("ses_err", { parts: [] }, "async")).rejects.toThrow("host rejected");
  });

  test("adds no microtask before the wrapped call for a live directory", async () => {
    // Fire-and-forget callers assert on promptSession timing immediately
    // after dispatch (the repo's mock contract): the guard must not delay
    // the wrapped call past the caller's next await.
    const dir = mkdtempSync(join(tmpdir(), "delivery-guard-"));
    let delivered = false;
    const promptSession = async () => {
      delivered = true;
    };
    const guard = guardDelivery(promptSession, dir, () => {});
    const p = guard("ses_now", { parts: [] }, "async");
    expect(delivered).toBe(true);
    await p;
  });
});
