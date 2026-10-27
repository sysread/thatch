/**
 * Shared harness for the plugin-*.test.ts suite (the former monolithic
 * tests/plugin.test.ts, split into topic files). Every part imports this
 * module FIRST so the @huggingface/transformers mock below is registered
 * before the plugin graph loads, and calls setupPluginHarness /
 * teardownPluginHarness in its own beforeAll/afterAll for the env, console,
 * and fixture-runtime setup the original file performed.
 */

import { mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @huggingface/transformers so BgeEmbeddingModel can embed without
// downloading a model. Produces the same hash-based vectors as
// MockEmbeddingModel, stripping the QUERY_PREFIX so query and passage
// embeddings for the same text produce identical vectors.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
mock.module("@huggingface/transformers", () => ({
  // BgeEmbeddingModel's default factory sets env.cacheDir before building the
  // pipeline, so the mock must expose a writable env object.
  env: {},
  pipeline: async () => async (text: string, _opts: any) => {
    const clean = text.startsWith(QUERY_PREFIX) ? text.slice(QUERY_PREFIX.length) : text;
    let h = 0;
    for (let i = 0; i < clean.length; i++) {
      h = ((h << 5) - h) + clean.charCodeAt(i);
      h |= 0;
    }
    h ^= 0x9e3779b9;
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h |= 0;
      vec[i] = h / 0x80000000;
    }
    return { data: vec };
  },
}));

// The plugin's server entry, loaded AFTER the mock registration: a static
// import would hoist above the mock.module call and bind the real package.
const { server: opencodeServer } = await import("../../src/index");

// The delivery guard skips wake attempts when the runtime's bound
// directory is gone, so every fixture runtime this file binds must get a
// directory that actually exists. One wrapper creates the worktree on
// demand instead of a hand-maintained list of /tmp paths.
export async function server(input: any) {
  mkdirSync(input.worktree, { recursive: true });
  return opencodeServer(input);
}

// Records every promptAsync the plugin issues so transcript-echo tests can
// assert on delivery. Captured at call time (synchronously inside the mock)
// so assertions work immediately after a hook invocation.
export const promptAsyncCalls: any[] = [];
// Records TUI actions the wrap-up command resolution triggers.
export const tuiExecuteCommandCalls: any[] = [];
export const tuiPublishCalls: any[] = [];
export const tuiToastCalls: any[] = [];

let dbDir = "";
// The real console.error, bound at module load (before any hook can swap
// it), so afterAll can restore it UNCONDITIONALLY after the auto-register
// log filter below comes off - no conditional restore to get wrong.
const realConsoleError = console.error.bind(console);
let activeHooks: Awaited<ReturnType<typeof server>> | undefined;

export async function setupPluginHarness() {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-plugin-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
  // Isolate the XDG data tree too: the strand sweep resolves opencode.db
  // from XDG_DATA_HOME, and without this a host-side test run would let
  // the sweep enumerate the developer's real database through the mocks.
  // The scratch tree has no opencode.db, so the sweep no-ops; the sweep's
  // own tests (strand-sweep.test.ts) opt in explicitly.
  process.env.XDG_DATA_HOME = join(dbDir, "home", ".local", "share");
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  // The strand sweep must never act on the developer's real opencode.db
  // through this file's mock client (the boot sweep runs inside every
  // server() call); the sweep's own tests live in strand-sweep.test.ts.
  process.env.THATCH_STRAND_SWEEP = "off";
  // The shared mock client below has no session.get, so every chat.event
  // hook fires the auto-register degrade path in runtime.ts, which logs each
  // failure fire-and-forget. Such a log can land after the triggering test
  // has ended, so a per-test silence cannot trap it reliably. Filter the
  // known phrase for the whole file instead; every other error still logs.
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.includes("chat auto-register failed")) return;
    realConsoleError(...args);
  };
  // RECALL_THRESHOLD is a module-level constant (0.55 default), read when
  // runtime.ts is first imported. Setting the env var here can't change it,
  // but 0.55 works: the hash-based mock scores ~1.0 for identical texts and
  // near-orthogonal for different texts.
  const mockClient = {
    session: {
      prompt: async () => {},
      promptAsync: async (opts: any) => {
        promptAsyncCalls.push(opts);
      },
      create: async () => ({ data: { id: "test-child" } }),
      delete: async () => {},
    },
    tui: {
      showToast: async (opts: any) => {
        tuiToastCalls.push(opts);
      },
      executeCommand: async (opts: any) => {
        tuiExecuteCommandCalls.push(opts);
        return { data: true };
      },
      publish: async (opts: any) => {
        tuiPublishCalls.push(opts);
        return { data: true };
      },
    },
  };
  const hooks = await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree", directory: "/tmp/thatch-test-worktree" } as any);
  activeHooks = hooks;

  // Store a memory so the recall nudge has something to match. Using the
  // server's own tools ensures the embedding comes from the same (mocked)
  // BgeEmbeddingModel that chat.message will use for the query. The tool
  // embeds "# {label}\n\n{content}" — the recall nudge test prompt must
  // match that full text for the hash-based mock to produce identical vectors.
  await hooks.tool!.thatch_memory_remember.execute({
    label: "test-coverage",
    content: "test coverage metrics and gaps",
    store: "global",
  } as any, {} as any);

  return hooks;
}

export function teardownPluginHarness() {
  activeHooks?.dispose?.();
  activeHooks = undefined;
  console.error = realConsoleError;
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.THATCH_DB_PATH;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  delete process.env.THATCH_STRAND_SWEEP;
}
