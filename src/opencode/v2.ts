import type { Plugin } from "@opencode/plugin";
import type { Tool } from "@opencode/schema/tool";
import type { ToolContext as V2ToolContext } from "@opencode/plugin/promise/tool";
import type { HostCapabilities, PromptPart, ToastInput } from "../capabilities";
import { createRuntime } from "../runtime";
import { trimHostContext } from "../tools";
import { TOOL_DEFS, type HostToolContext } from "../tool-defs";

// The opencode v2 adapter (opencode 2.x, plugin API @opencode/plugin 2.x).
// Loaded only by v2 hosts - the dual entry (src/index.ts) lazy-imports this
// module so the v2 SDK's imports never evaluate under a v1 host.
//
// Mappings against the v1 hook surface (docs/plans/opencode-v2-plugin.md has
// the full capability table; items marked SMOKE TEST are gated on milestone
// 2's real-binary verification):
// - tools: ToolEditor.add with the same thatch_ names; zod shapes pass as
//   Standard Schema; string results wrap as { content }. The tool.hook
//   execute.after hook feeds the same extraction buffer as v1's
//   tool.execute.after.
// - system prompt: session.hook("context") mutates the request's system array.
//   SMOKE TEST: the runtime pushes a raw string where v2 types SystemPart.
// - per-message nudges: session.hook("prompt") mutates a clone of the user
//   prompt ({ text, files, agents, skills } - v2 has no synthetic parts).
//   Injections the runtime pushes onto the fake parts array are appended to
//   prompt.text. The hook awaits the runtime so the mutation lands before
//   the host reads the prompt. SMOKE TEST: rendering, echo re-entry, and
//   whether the host awaits hook callbacks.
// - noReply deliveries (chat echoes, session-start reminder): v2's prompt
//   endpoint cannot suppress the model turn, so the runtime gates them off
//   via capabilities.noReplyDelivery. SMOKE TEST: re-enable if v2 grows a
//   noReply surface.
// - compaction: session.hook("compaction") marks the session; the v2
//   context-injection surface is unverified, so only the flag lands.
//   SMOKE TEST: where compaction context belongs in v2.
// - events: context.event.subscribe pump (raw SSE, NOT directory-scoped -
//   filtered client-side the way the v1 host filters server-side).
//   SMOKE TEST: v2 event payload shape carries {type, properties, location};
//   if events lack location, this filter drops everything and the plugin is
//   inert (no reminder, no extraction, no status gating).
// - toasts, tui commands, session delete/list/messages endpoints:
//   no v2 surface reachable from a plugin - degrades as no-op/null.
//   fetchStatuses returns {} because the wake gate treats an unknown session
//   as idle; the event-fed status map inside the runtime does the gating.

type V2Context = Plugin.Context;
type V2Cleanup = Plugin.Cleanup;

// Raw setup function: the dual entry (src/index.ts) owns the plugin id and
// the merged default export; this adapter only implements the v2 setup.
export async function setup(context: V2Context): Promise<V2Cleanup | void> {
  // SMOKE TEST: Location.Info {directory, project: {directory, canonical}} -
  // directory is the session dir (forwarded unchanged on deleted-worktree
  // resume), project.directory the served project root (the v1 `worktree`).
  // A wrong guess here corrupts repo identity, store scoping, and the event
  // filter all at once.
  const location = context.location as {
    directory: string;
    project: { directory: string };
  };
  const directory = location.directory;
  const worktree = location.project.directory;

  const capabilities = buildCapabilities(context);
  const runtime = await createRuntime({ capabilities, directory, worktree });

  // Tool registration: the same CoreContext the v1 adapter feeds to
  // createTools, registered through the v2 ToolEditor instead.
  const registerTools = await context.tool.transform((editor) => {
    for (const def of TOOL_DEFS) {
      editor.add({
        name: `thatch_${def.name}`,
        description: def.description,
        input: def.args,
        execute: async (input: unknown, toolContext: V2ToolContext) => {
          const host: HostToolContext | undefined = trimHostContext(toolContext);
          const result: string = await def.execute(input as Record<string, unknown>, runtime.coreContext, host);
          return { content: result } as Tool.Result;
        },
      });
    }
  });

  // Tool execution buffering: same feeder as v1's tool.execute.after. The
  // hook payload carries the outcome; error-status calls are not buffered
  // (matching v1, whose hook only fired on completed tool calls).
  const registerToolHook = await context.tool.hook("execute.after", async (hook) => {
    if (hook.status && hook.status !== "completed") return;
    // SMOKE TEST: the v2 execute.after hook's result shape. The v1 hook
    // delivered {title, output}; v2 delivers a Tool.Result whose content
    // may be a string or a content-part array. A wrong guess means the
    // extraction buffer records wrong summaries, not a crash.
    const result = hook.result;
    const text = typeof result?.content === "string" ? result.content : "";
    const title = typeof result?.output === "string" ? result.output : "";
    await runtime.onToolExecuteAfter(
      { tool: hook.tool, sessionID: hook.sessionID, args: hook.input },
      { title, output: text },
    );
  });

  // System prompt: re-familiarization on every model request. The runtime
  // pushes plain strings (the v1 contract); v2's system parts are
  // { type: "text", text } objects, so convert at the boundary.
  const registerSystem = await context.session.hook("context", async (request: { system: unknown[] }) => {
    const pushed: string[] = [];
    await runtime.onSystemTransform({ system: pushed });
    for (const part of pushed) {
      request.system.push(typeof part === "string" ? { type: "text", text: part } : part);
    }
  });

  // Per-message nudges: the runtime handler reads the user's text from the
  // seeded non-synthetic part and pushes synthetic parts onto the array;
  // anything pushed is an injection, appended to the prompt's text.
  const registerPrompt = await context.session.hook(
    "prompt",
    async (request: { sessionID: string; messageID: string; prompt: { text: string } }) => {
      const parts: PromptPart[] = [{ type: "text", text: request.prompt.text }];
      try {
        await runtime.onChatMessage(
          { sessionID: request.sessionID, messageID: request.messageID },
          { parts: parts as any[], message: { id: request.messageID } },
        );
      } catch (err) {
        console.error(`[thatch] v2 prompt hook failed: ${err}`);
        return;
      }
      const injections = parts.slice(1).map((part) => part.text);
      if (injections.length > 0) request.prompt.text = `${request.prompt.text}\n\n${injections.join("\n\n")}`;
    },
  );

  // Compaction: the nudge-suppression flag is the only surface verified to
  // exist; the context-injection surface is unverified. SMOKE TEST.
  const registerCompaction = await context.session.hook("compaction", async (request: { sessionID: string }) => {
    await runtime.onSessionCompacting({ sessionID: request.sessionID }, { context: [] });
  });

  // Bus events: raw SSE subscription, not directory-scoped. Filter
  // client-side: drop events located elsewhere; location-less events drop
  // with them (matches the v1 host's server-side filter).
  const controller = new AbortController();
  const pump = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        const located = event as { type: string; properties?: any; location?: { directory?: string } };
        // Location-less events drop with the foreign ones: v1's server-side
        // filter (event.location?.directory !== plugin.directory) drops both.
        if (located.location?.directory !== directory) continue;
        // The properties guard keeps the runtime's event.properties.info
        // access from throwing on a malformed event; it is not a reshaping.
        await runtime.onEvent(located.properties ? located : { type: located.type, properties: located });
      }
    } catch (err) {
      if (!controller.signal.aborted) console.error(`[thatch] event subscription failed: ${err}`);
    }
  })();

  // Cleanup. Idempotent: v2 auto-reloads plugins on file change, so a
  // second setup after a skipped or partial cleanup would double every
  // poller, pump, and nudge. The pump await is safe: its body is fully
  // try/caught and abort ends the loop, so it settles promptly.
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    await pump;
    registerTools.dispose();
    registerToolHook.dispose();
    registerSystem.dispose();
    registerPrompt.dispose();
    registerCompaction.dispose();
    await runtime.dispose();
  };
}

// The HostCapabilities implementation over the v2 promise context. Every
// operation the v2 surface lacks degrades as a no-op or null - the shared
// runtime's callers treat those results as best-effort and log, never crash.
function buildCapabilities(context: V2Context): HostCapabilities {
  // SMOKE TEST: exact v2 SDK shapes for create/get/prompt. The promise
  // context's domain types are structural here; the generated client's
  // wrappers (data fields, path vs flat args) get reconciled against the
  // real binary.
  const session = context.session as unknown as {
    create(input: { parentID: string; title: string }): Promise<any>;
    get(input: { id: string }): Promise<any>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
  };

  return {
    noReplyDelivery: false,
    // The wake gate treats an unknown session as idle; the runtime's
    // event-fed status map does the busy/retry gating on v2.
    fetchStatuses: async () => ({}),
    sessionCreate: async (input) => {
      const result = await session.create({ parentID: input.parentID, title: input.title });
      const id = result?.data?.id ?? result?.id;
      // A shape mismatch must fail into the runtime's extraction fallback
      // (the nudge path), not silently corrupt the child-session maps.
      if (!id) throw new Error(`v2 session.create returned no id: ${JSON.stringify(result)?.slice(0, 200)}`);
      return { id };
    },
    // No delete on the v2 SessionDomain: extraction child sessions are not
    // cleaned up on v2 (documented gap; the bookkeeping maps still keep the
    // nudge path consistent).
    sessionDelete: async () => {},
    promptSession: async (sessionID, body, _mode) => {
      // v2's prompt endpoint takes text, not parts, and has no synthetic /
      // noReply semantics. Nudge injections ride the prompt hook; this
      // carries the direct child-session prompts. mode is v1-only (async =
      // promptAsync vs sync = prompt); v2 has one blocking endpoint, so the
      // extraction background flag degrades to a blocking call.
      const text = body.parts.map((part) => part.text).join("\n\n");
      await session.prompt({ sessionID, text });
    },
    sessionGet: async (id) => {
      const result = await session.get({ id });
      return result?.data ?? result ?? null;
    },
    sessionList: async () => null,
    sessionMessages: async () => null,
    showToast: async (_toast: ToastInput) => {
      // No toast publish path reachable from the promise context (the
      // tui.toast.show event has no producer surface here). Degrades.
    },
    tuiExecuteCommand: async () => {},
    tuiPublish: async () => {},
  };
}
