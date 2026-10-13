/**
 * The shared mock v2 promise-context harness: ONE builder serving the unit
 * tests (the tests/opencode-v2-*.test.ts parts, through their rebinding
 * wrapper tests/mocks/opencode-v2-harness.ts)
 * and the QA use cases (uc-103, uc-120) that drive the real v2 adapter
 * (src/opencode/v2.ts setup) end-to-end. The two used to be separate
 * copies with drifting shapes; this module is the single source.
 *
 * What it provides: the promise-context surface the adapter consumes
 * (location, command/tool/session domains, the bus event queue, the rpc
 * registration), boundary recorders for every promise-domain call and rpc
 * emit, the registered session/tool hooks, a flow log for ordering
 * assertions (the session-tab flow spans four mocks - only a shared log
 * can assert relative order), and helpers to queue bus events, fire
 * buffered tool interactions, and set the canned final assistant message
 * the wrap-up greenlight check reads.
 *
 * The session domain's newer members (compact - upstream #52385; remove -
 * #52387) are optional by design: absent by default so the default context
 * models the older-SDK floor the adapter must runtime-guard; pass true to
 * model a current host (calls land in calls.compact / calls.remove).
 *
 * Defaults are the UNIT harness's defaults (the more-tested behavior):
 * session.get returns no location, session.context returns nothing until
 * setAssistant is called. The QA legs route fine under these (their
 * events carry explicit locations, and child events pass through the
 * adapter's childSessions forwarding set by session id).
 *
 * The transformers mock below is registered at import time so every
 * consumer gets it (the adapter's runtime builds BgeEmbeddingModel; the
 * mock gives hash-based vectors with no download - same pattern as
 * tests/mocks/plugin-harness.ts). The pipeline strips BgeEmbeddingModel's
 * QUERY_PREFIX so queryEmbed and passageEmbed of the same text land on the
 * same vector - without the strip, a tool-seeded matcher (passageEmbed)
 * can never be re-found by the nudge path (queryEmbed), which the v2
 * staleness-binding tests depend on.
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
  // contract as tests/mocks/plugin-harness.ts).
  env: {},
}));

export interface V2HarnessOptions {
  /** Full location override (instance directory AND project directory). */
  location?: { directory: string; project: { directory: string; canonical: string } };
  /** The project directory when it differs from the instance directory
   *  (opencode launched below the project root). Defaults to `dir`. */
  projectDir?: string;
  /** A session.compact member (upstream #52385). Absent by default: the
   *  older-SDK floor the adapter must runtime-guard. */
  compact?: boolean;
  /** A session.remove member (upstream #52387), same floor rule as compact. */
  remove?: boolean;
  /** Omit the rpc domain entirely: the older SDK floor without the
   *  session-tab surface. */
  omitRpc?: boolean;
  /** The id session.create returns (the extraction/child session). */
  childID?: string;
  /** Override session.get's return (recorded first). */
  get?: (input: any) => Promise<any>;
  /** Override session.context's return (recorded first) - e.g. canned
   *  non-assistant message shapes. */
  context?: (input: any) => Promise<any>;
  /** Override session.move's return (recorded first). */
  move?: (input: any) => Promise<any>;
}

export interface V2Harness {
  /** The mocked promise context - pass to the v2 adapter's setup. */
  context: Record<string, any>;
  /** Boundary recorders: promise-domain calls and rpc emits. */
  calls: {
    create: any[];
    prompt: any[];
    synthetic: any[];
    get: any[];
    context: any[];
    compact: any[];
    remove: any[];
    move: any[];
    emitted: { name: string; data: any }[];
    /** The rpc definitions registered (the session-tab bridge). */
    registrations: any[];
  };
  /** Commands registered through the CommandEditor (thatch/compact etc.). */
  commands: { name: string; execute: (input: any) => Promise<void> }[];
  /** Tools registered through the ToolEditor, with their execute fns. */
  addedTools: { name: string; description: string; input: unknown; execute: (input: unknown, toolContext?: any) => Promise<unknown> }[];
  /** The hooks the adapter registered, by name (prompt/context on the
   *  session domain, execute.after on the tool domain). */
  hooks: Record<string, ((input: any) => Promise<void>) | undefined>;
  /** Cross-mock ordering log ("create" / "move" / "prompt" / "emit"). */
  flowLog: string[];
  /** Queue a bus event for the adapter's pump (it polls every ~5ms). */
  queue: (event: any) => Promise<void>;
  /** Fire a buffered tool interaction into the adapter's execute.after
   *  hook (the extraction buffer's feeder). */
  toolAfter: (input: any) => Promise<void>;
  /** Set the final assistant message the wrap-up greenlight check reads. */
  setAssistant: (text: string) => void;
}

export function makeV2Harness(dir: string, options?: V2HarnessOptions): V2Harness {
  const childID = options?.childID ?? "qa-v2-child";
  const calls: V2Harness["calls"] = {
    create: [],
    prompt: [],
    synthetic: [],
    get: [],
    context: [],
    compact: [],
    remove: [],
    move: [],
    emitted: [],
    registrations: [],
  };
  const commands: V2Harness["commands"] = [];
  const addedTools: V2Harness["addedTools"] = [];
  const hooks: V2Harness["hooks"] = {};
  const flowLog: string[] = [];
  const eventQueue: any[] = [];
  let assistantText = "";
  const context: Record<string, any> = {
    location:
      options?.location ??
      { directory: dir, project: { directory: options?.projectDir ?? dir, canonical: options?.projectDir ?? dir } },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (definition: any) => commands.push(definition) });
        return { dispose: () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          add: (tool: any) =>
            addedTools.push({ name: tool.name, description: tool.description, input: tool.input, execute: tool.execute }),
        });
        return { dispose: () => {} };
      },
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        hooks[name] = callback;
        return { dispose: () => {} };
      },
    },
    session: {
      hook: async (name: string, callback: (input: any) => Promise<void>) => {
        hooks[name] = callback;
        return { dispose: () => {} };
      },
      // The real promise client returns the created SessionInfo directly
      // (the envelope types are `{data: X}["data"]` indexed - unwrapped).
      create: async (input: any) => {
        calls.create.push(input);
        flowLog.push("create");
        return { id: childID };
      },
      move: async (input: any) => {
        calls.move.push(input);
        flowLog.push("move");
        if (options?.move) return options.move(input);
        return {};
      },
      // Default return carries NO location (the unit harness's tested
      // default): location-less events resolve through the sessionDirs
      // cache or drop - tests that need resolution pass `get`.
      get: async (input: any) => {
        calls.get.push(input);
        if (options?.get) return options.get(input);
        return { title: "some title" };
      },
      // The wrap-up greenlight check reads the final assistant message
      // through session.context (the only message surface on the promise
      // domain). Empty until setAssistant is called.
      context: async (input: any) => {
        calls.context.push(input);
        if (options?.context) return options.context(input);
        return assistantText ? [{ type: "assistant", content: [{ type: "text", text: assistantText }] }] : [];
      },
      prompt: async (input: any) => {
        calls.prompt.push(input);
        flowLog.push("prompt");
        return {};
      },
      synthetic: async (input: any) => {
        calls.synthetic.push(input);
        return {};
      },
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
          // Poll instead of promise-waiting: a wake signal sent while the
          // pump is still processing the previous event would be lost, and
          // the last queued event would never yield.
          while (!signal.aborted) {
            if (eventQueue.length > 0) yield eventQueue.shift();
            else await new Promise((r) => setTimeout(r, 5));
          }
        })(),
    },
  };
  if (!options?.omitRpc) {
    context.rpc = {
      register: async (definition: any): Promise<{ dispose: () => void; events: { emit: (name: string, data: any) => Promise<void> } }> => {
        calls.registrations.push(definition);
        return {
          dispose: () => {},
          events: {
            emit: async (name: string, data: any) => {
              calls.emitted.push({ name, data });
              flowLog.push("emit");
            },
          },
        };
      },
    };
  }
  return {
    context,
    calls,
    commands,
    addedTools,
    hooks,
    flowLog,
    queue: async (event: any) => {
      eventQueue.push(event);
      // The mock generator polls every 5ms; give it a beat to start
      // consuming before the caller polls its observables.
      await new Promise((r) => setTimeout(r, 15));
    },
    toolAfter: async (input: any) => {
      const hook = hooks["execute.after"];
      if (!hook) throw new Error("v2-harness: execute.after hook was never registered");
      await hook(input);
    },
    setAssistant: (text: string) => (assistantText = text),
  };
}
