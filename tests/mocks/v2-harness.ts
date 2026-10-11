/**
 * The shared QA harness for use cases that drive the real v2 adapter
 * (src/opencode/v2.ts setup) end-to-end: a mocked promise context (the
 * surface the adapter consumes), boundary recorders (session
 * create/compact/remove, prompt/synthetic, the rpc emits), and the bus
 * event queue feeding the adapter's pump.
 *
 * The session domain's newer members (compact - upstream #52385; remove -
 * #52387) are optional by design: absent by default so the default context
 * models the older-SDK floor the adapter must runtime-guard, present when
 * an option is set to model a current host.
 *
 * The transformers mock below is registered at import time so every harness
 * consumer gets it (the adapter's runtime builds BgeEmbeddingModel; the
 * mock gives hash-based vectors with no download - same pattern as
 * tests/plugin.test.ts). Registering it here replaces the per-UC copy the
 * barrel used to rely on by import order.
 *
 * The unit tests (tests/opencode-v2.test.ts) keep their own richer harness
 * inline - its module-level recorders are woven through dozens of tests,
 * and unifying them here is not worth the churn. When this module and that
 * one drift apart, reconcile deliberately.
 */

import { mock } from "bun:test";

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async (text: string) => {
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
  // BgeEmbeddingModel's default factory sets env.cacheDir before building
  // the pipeline, so the mock must expose a writable env object (same
  // contract as tests/plugin.test.ts).
  env: {},
}));

export interface V2Harness {
  /** The mocked promise context - pass to the v2 adapter's setup. */
  context: Record<string, any>;
  /** Boundary recorders: promise-domain calls and rpc event emits. */
  calls: {
    compact: any[];
    remove: any[];
    create: any[];
    emitted: { name: string; data: any }[];
  };
  /** Commands registered through the CommandEditor (thatch/compact etc.). */
  commands: { name: string; execute: (input: any) => Promise<void> }[];
  /** Queue a bus event for the adapter's pump (it polls every ~5ms). */
  queue: (event: any) => Promise<void>;
  /** Fire a buffered tool interaction into the adapter's execute.after
   *  hook (the extraction buffer's feeder). */
  toolAfter: (input: any) => Promise<void>;
  /** Set the final assistant message the wrap-up greenlight check reads. */
  setAssistant: (text: string) => void;
}

export function makeV2Harness(
  dir: string,
  options?: {
    compact?: boolean;
    remove?: boolean;
    omitRpc?: boolean;
    childID?: string;
  },
): V2Harness {
  const childID = options?.childID ?? "qa-v2-child";
  const calls: V2Harness["calls"] = { compact: [], remove: [], create: [], emitted: [] };
  const commands: V2Harness["commands"] = [];
  const eventQueue: any[] = [];
  let assistantText = "";
  let toolAfterHook: ((input: any) => Promise<void>) | undefined;
  const context: Record<string, any> = {
    location: { directory: dir, project: { directory: dir, canonical: dir } },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (definition: any) => commands.push(definition) });
        return { dispose: () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: () => {} });
        return { dispose: () => {} };
      },
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        if (name === "execute.after") toolAfterHook = callback;
        return { dispose: () => {} };
      },
    },
    session: {
      hook: async () => ({ dispose: () => {} }),
      create: async () => {
        calls.create.push(childID);
        return { id: childID };
      },
      get: async () => ({ title: "QA v2 harness", location: { directory: dir } }),
      // The wrap-up greenlight check reads the final assistant message
      // through session.context (the only message surface on the promise
      // domain).
      context: async () => [{ type: "assistant", content: [{ type: "text", text: assistantText }] }],
      prompt: async () => ({}),
      synthetic: async () => ({}),
      ...(options?.compact
        ? {
            compact: async (input: any) => {
              calls.compact.push(input);
              return {};
            },
          }
        : {}),
      ...(options?.remove
        ? {
            remove: async (input: any) => {
              calls.remove.push(input);
              return {};
            },
          }
        : {}),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          while (!signal.aborted) {
            if (eventQueue.length > 0) yield eventQueue.shift();
            else await new Promise((r) => setTimeout(r, 5));
          }
        })(),
    },
  };
  if (!options?.omitRpc) {
    context.rpc = {
      register: async () => ({
        dispose: () => {},
        events: { emit: async (name: string, data: any) => { calls.emitted.push({ name, data }); } },
      }),
    };
  }
  return {
    context,
    calls,
    commands,
    queue: async (event: any) => {
      eventQueue.push(event);
      // The mock generator polls every 5ms; give it a beat to start
      // consuming before the caller polls its observables.
      await new Promise((r) => setTimeout(r, 15));
    },
    toolAfter: async (input: any) => {
      if (!toolAfterHook) throw new Error("v2-harness: execute.after hook was never registered");
      await toolAfterHook(input);
    },
    setAssistant: (text: string) => (assistantText = text),
  };
}
