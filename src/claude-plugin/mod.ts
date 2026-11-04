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
  (event: "classic.PermissionDenied", handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>): unknown;
  (event: "session.start", handler: ($: ModsApi, e: Record<string, unknown>, next: (e?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>): unknown;
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
}

/** The wrap-up kinds the mod registers as command + greenlight-tool pairs. */
const WRAPUP_KINDS = ["compact", "exit"] as const;

/**
 * Tolerant reader for the lifecycle tool's response: the wrap-up action
 * rides as JSON {text, wrapup?}; the envelope shape is a QA pin.
 */
function readLifecycleResult(res: unknown): { text: string; wrapup?: "compact" | "exit" } {
  if (typeof res === "string") {
    try {
      return JSON.parse(res) as { text: string; wrapup?: "compact" | "exit" };
    } catch {
      return { text: res };
    }
  }
  const obj = (res ?? {}) as Record<string, unknown>;
  const inner = typeof obj.text === "string" ? obj : ((obj.result ?? {}) as Record<string, unknown>);
  const text = typeof inner.text === "string" ? inner.text : "";
  const wrapup = inner.wrapup === "compact" || inner.wrapup === "exit" ? inner.wrapup : undefined;
  return { text, wrapup };
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
 * hook - Step B's commands will follow this rule; Step A registers none).
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
        arguments: { prompt: e.text ?? "", session_id: sessionId },
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
  // rounds are not the user's waiting-on work.
  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await forwardLifecycle($, options, { event: "busy" });
      } catch { /* alerts are best-effort */ }
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    // The wrap-up greenlight tools route to the arm check, not to work
    // bookkeeping. Everything else main-conversation forwards as a
    // real-work candidate; the server owns the meta/no-work filtering.
    const result = await next(e);
    if (e.agentId === undefined) {
      try {
        await forwardLifecycle($, options, { event: "realwork", tool: e.tool });
      } catch { /* alerts are best-effort */ }
    }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const res = await forwardLifecycle($, options, { event: "complete", isAborted: e.isAborted === true });
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
        requestID: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined,
      });
    } catch { /* alerts are best-effort */ }
    return next(e);
  });
  on("classic.PermissionDenied", async ($, e, next) => {
    try {
      await forwardLifecycle($, options, {
        event: "resolved",
        requestID: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined,
      });
    } catch { /* alerts are best-effort */ }
    return next(e);
  });

  // Wrap-up commands + their zero-arg greenlight tools: the opencode
  // protocol (arm on command, the model greenlights with the tool, the
  // action fires at turn end), ported. Registration goes in
  // session.start - wait for Step B's commit for the command names'
  // rationale; register COMMANDS LAST (a taken name throws and a throw
  // skips the rest of the hook).
  on("session.start", async ($, e, next) => {
    try {
      for (const kind of WRAPUP_KINDS) {
        await $.command.register({
          name: `thatch_${kind}`,
          description: kind === "compact"
            ? "Arm the compact wrap-up: run your closing checklist, then call the compact tool."
            : "Arm the exit wrap-up: run your closing checklist, then call the exit tool.",
        });
      }
      for (const kind of WRAPUP_KINDS) {
        await $.tool.register({
          name: kind,
          description: `Greenlight the ${kind} wrap-up (the user armed it with /thatch_${kind}). Call when the checklist is done.`,
          inputSchema: { type: "object", properties: {} },
        });
      }
    } catch { /* a taken name skips the rest - the catch keeps the session start alive */ }
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
