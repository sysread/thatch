// HostCapabilities: the plugin-lifecycle operations the shared runtime needs
// from whatever opencode version hosts it. The v1 adapter implements it over
// the SDK client from PluginInput; the v2 adapter implements it over the v2
// promise-context domains, degrading (catch-and-ignore or null) where the v2
// surface lacks an operation. This is the lifecycle-level sibling of
// CoreContext (src/tool-defs.ts), which is the per-tool-call seam; they stay
// separate on purpose.
//
// Typed structurally - no host SDK import - so test doubles and both
// adapters satisfy it without depending on a specific SDK package.

// Typed structurally where the contract is shared, but the v1 bridge uses
// the real PluginInput client type so the mapping is checked against the
// SDK. Type-only import: erased at runtime, safe under either host.
import type { PluginInput } from "@opencode-ai/plugin";

/** Minimal text-part shape used for session prompts and nudges. */
export interface PromptPart {
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface ToastInput {
  message: string;
  variant: "info" | "success" | "warning" | "error";
  duration: number;
}

export interface HostCapabilities {
  /**
   * Whether promptSession honors noReply (deliver without starting a model
   * turn). v1: true (promptAsync with noReply renders a visible bubble and
   * starts nothing). v2: false - the prompt endpoint has no noReply
   * semantics, so a noReply delivery would start a real model turn. The
   * runtime gates its noReply callers (chat echoes, session-start
   * reminder) on this; turning it on for a host without support creates a
   * model-turn feedback loop.
   */
  readonly noReplyDelivery: boolean;
  /**
   * The host lets plugins register slash commands programmatically (v2's
   * CommandEditor). When true the runtime installs only the action command
   * FILES and the adapter registers the wrap-up commands in code (arming
   * the greenlight check via ThatchRuntime.armWrapUp) - a registered
   * command and an installed file with the same name would collide.
   */
  readonly nativeCommands: boolean;
  /** Live session statuses, as client.session.status() returns. */
  fetchStatuses(): Promise<Record<string, { type: string }> | null>;
  /**
   * Create a child session. Returns its id. The v2 host has this on the
   * session domain; the parentID/title body is shared behavior.
   */
  sessionCreate(input: { parentID: string; title: string }): Promise<{ id: string }>;
  /** Delete a session (child-session cleanup). Degrades to a no-op resolve on v2. */
  sessionDelete(id: string): Promise<void>;
  /**
   * Prompt a session with text parts. `sync` mode blocks until the child
   * finishes (v1 client.session.prompt); async mode returns immediately
   * (v1 client.session.promptAsync). Both may reject; callers own
   * fire-and-forget vs await.
   */
  promptSession(
    sessionID: string,
    body: { parts: PromptPart[]; noReply?: boolean },
    mode: "sync" | "async",
  ): Promise<void>;
  /** Fetch one session's title/topic. Null when unavailable (v2 degrade). */
  sessionGet(id: string): Promise<{ title?: string } | null>;
  /** List sessions in this directory. Null when unavailable (v2 degrade). */
  sessionList(): Promise<{ id: string; parentID?: string; time?: { updated?: number } }[] | null>;
  /**
   * Fetch a session's message list (wrap-up greenlight check). Null when
   * unavailable (v2 has no equivalent - wrap-up degrades).
   */
  sessionMessages(id: string): Promise<{ info: { role: string }; parts?: { type: string; text?: string }[] }[] | null>;
  /** TUI toast. The runtime's call sites catch-and-ignore; the adapter just delivers. */
  showToast(toast: ToastInput): Promise<void>;
  /**
   * TUI command dispatch (the wrap-up compact action). sessionID carries the
   * requesting session: the v2 adapter maps "session_compact" to the server's
   * session.compact endpoint (no TUI surface exists on v2); v1 dispatches the
   * TUI command and ignores the id.
   */
  tuiExecuteCommand(command: string, sessionID?: string): Promise<void>;
  /** Raw TUI event publish (wrap-up exit). Degrades on v2. */
  tuiPublish(body: unknown): Promise<void>;
}

/**
 * v1 implementation: the SDK client from PluginInput. Every operation maps
 * 1:1 to the client call the plugin body used before the seam existed, so
 * the client-mocking tests observe identical call patterns.
 */
export function capabilitiesFromClient(client: PluginInput["client"]): HostCapabilities {
  return {
    noReplyDelivery: true,
    nativeCommands: false,
    fetchStatuses: async () => {
      const { data } = await client.session.status();
      return data ?? {};
    },
    sessionCreate: async (input) => {
      const result = await client.session.create({ body: input });
      return { id: result.data!.id };
    },
    sessionDelete: async (id) => {
      await client.session.delete({ path: { id } });
    },
    promptSession: async (sessionID, body, mode) => {
      const call = { path: { id: sessionID }, body };
      if (mode === "async") await client.session.promptAsync(call);
      else await client.session.prompt(call);
    },
    sessionGet: async (id) => {
      const { data } = await client.session.get({ path: { id } });
      return data ?? null;
    },
    sessionList: async () => {
      const { data } = await client.session.list();
      return data ?? null;
    },
    sessionMessages: async (id) => {
      const { data } = await client.session.messages({ path: { id } });
      return data ?? null;
    },
    showToast: async (toast) => {
      await client.tui.showToast({ body: toast });
    },
    tuiExecuteCommand: async (command) => {
      await client.tui.executeCommand({ body: { command } });
    },
    tuiPublish: async (body) => {
      // The v1 client types the body as the TUI event union; the shared
      // runtime passes the raw publish payload structurally.
      await client.tui.publish({ body } as Parameters<typeof client.tui.publish>[0]);
    },
  };
}
