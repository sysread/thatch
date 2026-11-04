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
  };
  mcp: {
    /** PIN: calling a manifest-listed server's tool. The response shape
     *  is assumed to be the tool's text (string) or an object carrying
     *  it; readStageText tolerates all plausible shapes. Fallback: if
     *  $.mcp.call is unavailable, the mod fails open - prompts proceed
     *  without thatch context. */
    call(call: { server: string; tool: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  };
}

/** The `on` registrar's handler shape, narrowed to what the mod registers. */
export interface ModRegistrar {
  (event: "prompt.submit", handler: ($: ModsApi, e: PromptSubmitEvent, next: (e?: PromptSubmitEvent) => Promise<PromptSubmitEvent>) => Promise<PromptSubmitEvent>): unknown;
  (event: "prompt.compose", handler: ($: ModsApi, e: PromptComposeEvent, next: (e?: PromptComposeEvent) => Promise<PromptComposeEvent>) => Promise<PromptComposeEvent>): unknown;
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

export interface ThatchModOptions {
  /** The rendered instructions (one template, generated at plugin build
   *  time from src/prompts.ts's claudeInstructions) - injected via
   *  prompt.compose. Must be session-static: text that changes between
   *  requests invalidates the prompt cache. */
  instructions: string;
  /** The bundled server's stage tool coordinates (the plugin's own
   *  manifest server). */
  stageTool: { server: string; tool: string };
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
}
