// HostCapabilities: the plugin-lifecycle operations the shared runtime needs
// from whatever opencode version hosts it. The v1 adapter implements it over
// the SDK client from PluginInput; the v2 adapter implements it over the v2
// promise-context domains, degrading (catch-and-ignore or null) where the v2
// surface lacks an operation. This is the lifecycle-level sibling of
// CoreContext (src/tool-defs.ts), which is the per-tool-call seam; they stay
// separate on purpose.
//
// Typed structurally so test doubles and both adapters satisfy it without a
// runtime dependency on either SDK package; the v1 bridge alone imports the
// v1 SDK types (type-only, erased at runtime) so the compiler checks its
// mapping against the real client.

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
   * the greenlight check via onCommandExecuteBefore) - a registered
   * command and an installed file with the same name would collide.
   */
  readonly nativeCommands: boolean;
  /** Live session statuses, as client.session.status() returns. */
  fetchStatuses(): Promise<Record<string, { type: string }> | null>;
  /**
   * Create a child session. Returns its id. v1 passes the parentID through
   * (the host links the child); v2 has no parentID on its create API, so
   * the child is a top-level session in the parent's project directory and
   * only the title carries over.
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
  /** Fetch one session's info (title, location). Null when the host rejects. */
  sessionGet(id: string): Promise<{ title?: string } | null>;
  /** List sessions in this directory. Null when unavailable (v2 degrade). */
  sessionList(): Promise<{ id: string; parentID?: string; time?: { updated?: number } }[] | null>;
  /**
   * Fetch a session's message list (wrap-up greenlight check). Null when
   * unavailable. v2 reads them via session.context, mapped into this shape.
   */
  sessionMessages(id: string): Promise<{ info: { role: string }; parts?: { type: string; text?: string }[] }[] | null>;
  /** TUI toast. The runtime's call sites catch-and-ignore; the adapter just delivers. */
  showToast(toast: ToastInput): Promise<void>;
  /**
   * Trigger the host's compaction for a session (the wrap-up compact
   * action). v1 dispatches the TUI's session_compact command (the legacy
   * alias route; the id is ignored). v2 has no compaction trigger reachable
   * from the promise context and degrades to a logged no-op.
   */
  compactSession(sessionID: string): Promise<void>;
  /**
   * Exit the host application (the wrap-up exit action). v1 publishes the
   * TUI's app.exit command; v2 has no TUI surface and degrades to a no-op.
   */
  exitHost(): Promise<void>;
}

/**
 * v1 implementation: the SDK client from PluginInput. The mapping mirrors
 * the v1 hook surface one call at a time, so the client-mocking tests
 * observe identical call patterns.
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
    compactSession: async () => {
      // executeCommand only accepts legacy alias names; "session_compact"
      // maps to the TUI's session.compact action, the same thing the
      // built-in /compact command runs.
      await client.tui.executeCommand({ body: { command: "session_compact" } });
    },
    exitHost: async () => {
      // No exit alias exists, so publish the TUI keymap command directly -
      // the same dispatch as the /exit slash command.
      await client.tui.publish({
        body: { type: "tui.command.execute", properties: { command: "app.exit" } },
      } as Parameters<typeof client.tui.publish>[0]);
    },
  };
}
