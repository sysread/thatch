/**
 * The Claude Code plugin mod's decision logic - the plugin regime's
 * lifecycle-and-delivery layer. This module is the unit-testable surface;
 * the generated plugin's hooks/register.js is the thin shim Claude Code
 * actually loads (it binds the rendered instructions and re-exports
 * register).
 *
 * NODE-FREE BY CONTRACT: Claude Code's mods runtime gives hooks NO Node
 * APIs (no node: imports, no timer globals, no file/network access of its
 * own) - everything goes through the capability-mediated mods API ($).
 * This module must never import node:* or anything that transitively
 * does; the plugin build targets the browser so a violation fails the
 * build, and the subprocess probe test checks the source graph.
 *
 * The mod is deliberately thin: ALL durable state lives in the bundled
 * MCP server (mod module state is wiped on reload), and the mod's only
 * jobs are delivery (prompt.submit context injection) and instructions
 * (prompt.compose).
 */

/** The slice of the mods API this mod uses. Shapes marked PIN are
 *  documented-unverified and verified against the live app during QA;
 *  each has a fallback recorded in the plan doc. */
export interface ModsApi {
  session: {
    /** PIN: the mod's own session id ($ .session.id - listed in the mods
     *  reference). Fallback: read it from the event payload if the event
     *  carries one. */
    id(): Promise<string>;
    /** PIN: the host's compaction action (verified present in the mods
     *  reference's $.session namespace). */
    compact(): Promise<unknown>;
  };
  ui: {
    /** PIN: the out-of-band notification with the documented resolution
     *  contract. Used only for the exit wrap-up's degradation. */
    notify(text: string): Promise<unknown>;
  };
  mcp: {
    /** PIN: calling a manifest-listed server's tool. The response shape
     *  is assumed to be the tool's text (string) or an object carrying
     *  it; readStageText tolerates all plausible shapes. Fallback: if
     *  $.mcp.call is unavailable, the mod fails open - prompts proceed
     *  without thatch context. */
    call(call: { server: string; tool: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  };
  command: {
    /** PIN: programmatic command registration (session.start; a taken
     *  name throws). */
    register(def: { name: string; description: string; argumentHint?: string }): Promise<unknown>;
  };
  tool: {
    /** PIN: programmatic tool registration (surfaced as
     *  mcp__<plugin>__<name>). */
    register(def: { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred?: boolean }): Promise<unknown>;
  };
  clock: {
    /** PIN: the mods runtime's timer (the setInterval stand-in); the
     *  callback runs outside any event's time budget and stops on module
     *  reload. */
    every(ms: number, fn: () => void | Promise<void>): { cancel(): void };
  };
  prompt: {
    /** PIN: starts a turn from a background job (the proactive wake
     *  channel). Refuses after a user interrupt - the docs' retry
     *  pattern resubmits from turn.complete. */
    submit(args: { text: string }): Promise<{ drop?: string } | unknown>;
  };
}

/** The `on` registrar's handler shape, narrowed to what the mod registers. */
export interface ModRegistrar {
  (event: "prompt.submit", handler: ($: ModsApi, e: PromptSubmitEvent, next: (e?: PromptSubmitEvent) => Promise<PromptSubmitEvent>) => Promise<PromptSubmitEvent>): unknown;
  (event: "prompt.compose", handler: ($: ModsApi, e: PromptComposeEvent, next: (e?: PromptComposeEvent) => Promise<PromptComposeEvent>) => Promise<PromptComposeEvent>): unknown;
  (event: "tool.call", handler: ($: ModsApi, e: ToolCallEvent, next: (e?: ToolCallEvent) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "turn.start", handler: ($: ModsApi, e: TurnEvent, next: (e?: TurnEvent) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "turn.complete", handler: ($: ModsApi, e: TurnCompleteEvent, next: (e?: TurnCompleteEvent) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "command.run", handler: ($: ModsApi, e: CommandRunEvent, next: (e?: CommandRunEvent) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "classic.PermissionRequest", handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "session.end", handler: ($: ModsApi, e: { reason?: string }, next: (e?: { reason?: string }) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "classic.StopFailure", handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "classic.PermissionDenied", handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "session.start", handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "turn.complete", matcher: Record<string, unknown>, handler: ($: ModsApi, e: TurnCompleteEvent, next: (e?: TurnCompleteEvent) => Promise<unknown>) => Promise<unknown>): unknown;
  // The matcher form (the docs' second argument): an object whose fields
  // narrow which events reach the handler.
  (event: string, matcher: Record<string, unknown>, handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: unknown) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: string, handler: (...args: never[]) => Promise<unknown>): unknown;
}

export interface PromptSubmitEvent {
  text: string;
  context?: string[];
  [key: string]: unknown;
}

export interface PromptComposeEvent {
  sections?: string[];
  [key: string]: unknown;
}

export interface ToolCallEvent {
  tool: string;
  agentId?: string;
  [key: string]: unknown;
}

export interface TurnEvent {
  agentId?: string;
  [key: string]: unknown;
}

export interface TurnCompleteEvent extends TurnEvent {
  isAborted?: boolean;
}

export interface CommandRunEvent {
  args?: string;
  [key: string]: unknown;
}

export interface ThatchModOptions {
  /** The rendered instructions (one template, generated at plugin build
   *  time from src/prompts.ts's claudeInstructions) - injected via
   *  prompt.compose. Must be session-static: text that changes between
   *  requests invalidates the prompt cache. */
  instructions: string;
  /** The bundled server's stage tool coordinates (the plugin's own
   *  manifest server). */
  stageTool: { server: string; tool: string };
  /** The bundled server's lifecycle tool coordinates. */
  lifecycleTool: { server: string; tool: string };
  /** The bundled server's chat-wake poll coordinates. */
  chatWakeTool: { server: string; tool: string };
  /** The bundled server's watcher-poll drain coordinates. */
  watchPollTool: { server: string; tool: string };
  /** The chat-wake poll cadence, ms (the opencode poller's beat, 30s). */
  wakePollMs?: number;
}

/** The wrap-up kinds the mod registers as command + greenlight-tool pairs. */
const WRAPUP_KINDS = ["compact", "exit"] as const;

/**
 * Tolerant reader for the lifecycle tool's response: the wrap-up action
 * rides as JSON {text, wrapup?}. The $.mcp.call envelope is one pin shared
 * by all four tools, so every envelope shape stage/wake tolerate must
 * unwrap here too - but UNLIKE readStageText, the wrapup field must
 * survive: a lifecycle response degraded to empty text silently drops the
 * compact/exit host actions and the arm/greenlight acks.
 *
 * The ambiguity this navigates: {text: "..."} is BOTH a plausible envelope
 * (text = a JSON string of the result) and a parsed result without a
 * wrapup. Disambiguated by parse: when the text parses to an object
 * carrying its own text, that inner object is the result.
 */
function readLifecycleResult(res: unknown): { text: string; wrapup?: "compact" | "exit" } {
  const asResult = (obj: Record<string, unknown>): { text: string; wrapup?: "compact" | "exit" } | null => {
    if (typeof obj?.text !== "string") return null;
    const w = obj.wrapup;
    if (w === "compact" || w === "exit") return { text: obj.text, wrapup: w };
    // No wrapup: if the text is itself a JSON result object, THAT is the
    // payload (an envelope); otherwise this object IS the result (a
    // plain-text ack).
    try {
      const inner = JSON.parse(obj.text) as Record<string, unknown>;
      const innerResult = asResult(inner);
      if (innerResult) return innerResult;
    } catch { /* plain text ack - not JSON */ }
    return { text: obj.text };
  };
  // Content-block array: unwrap to the joined text, then parse.
  if (Array.isArray(res)) {
    try {
      return asResult(JSON.parse(readStageText(res))) ?? { text: readStageText(res) };
    } catch {
      return { text: readStageText(res) };
    }
  }
  if (typeof res === "string") {
    try {
      return asResult(JSON.parse(res)) ?? { text: res };
    } catch {
      return { text: res };
    }
  }
  // { result: X } envelope: recurse. A direct result object: asResult.
  const obj = (res ?? {}) as Record<string, unknown>;
  if (obj.result !== undefined) return readLifecycleResult(obj.result);
  return asResult(obj) ?? { text: "" };
}

/**
 * Tolerant reader for the stage tool's response: the tool returns text,
 * and the mods API's exact response envelope is a QA pin. Accepts a bare
 * string, { text }, { result }, or an MCP content-block array.
 */
export function readStageText(res: unknown): string {
  if (typeof res === "string") return res;
  if (res == null) return "";
  if (Array.isArray(res)) {
    return res.map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : "")).join("");
  }
  const obj = res as Record<string, unknown>;
  for (const key of ["text", "result"]) {
    const v = obj[key];
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Registers the mod's hooks. Registers COMMANDS LAST when commands exist
 * (a taken name throws and a throw skips the rest of the session.start
 * hook - so the GREENLIGHT TOOLS register first and the command names,
 * which can collide, last).
 */
export function registerMod(on: ModRegistrar, options: ThatchModOptions): void {
  // prompt.compose: inject the ONE-TEMPLATE instructions as a new section.
  // The text is session-static (rendered at plugin build), so the prompt
  // cache is safe. PIN: the compose event's section shape; fallback if
  // compose is unsupported at QA - re-run setup without the plugin regime
  // (the fallback regime's CLAUDE.md markers return).
  on("prompt.compose", async (_, e, next) => {
    return next({ ...e, sections: [...(e.sections ?? []), options.instructions] } as PromptComposeEvent);
  });

  // Mod state (module scope - wiped on reload, which only costs one poll
  // beat): the wake-in-flight flag marks "a wake submission happened since
  // the last turn.start" - BEST-EFFORT provenance. If the user's own
  // prompt and a poll hit race, whichever turn.start fires first consumes
  // the flag: the user's round can classify synthetic (its done alert
  // silenced once) or the wake's round user-waited (one spurious done).
  // Bounded single-event misattribution, never a loop; replacing it needs
  // a submission token echoed by the host (a QA-pin upgrade).
  let wakeInFlight = false;
  let pendingWake: string | null = null;
  // The poller's handle: session.start re-fires on a session fork - the
  // previous timer cancels or two pollers beat (a reload wipes module
  // state, so the handle starts null every load).
  let wakeTimer: { cancel(): void } | null = null;

  // prompt.submit: liveness + stage. The stage tool call stamps the mod
  // liveness file (the disabled-mod detector) and returns the nudge text
  // for this prompt; empty text injects nothing. Fail-open everywhere: a
  // failed stage call must never eat the user's prompt - the prompt
  // proceeds without thatch context (the host would skip a throwing hook
  // anyway; the .catch keeps that behavior explicit).
  on("prompt.submit", async ($, e, next) => {
    let stageText = "";
    try {
      const sessionId = await $.session.id();
      const res = await $.mcp.call({
        server: options.stageTool.server,
        tool: options.stageTool.tool,
        arguments: { prompt: e.text ?? "", session_id: sessionId, ...(e.transcript_path ? { transcript_path: e.transcript_path } : {}) },
      });
      stageText = readStageText(res);
    } catch {
      return next(e);
    }
    if (!stageText.trim()) return next(e);
    return next({ ...e, context: [...(e.context ?? []), stageText] } as PromptSubmitEvent);
  });

  // --- alerts: the mod forwards, the server classifies and delivers ---

  // Main conversation only (e.agentId set = a subagent's turn): subagent
  // rounds are not the user's waiting-on work. The busy event carries the
  // wake provenance (a turn this mod submitted via $.prompt.submit is
  // bookkeeping, not user-waited work - the machine stays silent on it).
  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await forwardLifecycle($, options, { event: "busy", wake: wakeInFlight });
      } catch { /* alerts are best-effort */ } finally {
        wakeInFlight = false;
      }
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    // The wrap-up greenlight tools route to the arm check, not to work
    // bookkeeping. Everything else forwards as a real-work candidate -
    // WITH its input and result text: the same forward is the plugin
    // regime's BUFFER PUSH (the server owns the buffer's filtering). The
    // result is serialized defensively: the middleware result's shapes
    // vary per tool (result field, bare string, deny).
    const result = await next(e);
    const resultText = typeof result === "string"
      ? result
      : ((result as { result?: unknown; text?: unknown })?.result ?? (result as { text?: unknown })?.text ?? "");
    try {
      await forwardLifecycle($, options, {
        event: "realwork",
        tool: e.tool,
        // THE WIRE SPELLING: the tool's zod schema reads snake_case
        // (tool_input/tool_response/is_main/...). The schema is the
        // boundary's single naming authority - the mod spells THIS way,
        // never camelCase (deepPassthrough would silently drop the
        // camel keys and hollow out buffering + the verdicts).
        tool_input: toolArgsOf(e),
        tool_response: typeof resultText === "string" ? resultText.slice(0, 2000) : JSON.stringify(resultText).slice(0, 2000),
        is_main: e.agentId === undefined,
      });
    } catch { /* alerts + buffering are best-effort */ }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        // The wake retry first: a submission refused at the interrupt
        // resubmits here (the docs' pattern) - before the verdict, so the
        // retried turn is not swallowed by this turn's classification.
        if (pendingWake !== null) {
          const text = pendingWake;
          try {
            // Same contract as the poll's submit: a drop (ANY wording) or
            // a throw means still-held - the text SURVIVES for the next
            // turn end; only a clean result consumes it.
            const res = await $.prompt.submit({ text }) as { drop?: string };
            if (res?.drop) {
              pendingWake = text;
            } else {
              pendingWake = null;
              wakeInFlight = true;
            }
          } catch {
            pendingWake = text;
          }
        }
        const res = await forwardLifecycle($, options, { event: "complete", is_aborted: e.isAborted === true });
        // The wrap-up resolution fires at idle, exactly the opencode
        // contract: compact = the host action; exit has no host close API,
        // so it degrades to a user notification (the plan's documented
        // degradation).
        if (res.wrapup === "compact") {
          await $.session.compact();
        } else if (res.wrapup === "exit") {
          await $.ui.notify("Thatch wrap-up complete - it is safe to close this session.");
        }
      }
    } catch { /* the wrap-up action is best-effort */ }
    return next(e);
  });

  // Permission asks: the pause alert. Resolution signals are
  // undocumented on this host (PIN) - PermissionDenied is the one
  // observed end; an unresolved ask suppresses only its own repeats.
  on("classic.PermissionRequest", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "ask",
        kind: "permission",
        request_id: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined,
      });
    } catch { /* alerts are best-effort */ }
    return next(e);
  });
  on("classic.PermissionDenied", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "resolved",
        request_id: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined,
      });
    } catch { /* alerts are best-effort */ }
    return next(e);
  });

  // Provider failures: turn.complete carries NO error field, so the
  // round's error verdict rides the StopFailure event's kind. Without
  // this forward a failed round classifies as done ("Work finished") -
  // the exact wrong-alert the error class exists to prevent.
  on("classic.StopFailure", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "error",
        error: typeof e.error === "string" ? e.error : typeof e.kind === "string" ? e.kind : "ProviderError",
      });
    } catch { /* alerts are best-effort */ }
    return next(e);
  });

  // Session end: a REAL end (branch on e.reason - /clear, /resume, and
  // /branch also fire this event) reports the death to the registry
  // (watcher death notices + journal cleanup) inside the event's
  // 1.5-second budget. Fail-open: a failed forward must not delay the
  // host's teardown.
  on("session.end", async ($, e, next) => {
    const reason = String(e?.reason ?? "other");
    if (reason !== "clear" && reason !== "resume" && reason !== "branch") {
      try {
        await forwardLifecycle($, options, { event: "session-end" });
      } catch { /* death routing is best-effort */ }
    }
    return next(e);
  });

  // Wrap-up commands + their zero-arg greenlight tools: the opencode
  // protocol (arm on command, the model greenlights with the tool, the
  // action fires at turn end), ported. TOOLS register first, COMMANDS
  // last (see the registerMod comment for the throw-skips-the-rest
  // ordering rule).
  on("session.start", async ($, e, next) => {
    try {
      // TOOLS first, COMMANDS last: a taken name throws and a throw skips
      // the REST of the hook - the greenlight tools are the wrap-up's
      // load-bearing surface, so they register before the command names
      // that can collide.
      for (const kind of WRAPUP_KINDS) {
        await $.tool.register({
          name: kind,
          description: `Greenlight the ${kind} wrap-up (the user armed it with /thatch_${kind}). Call when the checklist is done.`,
          inputSchema: { type: "object", properties: {} },
        });
      }
      for (const kind of WRAPUP_KINDS) {
        await $.command.register({
          name: `thatch_${kind}`,
          description: kind === "compact"
            ? "Arm the compact wrap-up: run your closing checklist, then call the compact tool."
            : "Arm the exit wrap-up: run your closing checklist, then call the exit tool.",
        });
      }
    } catch { /* a taken name skips the rest - the catch keeps the session start alive */ }

    // The chat-wake poller: the proactive delivery the settings-hook
    // regime could never do. The poll asks the bundled server for pending
    // mail (the re-nudge window bounds repeats server-side); a non-empty
    // answer is submitted as a turn. Refused submissions (a user
    // interrupt holds plugins' input) retry from turn.complete - the
    // docs' pattern. The timer dies on module reload; the next reload
    // re-arms it. session.start re-fires on a session fork - the previous
    // timer cancels (module state wipes on reload, so the handle starts
    // null every load).
    wakeTimer?.cancel();
    const pollWake = async () => {
      // ONE beat, TWO polls, INDEPENDENT catches: a persistently failing
      // chat-wake must not starve watcher delivery (each poll fails
      // alone; only a shared failure - $.session.id down - skips the
      // beat).
      let sessionId: string;
      try {
        sessionId = await $.session.id();
      } catch {
        return; // identity unavailable - the next beat retries
      }
      let wakeText = "";
      try {
        wakeText = readStageText(await $.mcp.call({
          server: options.chatWakeTool.server,
          tool: options.chatWakeTool.tool,
          arguments: { session_id: sessionId },
        }));
      } catch { /* chat wake fails alone */ }
      let watchRes = "";
      try {
        watchRes = readStageText(await $.mcp.call({
          server: options.watchPollTool.server,
          tool: options.watchPollTool.tool,
          arguments: { session_id: sessionId },
        }));
      } catch { /* watcher events fail alone */ }
      const text = [wakeText, watchRes].filter((t) => t.trim()).join("\n\n");
      if (!text.trim()) return;
      // A drop of ANY wording means "not delivered" - the conservative
      // branch holds the text for the turn.end retry; only a CLEAN result
      // (no drop field) counts as delivered. Matching refusal prose would
      // lose mail on novel wording and corrupt the wake provenance.
      try {
        const res = await $.prompt.submit({ text }) as { drop?: string };
        if (res?.drop) {
          pendingWake = text;
        } else {
          pendingWake = null;
          wakeInFlight = true;
        }
      } catch {
        pendingWake = text;
      }
    };
    wakeTimer = $.clock.every(options.wakePollMs ?? 30_000, pollWake);

    return next(e);
  });
  on("command.run", { command: "thatch_compact" }, async ($) => {
    return await armWrapup($, options, "compact");
  });
  on("command.run", { command: "thatch_exit" }, async ($) => {
    return await armWrapup($, options, "exit");
  });
  on("tool.call", { tool: "mcp__thatch__compact" }, async ($) => {
    return await greenlightWrapup($, options, "compact");
  });
  on("tool.call", { tool: "mcp__thatch__exit" }, async ($) => {
    return await greenlightWrapup($, options, "exit");
  });
}

async function forwardLifecycle($: ModsApi, options: ThatchModOptions, args: Record<string, unknown>): Promise<{ text: string; wrapup?: "compact" | "exit" }> {
  const sessionId = await $.session.id();
  const res = await $.mcp.call({
    server: options.lifecycleTool.server,
    tool: options.lifecycleTool.tool,
    arguments: { ...args, session_id: sessionId },
  });
  return readLifecycleResult(res);
}

/** The tool call event's OWN fields become the buffered interaction's args
 *  (the mods events carry arguments as top-level fields: e.command for
 *  Bash, e.file_path for Edit) - minus the transport keys (the tool name,
 *  the agent scoping, and the mod's injected session identity). */
function toolArgsOf(e: ToolCallEvent): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === "tool" || k === "agentId" || k === "session_id") continue;
    args[k] = v;
  }
  return args;
}

async function armWrapup($: ModsApi, options: ThatchModOptions, kind: "compact" | "exit"): Promise<{ text: string }> {
  try {
    const res = await forwardLifecycle($, options, { event: "arm", kind });
    return { text: res.text };
  } catch {
    return { text: `[thatch] the ${kind} wrap-up could not be armed (the bundled server is unreachable). Nothing was armed.` };
  }
}

async function greenlightWrapup($: ModsApi, options: ThatchModOptions, kind: "compact" | "exit"): Promise<unknown> {
  let teach: string;
  try {
    const res = await forwardLifecycle($, options, { event: "greenlight", kind });
    teach = res.text;
  } catch {
    teach = "[thatch] the wrap-up greenlight could not reach the bundled server; the wrap-up will not fire.";
  }
  // Answer the call without running anything (there is no real tool) -
  // the text is all the model learns, accept-then-teach style.
  return { result: teach };
}
