import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeV2Harness, type V2Harness } from "./v2-harness";

// The v2 adapter's contract fixtures: a mocked v2 promise context (plain
// objects, call-recording arrays - the house pattern from
// tests/mocks/plugin-harness.ts) driving the real runtime through the adapter. The
// context itself comes from the shared harness (tests/mocks/v2-harness.ts,
// which also serves the QA use cases and registers the transformers mock);
// makeContext below just rebinds this module's recorders onto the new
// harness's live arrays so the opencode-v2-*.test.ts part files keep their
// ergonomic names. Every recorder is an exported `let`: an importing part
// file's name aliases the live value at read time (rebound by each
// makeContext call), never a snapshot.

export const SESSION_DIR = "/tmp/thatch-v2-test-session";
export const PROJECT_DIR = "/tmp/thatch-v2-test-project";

type HookFn = (input: any) => any;

export let dbDir: string;
export let promptHook: HookFn | undefined;
export let contextHook: HookFn | undefined;
export let toolAfterHook: HookFn | undefined;
export let addedCommands: { name: string; execute: (input: any) => Promise<void> }[];
export let addedTools: {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, toolContext?: { sessionID: string; agent: string }) => Promise<unknown>;
}[];
export let sessionPromptCalls: any[];
export let sessionSyntheticCalls: any[];
export let sessionCreateCalls: any[];
export let sessionGetCalls: any[];
export let sessionCompactCalls: any[];
export let sessionRemoveCalls: any[];
export let sessionMoveCalls: any[];
export let rpcRegistrations: any[];
export let rpcEmitted: { name: string; data: any }[];
// Shared call log across the mocked session/rpc domains: the session-tab
// execute flow's ordering (create -> move -> emit -> prompt) is load-bearing
// (docs/dev/features/session-tabs.md, "How it works"), and the flow spans four
// different mocks - only a shared log can assert relative order.
export let flowLog: string[];
// The harness backing the current makeContext() call: queueEvent delegates
// to it (the event queue is per-harness now, so events cannot leak across
// tests the way the old file-level queue could).
export let currentHarness: V2Harness;

export function makeContext(options?: {
  get?: (input: any) => Promise<any>;
  context?: (input: any) => Promise<any>;
  location?: { directory: string; project: { directory: string; canonical: string } };
  move?: (input: any) => Promise<any>;
  // A session.compact member (upstream #52385). Absent by default so the
  // default context models the older SDK floor the adapter must guard.
  compact?: boolean;
  // A session.remove member (upstream #52387), same floor rule as compact.
  remove?: boolean;
  // Omit the rpc domain entirely: the older SDK floor without the
  // session-tab surface.
  omitRpc?: boolean;
}) {
  currentHarness = makeV2Harness(SESSION_DIR, {
    projectDir: PROJECT_DIR,
    // The extraction child id the unit tests' e2e flows assert against.
    childID: "v2-test-child",
    ...options,
  });
  // The adapter registers its session/tool hooks DURING setup() - after
  // makeContext returns - so these are stable delegators that read the
  // current harness's hook table at call time, not snapshots (a snapshot
  // would be undefined here and the hook-asserting tests would fail).
  promptHook = (input: any) => currentHarness.hooks["prompt"]!(input);
  contextHook = (input: any) => currentHarness.hooks["context"]!(input);
  toolAfterHook = (input: any) => currentHarness.hooks["execute.after"]!(input);
  addedCommands = currentHarness.commands;
  addedTools = currentHarness.addedTools;
  sessionPromptCalls = currentHarness.calls.prompt;
  sessionSyntheticCalls = currentHarness.calls.synthetic;
  sessionCreateCalls = currentHarness.calls.create;
  sessionGetCalls = currentHarness.calls.get;
  sessionCompactCalls = currentHarness.calls.compact;
  sessionRemoveCalls = currentHarness.calls.remove;
  sessionMoveCalls = currentHarness.calls.move;
  rpcRegistrations = currentHarness.calls.registrations;
  rpcEmitted = currentHarness.calls.emitted;
  flowLog = currentHarness.flowLog;
  return currentHarness.context;
}

export async function queueEvent(event: any): Promise<void> {
  // Delegate to the current harness's queue (per-harness event queue - the
  // old file-level queue could leak unconsumed events into the next test).
  return currentHarness.queue(event);
}

/** Polls until `fn` is truthy (the pump's handlers are async); 5s deadline. */
export async function waitFor(desc: string, fn: () => unknown): Promise<void> {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Per-part lifecycle: each opencode-v2-*.test.ts part registers its own
// bun test beforeEach/afterEach around these two. The adapter's dispose
// handle is NOT here - the tests assign `cleanup` themselves, so it stays
// a file-level variable in each part.
export function setupTestEnv(): void {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-v2-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // The delivery guard skips wake attempts when the runtime's bound
  // directory is gone, so the fixture host must bind to directories that
  // actually exist.
  mkdirSync(SESSION_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
  // Isolate the XDG data tree: the strand sweep resolves opencode.db from
  // XDG_DATA_HOME, and without this a host-side run would let the sweep
  // enumerate the developer's real database through the mock context (the
  // shared flowLog would record its session.move/remove calls). The
  // sweep's own tests opt in explicitly via OPENCODE_DB.
  process.env.XDG_DATA_HOME = join(dbDir, "home", ".local", "share");
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  // The strand sweep must never act on the developer's real opencode.db
  // through this file's mock context (the boot sweep runs inside every
  // setup() call, and the harness's shared flowLog would record its
  // session.move/remove calls); the sweep's own tests live in
  // strand-sweep.test.ts.
  process.env.THATCH_STRAND_SWEEP = "off";
}

export async function teardownTestEnv(): Promise<void> {
  delete process.env.THATCH_DB_PATH;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.THATCH_STRAND_SWEEP;
  rmSync(dbDir, { recursive: true, force: true });
}
