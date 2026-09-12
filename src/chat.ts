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
 * This crosses process boundaries while preserving the watcher rationale's core
 * property: no process ever prompts a session it does not host, so there is
 * exactly one possible deliverer per message and no cross-process double
 * delivery. Within a host process, delivery is at-least-once: a crash between
 * the wake prompt and its delivered_at stamp re-nudges the same mail after
 * restart, which is the safe direction for prompts that only point at the
 * inbox.
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
  return isoMinutesAgo(0);
}

/** An ISO timestamp `minutes` in the past, in the same second-resolution
 *  format. The poller passes this shape as the re-nudge cutoff; tests use
 *  it for the same purpose, so the format expression lives in exactly one
 *  place. */
export function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 19) + "Z";
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

// Custom names share the pool's charset: letters, numbers, spaces,
// apostrophes, hyphens, periods. Parens would truncate the transcript
// echo's name parse; newlines or tabs would break chat_list's one-line
// roster format. Exported so the pool conformance test can pin that every
// baked-in name satisfies it.
export const NAME_CHARSET = /^[\p{L}\p{N} '.\-]+$/u;

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
   * an already-registered session - it keeps its current name (drawn:
   * false). Fails when every pool name is taken, or when concurrent
   * registrations win every draw attempt - see the redraw loop below.
   */
  assign(sessionID: string, project: string | null): { ok: true; name: string; drawn: boolean } | { ok: false; error: string } {
    const existing = this.#find(sessionID);
    if (existing) {
      this.#touch(sessionID);
      return { ok: true, name: existing.name, drawn: false };
    }
    // Two processes can snapshot the same free list and draw the same name;
    // the loser's INSERT hits the constraint. Redrawing from the names
    // still free (the taken set is re-read each attempt) keeps the pool
    // path's cannot-collide promise even under concurrent registration.
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = new Set(this.list().map((r) => r.name.toLowerCase()));
      const free = CHAT_NAME_POOL.filter((n) => !taken.has(n.toLowerCase()));
      if (free.length === 0) {
        return { ok: false, error: "Name pool exhausted - pass a custom name." };
      }
      const name = free[Math.floor(Math.random() * free.length)];
      const claimed = this.#insertSession(sessionID, name, project);
      if (claimed.ok) return { ok: true, name, drawn: true };
    }
    return { ok: false, error: "Could not claim a pool name after several attempts - pass a custom name." };
  }

  /**
   * Joins the directory, or refreshes an existing registration. Re-registering
   * with the same session ID renames the session (including changing only
   * the casing of its own name); the new name must not be claimed by a
   * different session. Uniqueness is case-insensitive ("Landru" and "landru"
   * are the same name), so lookups and claims agree no matter what casing the
   * model or user types. Both paths stamp last_seen.
   */
  register(sessionID: string, rawName: string, project: string | null): ChatResult {
    const name = rawName.trim();
    const invalid = this.#invalidName(name);
    if (invalid) return { ok: false, error: invalid };
    const existing = this.#find(sessionID);
    if (existing) {
      if (existing.name === name) {
        this.#touch(sessionID);
        return { ok: true };
      }
      // A NOCASE hit is only a collision when it belongs to a different
      // session - otherwise this is the caller recasing its own name.
      const clash = this.#findByName(name);
      if (clash && clash.session_id !== sessionID) {
        return this.#nameTaken(name);
      }
      try {
        this.#db.run("UPDATE chat_sessions SET name = ?, last_seen = ? WHERE session_id = ?", [
          name,
          nowIso(),
          sessionID,
        ]);
        return { ok: true };
      } catch (err) {
        if (this.#isConstraintError(err)) {
          return this.#nameTaken(name);
        }
        throw err;
      }
    }
    if (this.#findByName(name)) {
      return this.#nameTaken(name);
    }
    return this.#insertSession(sessionID, name, project);
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

  /** Resolves a recipient by display name (case-insensitive) or session ID.
   *  Name-first is safe only because opencode session IDs contain
   *  underscores and NAME_CHARSET excludes them, so no legal display name
   *  can shadow an ID; if either format ever changes, resolve IDs first. */
  find(nameOrID: string): ChatSessionRow | null {
    return this.#findByName(nameOrID) ?? this.#find(nameOrID);
  }

  /**
   * Posts a message. Both endpoints must be registered; a session cannot
   * message itself (nothing is coordinated: the message would sit unread
   * until the sender drains its own inbox, and the wake prompt would be the
   * sender nudging itself). Returns the resolved recipient so callers never
   * need a second lookup - a re-lookup could race a concurrent unregister
   * and fail after the message already landed.
   */
  send(
    fromSession: string,
    toNameOrID: string,
    body: string,
  ): { ok: true; id: number; recipient: { session_id: string; name: string } } | { ok: false; error: string } {
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
    return { ok: true, id: row.id, recipient: { session_id: recipient.session_id, name: recipient.name } };
  }

  /**
   * Drains the calling session's inbox: returns unread messages oldest-first
   * and stamps exactly those rows read. The stamp is scoped to the selected
   * ids, not re-derived - a message arriving from another process between
   * the SELECT and the UPDATE must stay unread so the poller re-nudges it;
   * an unscoped stamp would swallow it silently.
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
    const marks = rows.map(() => "?").join(",");
    this.#db.run(`UPDATE chat_messages SET read_at = ? WHERE id IN (${marks})`, [
      nowIso(),
      ...rows.map((r) => r.id),
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
   * Only registered recipients are selected - unregistering must stop wake
   * prompts for kept-but-unread mail, which is exactly what the
   * chat_unregister tool promises. The cutoff is passed by the poller (its
   * renudge window, as an ISO timestamp); delivered_at comparison is string
   * comparison, which works because every timestamp in these tables uses
   * the same second-resolution format.
   */
  pendingNotifications(sessionIDs: string[], renudgeCutoff: string): ChatNotificationRow[] {
    if (sessionIDs.length === 0) return [];
    const marks = sessionIDs.map(() => "?").join(",");
    return (
      this.#db
        .query(
          `SELECT m.id, m.to_session, m.from_session, s.name AS from_name
           FROM chat_messages m
           LEFT JOIN chat_sessions s ON s.session_id = m.from_session
           WHERE m.read_at IS NULL
             AND m.to_session IN (${marks})
             AND (m.delivered_at IS NULL OR m.delivered_at <= ?)
             AND EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.session_id = m.to_session)
           ORDER BY m.id`,
        )
        .all(...sessionIDs, renudgeCutoff) as any[]
    ).map((r) => ({
      id: r.id,
      to_session: r.to_session,
      from_session: r.from_session,
      from_name: r.from_name ?? null,
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

  #invalidName(name: string): string | null {
    if (!name) return "Name cannot be empty.";
    if (name.length > MAX_NAME_LEN) return `Name too long (max ${MAX_NAME_LEN} characters).`;
    if (!NAME_CHARSET.test(name)) {
      return "Names may contain letters, numbers, spaces, apostrophes, hyphens, and periods.";
    }
    return null;
  }

  /**
   * INSERTs a directory row, translating a UNIQUE-constraint violation into
   * the friendly taken message. The pre-checks are advisory only against
   * other processes: two sessions claiming one free name in the same
   * instant both pass the check, and the loser's INSERT must not escape the
   * { ok, error } contract as a raw SQLite error. Same pattern as
   * remember()'s slug-collision handling in db.ts.
   */
  #insertSession(sessionID: string, name: string, project: string | null): ChatResult {
    try {
      this.#db.run(
        "INSERT INTO chat_sessions (session_id, name, project, registered_at, last_seen) VALUES (?, ?, ?, ?, ?)",
        [sessionID, name, project, nowIso(), nowIso()],
      );
      return { ok: true };
    } catch (err) {
      if (this.#isConstraintError(err)) {
        return this.#nameTaken(name);
      }
      throw err;
    }
  }

  #isConstraintError(err: unknown): boolean {
    return String((err as any)?.code ?? err).includes("CONSTRAINT");
  }

  /** The one taken-message every claim path returns, so a rewording cannot
   *  drift between the pre-checks and the race catches. */
  #nameTaken(name: string): ChatResult {
    return { ok: false, error: `Name "${name}" is taken by another session.` };
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

/** The poller's narrow view of the store: the three chat methods it needs.
 *  ThatchDB satisfies this structurally through its delegated chat methods.
 *  The interface pins the poller to exactly these dependencies and removes
 *  chat.ts's need to import db.ts at all - db.ts already value-imports
 *  ChatStore, so a reverse import would form a runtime module cycle. A
 *  test that wants a fake store can pass a plain object, though the suite
 *  currently uses real temp-dir databases. */
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
   *  prompt, cheap enough that the shared DB sees only a couple of light
   *  statements per cycle per process. */
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
    // Never keep the host process alive just for the poller - matches the
    // watcher registry's timer.
    this.#timer.unref?.();
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
   * next would double-deliver the same messages. Store failures are caught
   * here, not just deliver failures: the timer discards the returned
   * promise, so an escaping SQLite error would surface as an unhandled
   * rejection in the plugin host process. A failed cycle logs and retries
   * on the next tick.
   */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const hosted = this.#opts.hostedSessions();
      this.#opts.store.heartbeatChatSessions(hosted);
      await this.deliverPending();
    } catch (err) {
      console.error(`[thatch] chat poll failed: ${err}`);
    } finally {
      this.#polling = false;
    }
  }

  /**
   * Delivers pending messages for every hosted session that can accept a
   * prompt. Sessions that are busy keep their messages pending; the idle
   * event handler calls this directly so mail lands promptly instead of
   * waiting for the next cycle. Failures stay pending and retry. Delivery
   * is at-least-once: a crash after the wake prompt but before
   * markChatDelivered re-nudges the same batch on the next cycle.
   */
  async deliverPending(): Promise<void> {
    if (this.#delivering) return;
    this.#delivering = true;
    try {
      const hosted = this.#opts.hostedSessions();
      const cutoff = isoMinutesAgo(this.#opts.renudgeMinutes);
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
          // "unknown (id, departed)" matches chat_read's rendering of a
          // sender whose directory row is gone, so both surfaces use one
          // convention for the same condition.
          const senders = [...new Set(messages.map((m) => m.from_name ?? `unknown (${m.from_session.slice(0, 12)}, departed)`))];
          await this.#opts.deliver(recipient, senders, messages.length);
          // Count the nudge before the stamp: the cap must bind on prompts
          // actually sent, not on the DB write succeeding. A failing stamp
          // leaves the mail pending, and an uncounted re-delivery every
          // cycle would be the ping-pong the cap exists to stop.
          this.#recordNudge(recipient);
          this.#opts.store.markChatDelivered(messages.map((m) => m.id));
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
