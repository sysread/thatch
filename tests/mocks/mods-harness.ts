import type { ModRegistrar, ModsApi, PromptSubmitEvent, PromptComposeEvent } from "../../src/claude-plugin/mod";

/**
 * A hand-rolled mods-$ double for the Claude Code plugin mod's unit tests.
 * The mod's decision logic is pure against this shape: registrations are
 * captured (matched invocations run the LAST matching handler, the
 * middleware tail), the stage/lifecycle tools' responses are scripted per
 * test, and every $.mcp.call is recorded. The API surface mirrors
 * src/claude-plugin/mod.ts's ModsApi - the SHAPE ASSUMPTIONS (session.id,
 * mcp.call envelope) are the QA pins; this harness encodes them in
 * exactly one place.
 */

export interface ModsHarness {
  /** The registrar passed to the mod's register(). */
  register: ModRegistrar;
  api: ModsApi;
  /** The captured prompt.submit handler chain (throws when unregistered). */
  runPromptSubmit(e: Partial<PromptSubmitEvent>): Promise<PromptSubmitEvent>;
  /** The captured prompt.compose handler chain. */
  runPromptCompose(e: Partial<PromptComposeEvent>): Promise<PromptComposeEvent>;
  /** Invokes the LAST handler registered for the event whose matcher (if
   *  any) matches the event object - the generic path for the matcher-form
   *  registrations (command.run, tool.call). */
  run(event: string, e: Record<string, unknown>): Promise<unknown>;
  registrations: { event: string; matcher?: Record<string, unknown> }[];
  /** Every stage tool call the mod made, in order. */
  stageCalls: { prompt: string; sessionId: string }[];
  /** Every lifecycle tool call the mod made, in order. */
  lifecycleCalls: Record<string, unknown>[];
  /** Script the stage tool's next response (text, an envelope object, or
   *  an error to fail the call with). */
  setStageResponse(res: unknown): void;
  /** Script the lifecycle tool's next responseS (queued per call; an
   *  empty queue answers { text: "" }). */
  setLifecycleResponse(...res: unknown[]): void;
  sessionId: string;
  readonly compacted: number;
  notified: string[];
  registeredCommands: string[];
  registeredTools: string[];
}

export function installModsHarness(options: { instructions: string; stageResponse?: unknown; stageError?: Error }): ModsHarness {
  const handlers: { event: string; matcher?: Record<string, unknown>; handler: (...args: unknown[]) => Promise<unknown> }[] = [];
  const stageCalls: { prompt: string; sessionId: string }[] = [];
  const lifecycleCalls: Record<string, unknown>[] = [];
  const notified: string[] = [];
  let compacted = 0;
  let stageResponse: unknown = options.stageResponse ?? "";
  let stageError: Error | undefined = options.stageError;
  const lifecycleResponses: unknown[] = [];
  const sessionId = "ses_mod_under_test";
  const registeredCommands: string[] = [];
  const registeredTools: string[] = [];

  const register = ((event: string, second: unknown, third?: unknown) => {
    // The docs' two shapes: on(event, handler) and on(event, matcher,
    // handler). A function in second position is the handler form.
    const isHandlerForm = typeof second === "function";
    handlers.push({
      event,
      matcher: isHandlerForm ? undefined : (second as Record<string, unknown>),
      handler: (isHandlerForm ? second : third) as (...args: unknown[]) => Promise<unknown>,
    });
  }) as unknown as ModRegistrar;

  const api: ModsApi = {
    session: {
      id: async () => sessionId,
      compact: async () => {
        compacted++;
        return {};
      },
    },
    ui: {
      notify: async (text: string) => {
        notified.push(text);
        return { isSent: true, channel: "terminal_bell" };
      },
    },
    command: {
      register: async (def) => {
        registeredCommands.push(def.name);
        return def;
      },
    },
    tool: {
      register: async (def) => {
        registeredTools.push(def.name);
        return def;
      },
    },
    mcp: {
      call: async (call) => {
        if (call.tool === "plugin_stage") {
          stageCalls.push({ prompt: String(call.arguments?.prompt ?? ""), sessionId: String(call.arguments?.session_id ?? "") });
          if (stageError) throw stageError;
          return stageResponse;
        }
        if (call.tool === "plugin_lifecycle") {
          lifecycleCalls.push({ ...call.arguments });
          return lifecycleResponses.length > 0 ? lifecycleResponses.shift() : { text: "" };
        }
        throw new Error(`unexpected tool call: ${call.server}/${call.tool}`);
      },
    },
  };

  return {
    register,
    api,
    stageCalls,
    lifecycleCalls,
    notified,
    registeredCommands,
    registeredTools,
    get compacted() {
      return compacted;
    },
    registrations: handlers,
    setStageResponse: (res) => {
      stageResponse = res;
      stageError = undefined;
    },
    setLifecycleResponse: (...res: unknown[]) => {
      lifecycleResponses.push(...res);
    },
    sessionId,
    runPromptSubmit: async (e) => {
      const chain = handlers.filter((r) => r.event === "prompt.submit").map((r) => r.handler);
      if (chain.length === 0) throw new Error("prompt.submit was not registered");
      const passthrough = async (ev?: PromptSubmitEvent) => ev ?? { text: "" };
      let out: PromptSubmitEvent = { text: "", ...e };
      for (const handler of chain) out = (await handler(api, out, passthrough)) as PromptSubmitEvent;
      return out;
    },
    runPromptCompose: async (e) => {
      const chain = handlers.filter((r) => r.event === "prompt.compose").map((r) => r.handler);
      if (chain.length === 0) throw new Error("prompt.compose was not registered");
      const passthrough = async (ev?: PromptComposeEvent) => ev ?? {};
      let out: PromptComposeEvent = { sections: [], ...e };
      for (const handler of chain) out = (await handler(api, out, passthrough)) as PromptComposeEvent;
      return out;
    },
    run: async (event, e) => {
      const matching = handlers.filter((r) => r.event === event && (!r.matcher || Object.entries(r.matcher).every(([k, v]) => e[k] === v)));
      const handler = matching.at(-1)?.handler;
      if (!handler) throw new Error(`${event} with a matching matcher was not registered`);
      const passthrough = async (ev?: unknown) => ev ?? e;
      return handler(api, e, passthrough);
    },
  };
}
