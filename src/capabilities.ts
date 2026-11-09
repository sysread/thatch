// HostCapabilities: the plugin-lifecycle operations the shared runtime needs
// from the opencode 2.x host. The v2 adapter (src/opencode/v2.ts) implements
// it over the plugin promise-context domains. This is the lifecycle-level
// sibling of CoreContext (src/tool-defs.ts), which is the per-tool-call
// seam; they stay separate on purpose.
//
// Typed structurally so test doubles satisfy it without a runtime dependency
// on the SDK package; the adapter imports the SDK types (type-only, erased at
// runtime) so the compiler checks its mapping against the real context.

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

/**
 * The delivery guard's skip, as a typed rejection. The guard wraps
 * promptSession (src/runtime.ts) and every wake path funnels through it.
 * Callers treat a rejection as "nothing was sent": the chat delivery loop
 * keeps the mail pending and logs loudly, the watcher registry counts the
 * throw toward its (404-gated) death scan, and fire-and-forget sites catch
 * and log. A silent-success skip instead stamped chat mail delivered with
 * no prompt ever sent - the wake-accepted-but-never-executed zombie
 * (issue #25). Lives here (not runtime.ts) because chat.ts needs the class
 * and runtime.ts imports chat.ts.
 */
export class DeliverySkippedError extends Error {
  constructor(sessionID: string, directory: string) {
    super(`wake to ${sessionID} skipped: directory ${directory} no longer exists`);
    this.name = "DeliverySkippedError";
  }
}

export interface HostCapabilities {
  /**
   * Create a session. Returns its id. The host's create API has no
   * parentID, so an extraction child is a top-level session in the
   * parent's project directory and only the title carries over; the
   * runtime records the parent link in its own maps.
   */
  sessionCreate(input: { title: string }): Promise<{ id: string }>;
  /**
   * Delete a session (extraction-child cleanup, so the picker stays clean
   * and `-c` resume does not land in a child). session.remove on the
   * promise domain (upstream #52387).
   */
  sessionDelete(id: string): Promise<void>;
  /**
   * Prompt a session with text parts. The host enqueues the message and
   * returns while the model turn runs asynchronously, so callers own
   * fire-and-forget vs await. May reject; the delivery guard wraps this.
   */
  promptSession(
    sessionID: string,
    body: { parts: PromptPart[]; noReply?: boolean },
  ): Promise<void>;
  /**
   * Fetch one session's info (title, location). Null when the host rejects.
   * The metadata bag rides along (the spawn stamp
   * `thatch.coordinatorSessionID` lives there).
   *
   * `time.updated` (epoch ms; the wake-swallow detector also accepts an ISO
   * string) is the session's last turn activity: the detector compares it
   * against a wake stamp to decide whether the wake actually produced a
   * turn.
   */
  sessionGet(id: string): Promise<{
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { updated?: number | string };
  } | null>;
  /**
   * List sessions in this directory (directory-scoped, matching the `-c`
   * continue-target resolution's needs). Null when the host rejects.
   */
  sessionList(): Promise<{ id: string; parentID?: string; time?: { updated?: number } }[] | null>;
  /**
   * Enumerate every session the host knows (id, title, directory, parent
   * link, project link) plus each project's canonical checkout directory,
   * for the runtime's stranded-session sweep. Reads opencode.db readonly
   * (the promise domain's session list is directory-scoped and the sweep
   * needs machine-wide rows, not per-directory ones). Null when the read
   * fails - the sweep treats null as "nothing known, do nothing".
   */
  enumerateSessions(): Promise<{
    sessions: { id: string; title: string; directory: string; parentId: string | null; projectId: string | null }[];
    canonicalByProject: Record<string, string>;
  } | null>;
  /**
   * Move a session to another directory. The strand sweep's self-heal for
   * real sessions stranded in a deleted worktree (deletion is reserved for
   * machinery sessions); moving is exactly what opencode's own
   * "session location unavailable" recovery dialog does, minus the
   * directory picking.
   */
  sessionMove(id: string, directory: string): Promise<void>;
  /**
   * Fetch a session's message list (alert round classification). Null when
   * unavailable. Read via session.context, mapped into this shape. Parts
   * carry the fields the round classifier needs: tool parts name their
   * tool, text parts carry the synthetic flag, and info.error holds the
   * message-level error name (abort / stall detection).
   */
  sessionMessages(
    id: string,
  ): Promise<
    { info: { role: string; error?: string }; parts?: { type: string; text?: string; tool?: string; synthetic?: boolean }[] }[]
    | null
  >;
  /** TUI toast. The runtime's call sites catch-and-ignore; the adapter just delivers. */
  showToast(toast: ToastInput): Promise<void>;
  /**
   * Trigger the host's compaction for a session (the wrap-up compact
   * action): session.compact on the promise domain (upstream #52385), the
   * same core compaction the built-in /compact runs.
   */
  compactSession(sessionID: string): Promise<void>;
  /**
   * End the session's presence on the host (the wrap-up exit action). The
   * runtime records the session's watcher deaths and unregisters it from
   * chat BEFORE calling here, so implementations only close out the host
   * side: the session-tab bridge's exit-tab-closed event, a TUI-only close
   * of the session's OWN tab (the daemon hosts every tab, so an app-wide
   * exit would take down unrelated sessions too); a host with no bridge
   * degrades to a logged no-op.
   */
  exitHost(sessionID: string): Promise<void>;
}
