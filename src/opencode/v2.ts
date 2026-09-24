import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import type { Tool } from "@opencode/schema/tool";
import type { ToolContext as V2ToolContext } from "@opencode/plugin/promise/tool";
import type { HostCapabilities, PromptPart, ToastInput } from "../capabilities";
import { createRuntime } from "../runtime";
import { wrapUpCommandContent } from "../commands";
import { deriveTitle } from "../extraction";
import { TOOL_DEFS, trimHostContext, type HostToolContext } from "../tool-defs";

// The opencode v2 adapter (opencode 2.x, plugin API @opencode/plugin 2.x).
// Loaded only by v2 hosts - the dual entry (src/index.ts) lazy-imports this
// module so the v1 SDK's imports never evaluate under a v1 host.
//
// Mappings against the v1 hook surface; the 2026-09-23 smoke run against a
// real v2 binary plus the SDK dist types are the sources of truth
// (docs/dev/features/opencode-plugin.md has the full capability table):
// - tools: ToolEditor.add with the same thatch_ names. Input schemas are
//   pre-converted to JSON Schema with our own zod, because v2's converter
//   detects zod via `instanceof $ZodType` against ITS bundled zod copy and
//   drops ours (leaving tools parameterless). String results wrap as
//   { content }. The tool.hook execute.after hook feeds the same extraction
//   buffer as v1's tool.execute.after.
// - system prompt: session.hook("context") mutates the request's system
//   array; the runtime's plain strings convert to {type: "text", text}
//   parts at the boundary.
// - per-message nudges: the prompt hook computes the turn's injections;
//   the generate hook appends them to the outbound request's last user
//   message `content` array (v2 wire Messages have no `parts` field).
//   Injections stay out of the stored prompt text.
// - noReply deliveries (chat echoes, session-start reminder): v2's prompt
//   endpoint cannot suppress the model turn, so the runtime gates them off
//   via capabilities.noReplyDelivery.
// - compaction: session.hook("compaction") marks the session; only the
//   flag lands (the context-injection surface is unverified).
// - events: context.event.subscribe pump; the envelope is
//   {type, data, location?}. Filtered client-side the way the v1 host
//   filters server-side: events resolve to a directory (their own, the
//   session cache, or session.get) and drop when it is not ours.
// - toasts, tui commands, session delete/list endpoints:
//   no v2 surface reachable from a plugin - degrades as no-op/null.
//   fetchStatuses returns {} because the wake gate treats an unknown session
//   as idle; the event-fed status map inside the runtime does the gating.
//   Session MESSAGES are readable via session.context (mapped into the v1
//   shape), so the wrap-up greenlight check works; the compaction TRIGGER
//   does not (no session.compact on the promise domain).

type V2Context = Plugin.Context;
type V2Cleanup = Plugin.Cleanup;

// Raw setup function: the dual entry (src/index.ts) owns the plugin id and
// the merged default export; this adapter only implements the v2 setup.
export async function setup(context: V2Context): Promise<V2Cleanup | void> {
  // Verified against the live binary: Location.Info {directory, project:
  // {directory, canonical}} - directory is the session dir (forwarded
  // unchanged on deleted-worktree resume), project.directory the served
  // project root (the v1 `worktree`). A wrong guess here corrupts repo
  // identity, store scoping, and the event filter all at once.
  const location = context.location as {
    directory: string;
    project: { directory: string };
  };
  const directory = location.directory;
  const worktree = location.project.directory;

  // Plugin-created extraction children live in the project directory, which
  // differs from this instance's directory whenever opencode is launched
  // below the project root. Their events would never pass the directory
  // filter, so they are forwarded by ID: sessionCreate records every child
  // here, and the pump lets their events through.
  const childSessions = new Set<string>();

  const capabilities = buildCapabilities(context, worktree, childSessions);
  const runtime = await createRuntime({ capabilities, directory, worktree });
  // Seed the forwarding set from rehydrated child bookkeeping: after a
  // reload, an in-flight extraction child's maps come back from the journal,
  // but this NEW adapter instance's childSessions set starts empty - without
  // the seed, the pump's directory filter drops the child's events again
  // (the below-root launch case).
  for (const id of runtime.childSessionIds()) childSessions.add(id);

  // Tool registration: the same CoreContext the v1 adapter feeds to
  // createTools, registered through the v2 ToolEditor instead.
  //
  // The input schema is pre-converted to JSON Schema with our own zod:
  // v2's converter detects zod via `instanceof $ZodType` against ITS bundled
  // zod copy, which fails for ours and leaves the tool parameterless (the
  // LLM then guesses argument names and the tools crash on undefined args).
  // A plain JSON Schema object flows through v2's inputJsonSchema untouched
  // and validates through v2's JSON-schema codec cache.
  const registerTools = await context.tool.transform((editor) => {
    for (const def of TOOL_DEFS) {
      editor.add({
        name: `thatch_${def.name}`,
        description: def.description,
        input: z.toJSONSchema(z.object(def.args)),
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
    // The v2 execute.after hook's result is a Tool.Result: `content` may be
    // a string or an array of content parts ({type: "text", text}, files,
    // ...), and `output` is the tool's typed output value, not a title. v1's
    // hook delivered {title, output} strings; here the title is derived
    // from the tool name and args (the runtime pushes it through verbatim)
    // and the content is flattened to the buffer's text line.
    const result = hook.result;
    const text = flattenToolContent(result?.content);
    await runtime.onToolExecuteAfter(
      { tool: hook.tool, sessionID: hook.sessionID, args: hook.input },
      { title: deriveTitle(hook.tool, (hook.input ?? {}) as Record<string, unknown>), output: text },
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

  // Per-message nudges: the runtime computes injections once per user
  // message (here, on the prompt clone) and the generate hook appends them
  // to the OUTBOUND request's last user message. The stored user message
  // stays clean: v1 delivered nudges as TUI-hidden synthetic parts, and
  // v2's prompt text IS the stored message, so injecting there would echo
  // the nudges into the visible transcript. The generate hook instead
  // mutates only the wire request - invisible to the TUI and message list,
  // visible to the model on every call of the turn, matching v1's
  // persistent synthetic part.
  const pendingInjections = new Map<string, string[]>();
  const registerPrompt = await context.session.hook(
    "prompt",
    async (request: { sessionID: string; messageID: string; prompt: { text: string } }) => {
      runtime.debug("v2:hook:prompt", `session=${request.sessionID} text=${JSON.stringify(request.prompt.text?.slice(0, 60))}`);
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
      if (injections.length > 0) runtime.debug("v2:hook:prompt", `session=${request.sessionID} injections=${injections.length}`);
      if (injections.length > 0) pendingInjections.set(request.sessionID, injections);
      else pendingInjections.delete(request.sessionID);
    },
  );

  // Inject the turn's nudges into the outbound request. A user message is
  // always present (the prompt hook ran before the loop's first generate).
  // v2's wire Message carries parts in `content: Array<ContentPart>` - it
  // has no `parts` field, so injecting there would write a stray property
  // the provider formatter never reads (silent nudge loss).
  const registerGenerate = await context.session.hook("generate", (request: { sessionID: string; messages: any[] }) => {
    const injections = pendingInjections.get(request.sessionID);
    if (!injections?.length) return;
    const lastUser = [...request.messages].reverse().find((m) => m?.role === "user");
    if (!lastUser) return;
    const content = Array.isArray(lastUser.content) ? lastUser.content : (lastUser.content = []);
    for (const text of injections) content.push({ type: "text", text });
    // Probe telemetry (unknown 2): messages.length per call + whether the
    // last user message already carries the injection (same array across
    // the turn's model round trips would show duplicates piling up).
    const injected = content.filter((c: any) => injections.includes(c?.text)).length;
    runtime.debug("v2:hook:generate", `session=${request.sessionID} messages=${request.messages.length} injectionsTotal=${injected}/${injections.length}`);
  });

  // Compaction: the nudge-suppression flag is the only surface verified to
  // exist; the context-injection surface is unverified.
  const registerCompaction = await context.session.hook("compaction", async (request: { sessionID: string }) => {
    await runtime.onSessionCompacting({ sessionID: request.sessionID }, { context: [] });
  });

  // Wrap-up slash commands register in code (v2 CommandEditor): execute
  // arms the greenlight check and delivers the same prompt body the v1
  // command file carries. The runtime removes stale wrap-up FILES and
  // installs only the action files on v2 (a file and a registered command
  // with the same name collide).
  const registerCommands = await context.command.transform((editor) => {
    for (const kind of ["compact", "exit"] as const) {
      editor.add({
        name: `thatch/${kind}`,
        description:
          kind === "compact"
            ? "Flush thatch persistence, check for loose ends, then compact if clear"
            : "Flush thatch persistence, check for loose ends, then exit opencode if clear",
        // The user's typed arguments ride invocation.prompt (a
        // PromptInput.Prompt with a text field). v1's host expanded
        // $ARGUMENTS from the command file; v2's session.prompt does no
        // template expansion, so substitute here - dropping the args
        // would store a bare template as the user message. The function
        // replacer keeps `$` sequences in the user's text ($$ stays $$ -
        // a string replacement would interpret them).
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt?: { text?: string } }) => {
          // Same arm the v1 command.execute.before hook runs - the wrap-up
          // resolution happens on the session's next idle event.
          await runtime.onCommandExecuteBefore({ command: `thatch/${kind}`, sessionID });
          const args = typeof prompt?.text === "string" ? prompt.text : "";
          await capabilities.promptSession(
            sessionID,
            { parts: [{ type: "text", text: wrapUpCommandContent(kind).replace("$ARGUMENTS", () => args) }] },
            "sync",
          );
        },
      });
    }
  });

  // Bus events: raw SSE subscription, not directory-scoped. Filter
  // client-side: drop events located elsewhere. v2's execution lifecycle
  // events (the idle signal) carry NO location, so the session's project is
  // resolved and cached: first from any event that does carry one, then
  // via the session API. A session whose directory cannot be resolved
  // drops (same invisible-to-this-instance contract as v1's server filter).
  const sessionDirs = new Map<string, string>();
  const resolveSessionDir = async (sessionID: string): Promise<string | undefined> => {
    try {
      const result = await context.session.get({ sessionID });
      const dir = result?.location?.directory;
      if (dir) sessionDirs.set(sessionID, dir);
      return dir;
    } catch {
      return undefined;
    }
  };
  const controller = new AbortController();
  const pump = (async () => {
    try {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        // Per-event isolation: a throw inside one handler must not end the
        // loop (a dead pump means no idle events, no extraction, and a
        // frozen status map for the rest of the process). v1's host
        // dispatched each hook invocation independently; this restores that
        // blast radius.
        try {
          // Narrow to the fields the pump consumes: the generated V2Event
          // union types each payload per-variant, and the runtime's
          // translation only needs the sessionID/location pair.
          const located = event as {
            type: string;
            data?: { sessionID?: string; location?: { directory?: string } };
            location?: { directory?: string };
          };
          const data = located.data ?? {};
          if (data.sessionID && located.location?.directory) sessionDirs.set(data.sessionID, located.location.directory);
          if (data.sessionID && data.location?.directory) sessionDirs.set(data.sessionID, data.location.directory);
          let eventDir = located.location?.directory ?? (data.sessionID ? sessionDirs.get(data.sessionID) : undefined);
          if (!eventDir && data.sessionID) eventDir = await resolveSessionDir(data.sessionID);
          runtime.debug("v2:pump", `event ${located.type} dir=${eventDir} self=${directory}`);
          if (eventMatchesInstance(eventDir, data.sessionID, directory, childSessions)) {
            const translated = translateEvent(located);
            if (translated) await runtime.onEvent(translated);
          }
        } catch (err) {
          console.error(`[thatch] v2 event handler failed: ${err}`);
        }
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
    registerGenerate.dispose();
    registerCompaction.dispose();
    registerCommands.dispose();
    await runtime.dispose();
  };
}

// Map v2's SessionMessageInfo list into the v1 {info: {role}, parts} shape
// the runtime's wrap-up greenlight check reads. Assistant messages carry
// their text in content parts; other message kinds carry a plain text field
// (or none - those map to an empty part rather than dropping the message,
// so role ordering survives).
export function mapSessionContextMessages(messages: unknown): { info: { role: string }; parts: { type: string; text: string }[] }[] {
  return ((messages as any[]) ?? []).map((m) => ({
    info: { role: m?.type },
    parts:
      m?.type === "assistant"
        ? (m.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => ({ type: "text", text: c.text ?? "" }))
        : [{ type: "text", text: typeof m?.text === "string" ? m.text : "" }],
  }));
}

// Which bus events belong to this plugin instance. An event is ours when
// its resolved directory matches the instance's own directory, or when it
// belongs to a session this instance created (extraction children - they
// live in the project directory, which differs from the instance directory
// on below-root launches).
export function eventMatchesInstance(
  eventDir: string | undefined,
  sessionID: string | undefined,
  directory: string,
  childSessions: Set<string>,
): boolean {
  if (eventDir === directory) return true;
  return sessionID !== undefined && childSessions.has(sessionID);
}

// Flatten a v2 Tool.Result content field into the plain text the shared
// extraction buffer expects. Strings pass through; content-part arrays
// contribute their text parts (files and other non-text parts are dropped -
// the buffer wants a summary line, not attachments). Anything else is empty.
export function flattenToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// Translate a v2 bus event into the v1-shaped event the runtime consumes.
// v2's envelope is {type, data, location?} (payload in `data`); v1's was
// {type, properties}. The runtime's session event taxonomy also moved:
// - the idle signal is the execution lifecycle (session.execution.*);
//   session.status exists in v2's schema but nothing publishes it
// - child-session errors surface as session.execution.failed, which v1
//   called session.error
// - compaction completion is session.compaction.ended (v1: session.compacted)
// Events the runtime does not consume return null and are dropped.
function translateEvent(located: { type: string; data?: any }): { type: string; properties: any } | null {
  const data = located.data ?? {};
  switch (located.type) {
    case "session.created":
      return { type: "session.created", properties: { info: { id: data.sessionID, parentID: data.parentID } } };
    case "session.deleted":
      return { type: "session.deleted", properties: { info: { id: data.sessionID } } };
    case "session.execution.started":
      return { type: "session.status", properties: { sessionID: data.sessionID, status: { type: "busy" } } };
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return { type: "session.status", properties: { sessionID: data.sessionID, status: { type: "idle" } } };
    case "session.execution.failed":
      return { type: "session.error", properties: { sessionID: data.sessionID } };
    case "session.compaction.ended":
      return { type: "session.compacted", properties: { sessionID: data.sessionID } };
    default:
      return null;
  }
}

// The HostCapabilities implementation over the v2 promise context. Every
// operation the v2 surface lacks degrades as a no-op or null - the shared
// runtime's callers treat those results as best-effort and log, never crash.
function buildCapabilities(context: V2Context, worktree: string, childSessions: Set<string>): HostCapabilities {
  // Typed against the SDK's own SessionDomain: the shape errors the
  // original cast (as unknown as {...}) suppressed are exactly what the
  // review caught (message.list and compact do not exist here; get takes
  // {sessionID}). Let the typecheck keep holding that line.
  const session = context.session;

  return {
    noReplyDelivery: false,
    nativeCommands: true,
    // The wake gate treats an unknown session as idle; the runtime's
    // event-fed status map does the busy/retry gating on v2.
    fetchStatuses: async () => ({}),
    sessionCreate: async (input) => {
      // v2's session API has no parentID: create a TOP-LEVEL session in the
      // parent's project directory (the runtime sets the child mapping
      // eagerly - no session.created event carries it on v2). The wrapper
      // returns the created SessionInfo directly.
      const result = await session.create({ location: { directory: worktree }, title: input.title });
      const id = result?.id;
      // A shape mismatch must fail into the runtime's extraction fallback
      // (the nudge path), not silently corrupt the child-session maps.
      if (!id) throw new Error(`v2 session.create returned no id: ${JSON.stringify(result)?.slice(0, 200)}`);
      // Register for event forwarding: the child's events carry the project
      // directory, which the pump's directory filter would otherwise drop.
      childSessions.add(id);
      return { id };
    },
    // No delete on the v2 SessionDomain: extraction child sessions are not
    // cleaned up on v2 (documented gap; the bookkeeping maps still keep the
    // nudge path consistent). Two user-visible consequences: the session
    // picker accumulates one thatch-extraction entry per extraction, and
    // "continue last session" (-c) logic that picks the newest top-level
    // session will land in an extraction child after any session that
    // triggered extraction, because the child is top-level and newer.
    sessionDelete: async () => {},
    promptSession: async (sessionID, body, _mode) => {
      // v2's prompt endpoint takes text, not parts, and has no synthetic /
      // noReply semantics. Nudge injections ride the prompt hook.
      //
      // Synthetic deliveries (watcher + chat wake nudges) route to v2's
      // session.synthetic endpoint: a TUI-hidden message, matching v1's
      // synthetic part. mode is v1-only (async = promptAsync vs sync =
      // prompt); v2's prompt enqueues the message and returns while the
      // model turn runs asynchronously, so the extraction background flag
      // degrades: both modes enqueue the same way.
      const text = body.parts.map((part) => part.text).join("\n\n");
      if (!body.noReply && body.parts.length > 0 && body.parts.every((part) => part.synthetic)) {
        await session.synthetic({ sessionID, text });
        return;
      }
      await session.prompt({ sessionID, text });
    },
    sessionGet: async (id) => {
      // SessionGetInput is {sessionID}, and the adapter decodes the input
      // before the host call - any other key rejects. The wrapper returns
      // the SessionInfo directly (the envelope is unwrapped).
      return (await session.get({ sessionID: id })) ?? null;
    },
    sessionList: async () => null,
    sessionMessages: async (id) => {
      // The v2 promise domain has no message-list endpoint (no
      // `message` accessor and no compact/remove in the SessionDomain Pick).
      // `session.context` IS exposed and returns the session's message list
      // (Array<SessionMessageInfo>); map into the v1 shape the wrap-up
      // greenlight check reads.
      const result = await session.context({ sessionID: id });
      return mapSessionContextMessages(result);
    },
    showToast: async (_toast: ToastInput) => {
      // No toast publish path reachable from the promise context (the
      // tui.toast.show event has no producer surface here). Degrades.
    },
    compactSession: async () => {
      // No compaction trigger is reachable from the promise context: the
      // SessionDomain Pick has no session.compact, and the built-in
      // /compact is a TUI palette action calling the server endpoint
      // directly (the server command registry only knows config/plugin-
      // registered names). The compact wrap-up still runs its checklist
      // and flush; only the automatic compaction itself degrades.
      console.error("[thatch] v2: compaction trigger unavailable; wrap-up checklist ran, compact skipped");
    },
    exitHost: async () => {
      // No TUI surface on v2; the exit wrap-up's checklist and flush run,
      // the exit itself does not. When upstream restores a publish path,
      // the right v2 target is session.tab.close (close THIS session's
      // tab), not app.exit - on a shared daemon app.exit would take down
      // every tab. Tracked in anomalyco/opencode#50984.
    },
  };
}
