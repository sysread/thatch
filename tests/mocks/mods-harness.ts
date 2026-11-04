import type { ModRegistrar, ModsApi, PromptSubmitEvent, PromptComposeEvent } from "../../src/claude-plugin/mod";

/**
 * A hand-rolled mods-$ double for the Claude Code plugin mod's unit tests.
 * The mod's decision logic is pure against this shape: hooks are captured
 * on registration (so tests invoke them directly), the stage tool's
 * response is scripted per test, and every $.mcp.call is recorded. The
 * API surface mirrors src/claude-plugin/mod.ts's ModsApi - the SHAPE
 * ASSUMPTIONS (session.id, mcp.call envelope) are the QA pins; this
 * harness encodes them in exactly one place.
 */

export interface ModsHarness {
  /** The registrar passed to the mod's register(). */
  register: ModRegistrar;
  api: ModsApi;
  /** The captured prompt.submit handler (throws when unregistered). */
  runPromptSubmit(e: Partial<PromptSubmitEvent>): Promise<PromptSubmitEvent>;
  /** The captured prompt.compose handler. */
  runPromptCompose(e: Partial<PromptComposeEvent>): Promise<PromptComposeEvent>;
  /** Every stage tool call the mod made, in order. */
  stageCalls: { prompt: string; sessionId: string }[];
  /** Script the stage tool's next response (text, an envelope object, or
   *  an error to fail the call with). */
  setStageResponse(res: unknown): void;
  sessionId: string;
}

export function installModsHarness(options: { instructions: string; stageResponse?: unknown; stageError?: Error }): ModsHarness {
  const handlers = new Map<string, unknown>();
  const stageCalls: { prompt: string; sessionId: string }[] = [];
  let stageResponse: unknown = options.stageResponse ?? "";
  let stageError: Error | undefined = options.stageError;
  const sessionId = "ses_mod_under_test";

  const register = ((event: string, handler: unknown) => {
    handlers.set(event, handler);
  }) as ModRegistrar;

  const api: ModsApi = {
    session: {
      id: async () => sessionId,
    },
    mcp: {
      call: async (call: { server: string; tool: string; arguments?: Record<string, unknown> }) => {
        if (call.tool !== "plugin_stage") throw new Error(`unexpected tool call: ${call.server}/${call.tool}`);
        stageCalls.push({ prompt: String(call.arguments?.prompt ?? ""), sessionId: String(call.arguments?.session_id ?? "") });
        if (stageError) throw stageError;
        return stageResponse;
      },
    },
  };

  return {
    register,
    api,
    stageCalls,
    setStageResponse: (res) => {
      stageResponse = res;
      stageError = undefined;
    },
    sessionId,
    runPromptSubmit: async (e) => {
      const h = handlers.get("prompt.submit") as ($: ModsApi, e: PromptSubmitEvent, next: (e?: PromptSubmitEvent) => Promise<PromptSubmitEvent>) => Promise<PromptSubmitEvent>;
      if (!h) throw new Error("prompt.submit was not registered");
      const passthrough = async (ev?: PromptSubmitEvent) => ev ?? { text: "" };
      return h(api, { text: "", ...e }, passthrough);
    },
    runPromptCompose: async (e) => {
      const h = handlers.get("prompt.compose") as ($: ModsApi, e: PromptComposeEvent, next: (e?: PromptComposeEvent) => Promise<PromptComposeEvent>) => Promise<PromptComposeEvent>;
      if (!h) throw new Error("prompt.compose was not registered");
      const passthrough = async (ev?: PromptComposeEvent) => ev ?? {};
      return h(api, { sections: [], ...e }, passthrough);
    },
  };
}
