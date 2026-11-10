/**
 * Hook plumbing shared by the hook-facing subcommands (reminder,
 * flush-tools, buffer-*, chat-notify): stdin reads that never hang,
 * payload debug-logging, the chat-mail hook line, and the nudge emit
 * wrapper. Created per process with the DB path, because both the debug
 * log and the chat config hang off it.
 */
import { detectRepo } from "../git";
import { repoPathCache } from "../db";
import { createDebugLog } from "../debug";
import { chatEnabled, loadConfig } from "../config";
import { mcpSessionID, resolveRegisteredPredecessor } from "../chat";
import type { ThatchDB } from "../db";

export function createHookHelpers(dbPath: string) {
  const hookDebug = createDebugLog(dbPath);

  /**
   * Debug-logs one hook invocation's raw stdin payload (tag hook:<command>,
   * payload truncated). Answers "did the host fire the hook at all, and what
   * did it send?" - the chat DB cannot distinguish a hook that never fired
   * from one whose payload carried no session id, and host hook contracts
   * are sometimes documented wrong.
   */
  function logHookPayload(command: string, raw: string): void {
    const clipped = raw.length > 2000 ? `${raw.slice(0, 2000)}...` : raw;
    hookDebug(`hook:${command}`, `stdin: ${JSON.stringify(clipped)}`);
  }

  /**
   * Reads the hook's stdin JSON without hanging when no payload is coming.
   * Interactive runs skip the read outright (isTTY); a piped or inherited
   * stdin that never closes (bare spawns) gives up after a short grace
   * period and destroys the stream, because a pending stdin read keeps
   * the process alive after main finishes. Hook hosts write the payload
   * immediately at spawn, so the grace window costs nothing on the hot path.
   * Malformed payloads resolve to undefined rather than failing the command.
   * Uses the Node stream API instead of Bun.stdin.text(): a pending
   * Bun.stdin read cannot be cancelled and pins the process forever.
   */
  function readHookInput(tag: string): Promise<Record<string, unknown> | undefined> {
    if (process.stdin.isTTY) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => done(undefined), 500);
      const done = (value: string | undefined) => {
        clearTimeout(timer);
        process.stdin.destroy();
        try {
          if (!value) return resolve(undefined);
          logHookPayload(tag, value);
          resolve(JSON.parse(value) as Record<string, unknown>);
        } catch {
          resolve(undefined);
        }
      };
      process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on("end", () => done(Buffer.concat(chunks).toString()));
      process.stdin.on("error", () => done(undefined));
    });
  }

  /**
   * Builds the chat-mail hook line for the given project. With a hook
   * session ID (Claude Code/Cursor pass one in the hook's stdin JSON), it
   * first ensures the caller is registered - the host's assigned identity -
   * and prints that identity plus the caller's own unread count, so the
   * model learns who it is on every prompt without a tool call. Without a
   * session ID it keeps the old shape: a line only when pending mail exists
   * for registered sessions in the project, naming the addressees.
   */
  async function chatHookLine(db: ThatchDB, hookSessionID?: string, transcriptPath?: string): Promise<string> {
    // Disabled chat prints nothing: the hook line must not advertise a
    // feature the user turned off (the tools refuse, the poller never
    // starts, the prompt section omits chat).
    if (!chatEnabled(loadConfig(dbPath).config)) return "";
    let repo: string | null = null;
    try {
      const detected = await detectRepo(undefined, repoPathCache(db));
      // unknown-to-global: chat registration must follow the same store the
      // tools would read, even when the project directory is gone.
      repo = detected === "unknown" ? "global" : detected;
    } catch {
      return "";
    }

    if (hookSessionID) {
      // Ensure-register: idempotent, so every prompt re-touches liveness and
      // the first prompt of a conversation mints the assigned name. This is
      // the MCP identity anchor - the session ID is stable per conversation,
      // so re-registering finds the same row and name.
      const sessionID = mcpSessionID(hookSessionID);
      // Continuation adoption: Claude Code forks the session id on resume
      // (and has been observed to fork spontaneously), stranding the old
      // identity and mailbox. When this session is unknown, look for a
      // predecessor transcript handing off to it; adopting keeps the name
      // and mail following the human-level conversation. Runs before the
      // ensure so the migrated row is the one re-registered.
      if (!db.findChatSession(sessionID) && transcriptPath) {
        try {
          const pred = resolveRegisteredPredecessor(transcriptPath, hookSessionID, (raw) =>
            db.findChatSession(mcpSessionID(raw))?.session_id ?? null,
          );
          if (pred) {
            db.continueChatSession(pred, sessionID);
            hookDebug("hook:adoption", `continued chat identity: ${pred} -> ${sessionID}`);
          }
        } catch (err) {
          console.error(`[thatch] chat continuation adoption failed: ${err}`);
        }
      }
      // The leave tombstone blocks this ensure: chat_unregister must outlive
      // the turn that issued it, on MCP hosts as on opencode. The line is
      // the standing signal - it repeats every prompt until the model
      // rejoins, and it says plainly that rejoining mints a fresh identity,
      // because the old one is closed for good (assigned names are never
      // reused, so a tombstoned identity cannot be resurrected by a later
      // register).
      if (db.hasChatLeaveTombstone(sessionID) && !db.chatLeaveSuperseded(sessionID, repo)) {
        return `[thatch] chat: this conversation left the chat directory (chat_unregister) and will not receive mail. If the user asks to rejoin, call thatch_chat_register with no arguments - that mints a fresh identity; the old one stays closed.`;
      }
      db.registerChatSession(sessionID, repo, null, "mcp");
      const me = db.findChatSession(sessionID);
      if (!me) return "";
      const mine = db.unreadChatCount(sessionID);
      const pendingOthers = db
        .chatPendingByProject(repo)
        .filter((p) => p.name !== me.name);
      const others = pendingOthers.length > 0
        ? ` Others in this project with unread mail: ${pendingOthers.map((p) => `${p.name} (${p.pending})`).join(", ")}.`
        : "";
      const mailbox = mine > 0 ? `${mine} unread message(s) for you` : "no unread mail for you";
      return `[thatch] chat: you are ${me.name} (${mailbox}).${others}`;
    }

    const pending = db.chatPendingByProject(repo);
    if (pending.length === 0) return "";
    const parts = pending.map((p) => `${p.name} (${p.pending})`);
    return `[thatch] chat: unread message(s) for ${parts.join(", ")} - the addressee should call chat_read`;
  }

  /**
   * Emits the nudge output, prepending a version warning if present. The
   * warning goes first so the LLM sees it before the nudge text. Used by
   * flush-tools to surface version skew and update-available notices on
   * every UserPromptSubmit, regardless of which tier fired. The chat hook
   * line, when present, is appended last (the identity/mail check is the
   * last thing the model reads before the nudge body).
   */
  function emit(output: string, versionWarning: string | null, isJson: boolean, chatLine = ""): void {
    if (chatLine) {
      output = `${output}\n\n${chatLine}`;
    }
    if (versionWarning) {
      output = `[thatch] ${versionWarning}\n\n${output}`;
    }
    if (isJson) console.log(JSON.stringify({ additional_context: output }));
    else console.log(output);
  }

  return { hookDebug, logHookPayload, readHookInput, chatHookLine, emit };
}

export type HookHelpers = ReturnType<typeof createHookHelpers>;
