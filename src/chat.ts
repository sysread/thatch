import type { Database } from "bun:sqlite";
import { CHAT_NAME_POOL } from "./chat-names";

/**
 * Cross-session chat: opt-in messaging between live opencode sessions on one
 * machine, routed through the shared thatch.db.
 *
 * The design splits cleanly into two halves. ChatStore is the shared state:
 * the session directory and the message inbox live in SQLite so any opencode
 * process on the machine can read and write them. ChatPoller is the local
 * delivery: each process polls the inbox for messages addressed to sessions
 * it hosts and wake-prompts them through its own SDK client. A sender never
 * prompts a session in another process - only the recipient's host delivers.
 * This keeps the watcher registry's core property (no process prompts a
 * session it does not host) while crossing process boundaries, so there is
 * exactly one possible deliverer per message and no double-delivery race.
 *
 * Liveness is heartbeat-based. A crashed process fires no session.deleted
 * event, so the only reliable offline signal is a stale last_seen value: each
 * host process refreshes last_seen for its registered sessions on every poll
 * cycle, and chat_list marks anything older than the staleness threshold as
 * stale instead of hiding it.
 *
 * Loop control has a soft and a hard brake. The prompt guidance tells agents
 * not to auto-reply reflexively (two polite agents acknowledging each other
 * forever is an infinite wake cycle); the poller's per-recipient nudge cap
 * stops it mechanically regardless of what the models decide to do.
 */

/** ISO-8601 UTC timestamp with second resolution, matching the house
 *  strftime('%Y-%m-%dT%H:%M:%SZ','now') default so string comparison between
 *  SQLite-generated and JS-generated timestamps stays consistent. */
export function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}

export interface ChatSessionRow {
  session_id: string;
  name: string;
  project: string | null;
  registered_at: string;
  last_seen: string;
}

/** One message selected for wake-up delivery, with the sender's display name
 *  resolved for the nudge text. */
export interface ChatNotificationRow {
  id: number;
  to_session: string;
  from_session: string;
  from_name: string | null;
  created_at: string;
}

/** A message as returned to the reading agent. */
export interface ChatInboxItem {
  id: number;
  from_session: string;
  from_name: string | null;
  body: string;
  created_at: string;
}

export type ChatResult = { ok: true } | { ok: false; error: string };

// Display names appear inside wake prompts and chat_list output, so they are
// capped tight. Bodies are capped so a runaway sender cannot turn a nudge
// into a context bomb; the reader fetches full content via chat_read anyway.
const MAX_NAME_LEN = 40;
const MAX_BODY_LEN = 10_000;

// Timing defaults, shared by the poller and the chat_list staleness display
// so both agree on what "stale" means.
export const CHAT_POLL_INTERVAL_MS = 30_000;
export const CHAT_STALE_MINUTES = 10;
export const CHAT_RENUDGE_MINUTES = 15;
export const CHAT_MAX_NUDGES_PER_HOUR = 6;

/**
 * SQLite CRUD for the chat tables. Constructed by ThatchDB with the shared
 * Database handle; the tables are created by ThatchDB's schema init.
 */
export class ChatStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Joins the directory with a pool name: picks uniformly at random from the
   * names no other session has claimed (case-insensitively). Idempotent for
   * an already-registered session - it keeps its current name. Fails only
   * when every pool name is taken.
   */
  assign(sessionID: string, project: string | null): { ok: true; name: string } | { ok: false; error: string } {
    const existing = this.#find(sessionID);
    if (existing) return { ok: true, name: existing.name };
    const taken = new Set(this.list().map((r) => r.name.toLowerCase()));
    const free = CHAT_NAME_POOL.filter((n) => !taken.has(n.toLowerCase()));
    if (free.length === 0) {
      return { ok: false, error: "Name pool exhausted - pass a custom name." };
    }
    const name = free[Math.floor(Math.random() * free.length)];
    this.#db.run(
      "INSERT INTO chat_sessions (session_id, name, project, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)",
      [sessionID, name, project, nowIso(), nowIso()],
    );
    return { ok: true, name };
  }

  /**
   * Joins the directory, or refreshes an existing registration. Re-registering
   * with the same session ID renames the session; the new name must not be
   * claimed by a different session. Uniqueness is case-insensitive ("Landru"
   * and "landru" are the same name), so lookups and claims agree no matter
   * what casing the model or user types. Both paths stamp last_seen.
   */
  register(sessionID: string, rawName: string, project: string | null): ChatResult {
    const name = rawName.trim();
    if (!name) return { ok: false, error: "Name cannot be empty." };
    if (name.length > MAX_NAME_LEN) {
      return { ok: false, error: `Name too long (max ${MAX_NAME_LEN} characters).` };
    }
    const existing = this.#find(sessionID);
    if (existing) {
      if (existing.name === name) {
        this.#touch(sessionID);
        return { ok: true };
      }
      if (this.#findByName(name)) {
        return { ok: false, error: `Name "${name}" is taken by another session.` };
      }
      this.#db.run("UPDATE chat_sessions SET name = ?, last_seen = ? WHERE session_id = ?", [
        name,
        nowIso(),
        sessionID,
      ]);
      return { ok: true };
    }
    if (this.#findByName(name)) {
      return { ok: false, error: `Name "${name}" is taken by another session.` };
    }
    this.#db.run(
      "INSERT INTO chat_sessions (session_id, name, project, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)",
      [sessionID, name, project, nowIso(), nowIso()],
    );
    return { ok: true };
  }

  /** Leaves the directory. Messages already sent to or from the session are
   *  kept as history; departed senders show as unknown names to readers. */
  unregister(sessionID: string): boolean {
    const existing = this.#find(sessionID);
    if (!existing) return false;
    this.#db.run("DELETE FROM chat_sessions WHERE session_id = ?", [sessionID]);
    return true;
  }

  list(): ChatSessionRow[] {
    return (this.#db
      .query("SELECT session_id, name, project, registered_at, last_seen FROM chat_sessions ORDER BY name")
      .all() as any[]).map(rowFromSession);
  }

  /** Resolves a recipient by display name (case-insensitive) or session ID. */
  find(nameOrID: string): ChatSessionRow | null {
    return this.#findByName(nameOrID) ?? this.#find(nameOrID);
  }

  /**
   * Posts a message. Both endpoints must be registered; a session cannot
   * message itself (the inbox drain and the reply would be the same turn).
   */
  send(fromSession: string, toNameOrID: string, body: string): { ok: true; id: number } | { ok: false; error: string } {
    const trimmed = body.trim();
    if (!trimmed) return { ok: false, error: "Message body cannot be empty." };
    if (trimmed.length > MAX_BODY_LEN) {
      return { ok: false, error: `Message too long (max ${MAX_BODY_LEN} characters).` };
    }
    const sender = this.#find(fromSession);
    if (!sender) return { ok: false, error: "You are not registered - call chat_register first." };
    const recipient = this.find(toNameOrID);
    if (!recipient) {
      return { ok: false, error: `No registered session named "${toNameOrID}". Use chat_list to see who is available.` };
    }
    if (recipient.session_id === fromSession) {
      return { ok: false, error: "You cannot message yourself." };
    }
    this.#db.run(
      "INSERT INTO chat_messages (from_session, to_session, body, created_at) VALUES (?, ?, ?, ?)",
      [fromSession, recipient.session_id, trimmed, nowIso()],
    );
    const row = this.#db.query("SELECT last_insert_rowid() AS id").get() as any;
    return { ok: true, id: row.id };
  }

  /**
   * Drains the calling session's inbox: returns unread messages oldest-first
   * and stamps them read. An empty inbox returns an empty array.
   */
  read(sessionID: string): ChatInboxItem[] {
    const rows = this.#db
      .query(
        `SELECT m.id, m.from_session, s.name AS from_name, m.body, m.created_at
         FROM chat_messages m
         LEFT JOIN chat_sessions s ON s.session_id = m.from_session
         WHERE m.to_session = ? AND m.read_at IS NULL
         ORDER BY m.id`,
      )
      .all(sessionID) as any[];
    if (rows.length === 0) return [];
    this.#db.run("UPDATE chat_messages SET read_at = ? WHERE to_session = ? AND read_at IS NULL", [
      nowIso(),
      sessionID,
    ]);
    return rows.map((r) => ({
      id: r.id,
      from_session: r.from_session,
      from_name: r.from_name ?? null,
      body: r.body,
      created_at: r.created_at,
    }));
  }

  /** Unread message count for a session, for chat_list's self row. */
  unreadCount(sessionID: string): number {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM chat_messages WHERE to_session = ? AND read_at IS NULL")
      .get(sessionID) as any;
    return row.n;
  }

  /** Refreshes last_seen for the given sessions. Sessions that never
   *  registered are absent from chat_sessions, so the UPDATE is a no-op for
   *  them - no filtering needed on the caller's side. */
  heartbeat(sessionIDs: string[]): void {
    if (sessionIDs.length === 0) return;
    const marks = sessionIDs.map(() => "?").join(",");
    this.#db.run(`UPDATE chat_sessions SET last_seen = ? WHERE session_id IN (${marks})`, [
      nowIso(),
      ...sessionIDs,
    ]);
  }

  /**
   * Messages that need a wake prompt for the given sessions: unread and
   * either never delivered, or delivered so long ago that a re-nudge is due.
   * The cutoff is passed by the poller (its renudge window, as an ISO
   * timestamp); delivered_at comparison is string comparison, which works
   * because every timestamp in these tables uses the same second-resolution
   * format.
   */
  pendingNotifications(sessionIDs: string[], renudgeCutoff: string): ChatNotificationRow[] {
    if (sessionIDs.length === 0) return [];
    const marks = sessionIDs.map(() => "?").join(",");
    return (
      this.#db
        .query(
          `SELECT m.id, m.to_session, m.from_session, s.name AS from_name, m.created_at
           FROM chat_messages m
           LEFT JOIN chat_sessions s ON s.session_id = m.from_session
           WHERE m.read_at IS NULL
             AND m.to_session IN (${marks})
             AND (m.delivered_at IS NULL OR m.delivered_at <= ?)
           ORDER BY m.id`,
        )
        .all(...sessionIDs, renudgeCutoff) as any[]
    ).map((r) => ({
      id: r.id,
      to_session: r.to_session,
      from_session: r.from_session,
      from_name: r.from_name ?? null,
      created_at: r.created_at,
    }));
  }

  /** Stamps delivered_at on the given messages. Called after a wake prompt
   *  was accepted; re-stamping on later nudges resets the re-nudge timer. */
  markDelivered(ids: number[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(",");
    this.#db.run(`UPDATE chat_messages SET delivered_at = ? WHERE id IN (${marks})`, [nowIso(), ...ids]);
  }

  #find(sessionID: string): ChatSessionRow | null {
    const row = this.#db
      .query("SELECT session_id, name, project, registered_at, last_seen FROM chat_sessions WHERE session_id = ?")
      .get(sessionID) as any;
    return row ? rowFromSession(row) : null;
  }

  #findByName(name: string): ChatSessionRow | null {
    const row = this.#db
      .query("SELECT session_id, name, project, registered_at, last_seen FROM chat_sessions WHERE name = ? COLLATE NOCASE")
      .get(name) as any;
    return row ? rowFromSession(row) : null;
  }

  #touch(sessionID: string): void {
    this.#db.run("UPDATE chat_sessions SET last_seen = ? WHERE session_id = ?", [nowIso(), sessionID]);
  }
}

function rowFromSession(r: any): ChatSessionRow {
  return {
    session_id: r.session_id,
    name: r.name,
    project: r.project ?? null,
    registered_at: r.registered_at,
    last_seen: r.last_seen,
  };
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

/** The poller's narrow view of the store. ThatchDB satisfies this structurally
 *  through its delegated chat methods, so the poller never needs the full
 *  ChatStore and tests can pass a plain object. */
export interface ChatPollerStore {
  heartbeatChatSessions(sessionIDs: string[]): void;
  pendingChatNotifications(sessionIDs: string[], renudgeCutoff: string): ChatNotificationRow[];
  markChatDelivered(ids: number[]): void;
}

export interface ChatPollerOptions {
  store: ChatPollerStore;
  /** Session IDs this process has seen events for. Only sessions hosted by
   *  this process can be delivered to - the recipient's host is the single
   *  deliverer, by design. */
  hostedSessions: () => string[];
  /** Delivers a wake prompt for a recipient. Injected so tests never spawn. */
  deliver: (sessionID: string, senders: string[], count: number) => Promise<void>;
  /** Gate for delivery: true only when the session can accept a proactive
   *  prompt right now (idle, not compacting). Undeliverable messages stay
   *  pending and retry on later cycles. */
  canDeliver: (sessionID: string) => boolean;
  /** Poll interval. Default 30s - frequent enough that wake prompts feel
   *  prompt, cheap enough that the shared DB sees one light query per cycle
   *  per process. */
  pollIntervalMs?: number;
  /** A delivered-but-unread message re-queues a nudge after this long.
   *  Default 15 minutes. */
  renudgeMinutes?: number;
  /** Hard brake on wake cycles: maximum wake prompts per recipient per hour.
   *  Default 6. In-memory on purpose - it is a loop guard, not accounting. */
  maxNudgesPerHour?: number;
}

/**
 * Background poller: heartbeats hosted sessions, delivers wake prompts for
 * pending chat messages. Mirrors the watcher registry's shape (start/stop/
 * dispose, re-entrant guards, pending-retry semantics) but its pending state
 * lives in SQLite rather than memory, because the sender may be a different
 * process than the deliverer.
 */
export class ChatPoller {
  #opts: Required<ChatPollerOptions>;
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #delivering = false;
  /** Per-recipient wake-prompt timestamps inside the last hour. */
  #nudges = new Map<string, number[]>();

  constructor(opts: ChatPollerOptions) {
    this.#opts = {
      pollIntervalMs: CHAT_POLL_INTERVAL_MS,
      renudgeMinutes: CHAT_RENUDGE_MINUTES,
      maxNudgesPerHour: CHAT_MAX_NUDGES_PER_HOUR,
      ...opts,
    };
  }

  /** True while the poller timer is armed. */
  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.poll(), this.#opts.pollIntervalMs);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Stops polling and drops the nudge counters. The inbox itself is shared
   *  SQLite state and outlives this process by design. */
  dispose(): void {
    this.stop();
    this.#nudges.clear();
  }

  /**
   * One poll cycle: heartbeat hosted sessions, then deliver whatever is
   * pending for sessions that can accept a prompt. Re-entrant calls are
   * dropped, matching the watcher registry - a slow cycle overlapping the
   * next would double-deliver the same messages.
   */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const hosted = this.#opts.hostedSessions();
      this.#opts.store.heartbeatChatSessions(hosted);
      await this.deliverPending();
    } finally {
      this.#polling = false;
    }
  }

  /**
   * Delivers pending messages for every hosted session that can accept a
   * prompt. Sessions that are busy keep their messages pending; the idle
   * event handler calls this directly so mail lands promptly instead of
   * waiting for the next cycle. Failures stay pending and retry.
   */
  async deliverPending(): Promise<void> {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      const hosted = this.#opts.hostedSessions();
      const cutoff = new Date(Date.now() - this.#opts.renudgeMinutes * 60_000)
        .toISOString()
        .slice(0, 19) + "Z";
      const pending = this.#opts.store.pendingChatNotifications(hosted, cutoff);
      if (pending.length === 0) return;

      const byRecipient = new Map<string, ChatNotificationRow[]>();
      for (const msg of pending) {
        const queue = byRecipient.get(msg.to_session) ?? [];
        queue.push(msg);
        byRecipient.set(msg.to_session, queue);
      }

      for (const [recipient, messages] of byRecipient) {
        if (!this.#opts.canDeliver(recipient)) continue;
        if (this.#nudgeBudget(recipient) <= 0) continue;
        try {
          const senders = [...new Set(messages.map((m) => m.from_name ?? m.from_session))];
          await this.#opts.deliver(recipient, senders, messages.length);
          this.#opts.store.markChatDelivered(messages.map((m) => m.id));
          this.#recordNudge(recipient);
        } catch (err) {
          console.error(`[thatch] chat delivery to ${recipient} failed: ${err}`);
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  /** Remaining wake prompts for this recipient in the current hour. */
  #nudgeBudget(recipient: string): number {
    const now = Date.now();
    const window = this.#nudges.get(recipient) ?? [];
    const fresh = window.filter((t) => now - t < 3_600_000);
    this.#nudges.set(recipient, fresh);
    return this.#opts.maxNudgesPerHour - fresh.length;
  }

  #recordNudge(recipient: string): void {
    const window = this.#nudges.get(recipient) ?? [];
    window.push(Date.now());
    this.#nudges.set(recipient, window);
  }
}

/** True when a session row's last_seen is older than the staleness
 *  threshold. Used by chat_list to mark ghosts. */
export function isStale(row: ChatSessionRow, staleMinutes: number, now = Date.now()): boolean {
  return now - Date.parse(row.last_seen) > staleMinutes * 60_000;
}
