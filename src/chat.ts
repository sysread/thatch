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
  topic: string | null;
  project: string | null;
  /** Which harness hosts this session: "opencode" (poller-driven) or "mcp"
   *  (turn-driven). Determines how staleness is interpreted and whether
   *  wake delivery is possible. */
  host_kind: ChatHostKind;
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

export type ChatResult = { ok: true; topic: string | null } | { ok: false; error: string };

/**
 * Derives the synthetic session ID for an MCP-host chat registration: a
 * pure function of the claimed name, so identity survives the ephemeral
 * sessions those hosts run (a later conversation claiming the same name
 * finds the same row). The underscore keeps the ID outside NAME_CHARSET,
 * preserving the name-cannot-shadow-ID invariant that find() relies on.
 */
export function mcpSessionID(name: string): string {
  const hash = Bun.SHA256.hash(name.toLowerCase(), "hex").slice(0, 12);
  return `mcp_${hash}`;
}

/** Which kind of harness hosts a chat session: opencode rows are
 *  poller-driven (liveness = process alive), mcp rows are turn-driven
 *  (liveness = a turn ran recently; mail is read at the next prompt). */
export type ChatHostKind = "opencode" | "mcp";

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

// Topics are free text (unlike names) but must stay one line for the
// chat_list roster, so whitespace runs collapse and the value is capped.
const MAX_TOPIC_LEN = 80;

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

  /** Joins the directory with a pool name: picks uniformly at random from the
   * names no other session has claimed (case-insensitively). Idempotent for
   * an already-registered session - it keeps its current name (drawn:
   * false). Fails when every pool name is taken, or when concurrent
   * registrations win every draw attempt - see the redraw loop below.
   */
  assign(
    sessionID: string,
    project: string | null,
    topic: string | null,
    kind: ChatHostKind,
  ): { ok: true; name: string; drawn: boolean; topic: string | null } | { ok: false; error: string } {
    const existing = this.#find(sessionID);
    if (existing) {
      this.#touch(sessionID);
      const cleaned = this.#cleanTopic(topic);
      this.#maybeUpdateTopic(sessionID, existing.topic, cleaned);
      return { ok: true, name: existing.name, drawn: false, topic: cleaned ?? existing.topic };
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
      const cleanTopic = this.#cleanTopic(topic);
      const claimed = this.#insertSession(sessionID, name, project, cleanTopic, kind);
      if (claimed.ok) return { ok: true, name, drawn: true, topic: cleanTopic };
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
  register(sessionID: string, rawName: string, project: string | null, topic: string | null, kind: ChatHostKind): ChatResult {
    const name = rawName.trim();
    const invalid = this.#invalidName(name);
    if (invalid) return { ok: false, error: invalid };
    const cleanTopic = this.#cleanTopic(topic);
    const existing = this.#find(sessionID);
    if (existing) {
      if (existing.name === name) {
        this.#touch(sessionID);
        this.#maybeUpdateTopic(sessionID, existing.topic, cleanTopic);
        // The kept topic: omitted keeps existing, "" clears to null (the
        // read-side normalization this return path mirrors).
        return { ok: true, topic: cleanTopic ?? existing.topic };
      }
      // A NOCASE hit is only a collision when it belongs to a different
      // session - otherwise this is the caller recasing its own name.
      const clash = this.#findByName(name);
      if (clash && clash.session_id !== sessionID) {
        return this.#nameTaken(name);
      }
      try {
        // An omitted topic (null) keeps the existing one, same as the
        // same-name path below - a rename is a re-register, and the tool
        // treats name and topic updates as independent.
        const nextTopic = cleanTopic ?? existing.topic;
        this.#db.run("UPDATE chat_sessions SET name = ?, topic = ?, last_seen = ? WHERE session_id = ?", [
          name,
          nextTopic,
          nowIso(),
          sessionID,
        ]);
        return { ok: true, topic: nextTopic };
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
    const inserted = this.#insertSession(sessionID, name, project, cleanTopic, kind);
    if (inserted.ok) return { ok: true, topic: cleanTopic };
    return inserted;
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
      .query("SELECT session_id, name, topic, project, host_kind, registered_at, last_seen FROM chat_sessions ORDER BY name")
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
  ): { ok: true; recipient: { session_id: string; name: string } } | { ok: false; error: string } {
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
      "INSERT INTO chat_messages (from_session, to_session, body, created_at, via_broadcast) VALUES (?, ?, ?, ?, 0)",
      [fromSession, recipient.session_id, trimmed, nowIso()],
    );
    return { ok: true, recipient: { session_id: recipient.session_id, name: recipient.name } };
  }

  /**
   * Posts a message to every other registered session at once. Stale
   * sessions are skipped, not messaged - a host process that has stopped
   * heartbeat-ing will never read the mail, and a broadcast is for reaching
   * live agents. Each recipient gets its own inbox row, so the existing
   * wake machinery (grouping, gating, rate cap) treats the broadcast as
   * ordinary per-recipient mail.
   */
  broadcast(
    fromSession: string,
    body: string,
  ): { ok: true; recipients: string[]; skipped: string[] } | { ok: false; error: string } {
    const trimmed = body.trim();
    if (!trimmed) return { ok: false, error: "Message body cannot be empty." };
    if (trimmed.length > MAX_BODY_LEN) {
      return { ok: false, error: `Message too long (max ${MAX_BODY_LEN} characters).` };
    }
    const sender = this.#find(fromSession);
    if (!sender) return { ok: false, error: "You are not registered - call chat_register first." };
    const recipients: string[] = [];
    const skipped: string[] = [];
    // One transaction: a crash mid-loop rolls the whole fan-out back
    // instead of leaving a partial broadcast where some recipients got the
    // message and others silently did not.
    this.#db.transaction(() => {
      for (const row of this.list()) {
        if (row.session_id === fromSession) continue;
        // Staleness means "host process gone" only for opencode rows; an
        // mcp row between turns reads its mail at the next prompt, so it
        // always receives.
        if (row.host_kind === "opencode" && isStale(row, CHAT_STALE_MINUTES)) {
          skipped.push(row.name);
          continue;
        }
        this.#db.run(
          "INSERT INTO chat_messages (from_session, to_session, body, created_at, via_broadcast) VALUES (?, ?, ?, ?, 1)",
          [fromSession, row.session_id, trimmed, nowIso()],
        );
        recipients.push(row.name);
      }
    })();
    return { ok: true, recipients, skipped };
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

  /**
   * The caller's mailbox summary for chat_status: whether a directory row
   * exists, and pending/total counts. Touches last_seen on use, which is
   * what keeps an active MCP session's roster row fresh between prompt-time
   * checks. An unregistered caller gets registered: false - the explicit,
   * quiet answer that replaces any nudge.
   */
  status(sessionID: string): { registered: true; name: string; pending: number; total: number } | { registered: false } {
    const row = this.#find(sessionID);
    if (!row) return { registered: false };
    this.#touch(sessionID);
    const counts = this.#db
      .query(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS pending
         FROM chat_messages WHERE to_session = ?`,
      )
      .get(sessionID) as any;
    return {
      registered: true,
      name: row.name,
      pending: counts.pending ?? 0,
      total: counts.total ?? 0,
    };
  }

  /**
   * Pending-mail summary for the hook channel (flush-tools / reminder):
   * every registered session in the project with unread mail, with its
   * display name and unread count. The hook prints this only when
   * non-empty, and names the addressee - a session that never registered
   * never sees a chat line at all.
   */
  pendingByProject(project: string): Array<{ name: string; pending: number }> {
    return (
      this.#db
        .query(
          `SELECT cs.name AS name, COUNT(*) AS pending
           FROM chat_messages m
           JOIN chat_sessions cs ON cs.session_id = m.to_session
           WHERE m.read_at IS NULL AND cs.project = ?
           GROUP BY cs.name
           ORDER BY cs.name`,
        )
        .all(project) as any[]
    ).map((r) => ({ name: r.name, pending: r.pending }));
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
   * The full message feed for `thatch chat tail`: every row with sender and
   * recipient display names resolved (departed senders degrade to unknown),
   * oldest first. The CLI diffs consecutive snapshots to emit sent and
   * read events; the table is machine-scale, so a full scan per poll is
   * cheap.
   */
  messageFeed(): Array<{
    id: number;
    from: string | null;
    to: string | null;
    viaBroadcast: boolean;
    body: string;
    created_at: string;
    read_at: string | null;
  }> {
    return (
      this.#db
        .query(
          `SELECT m.id, m.from_session, m.to_session, fs.name AS from_name, ts.name AS to_name, m.via_broadcast, m.body, m.created_at, m.read_at
           FROM chat_messages m
           LEFT JOIN chat_sessions fs ON fs.session_id = m.from_session
           LEFT JOIN chat_sessions ts ON ts.session_id = m.to_session
           ORDER BY m.id`,
        )
        .all() as any[]
    ).map((r) => ({
      id: r.id,
      from: renderChatParticipant(r.from_name, r.from_session),
      to: renderChatParticipant(r.to_name, r.to_session),
      viaBroadcast: r.via_broadcast === 1,
      body: r.body,
      created_at: r.created_at,
      read_at: r.read_at ?? null,
    }));
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
      .query("SELECT session_id, name, topic, project, host_kind, registered_at, last_seen FROM chat_sessions WHERE session_id = ?")
      .get(sessionID) as any;
    return row ? rowFromSession(row) : null;
  }

  #findByName(name: string): ChatSessionRow | null {
    const row = this.#db
      .query("SELECT session_id, name, topic, project, host_kind, registered_at, last_seen FROM chat_sessions WHERE name = ? COLLATE NOCASE")
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

  /** Collapses whitespace runs (topics must stay one roster line) and caps
   *  the length. The null/empty distinction is load-bearing: null means
   *  "omit on re-register, keep the existing topic", while empty or
   *  whitespace-only means "clear it" - so this never turns one into the
   *  other. Oversized topics are capped, never an error: a topic is
   *  advisory. */
  #cleanTopic(topic: string | null): string | null {
    if (topic === null) return null;
    return topic.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_LEN);
  }

  /** Refreshes the topic on re-registration when it changed. Omitting the
   *  topic (null) keeps the existing one; passing an empty topic clears it. */
  #maybeUpdateTopic(sessionID: string, current: string | null, next: string | null): void {
    if (next === null || next === current) return;
    this.#db.run("UPDATE chat_sessions SET topic = ? WHERE session_id = ?", [next, sessionID]);
  }

  /**
   * INSERTs a directory row, translating a UNIQUE-constraint violation into
   * the friendly taken message. The pre-checks are advisory only against
   * other processes: two sessions claiming one free name in the same
   * instant both pass the check, and the loser's INSERT must not escape the
   * { ok, error } contract as a raw SQLite error. Same pattern as
   * remember()'s slug-collision handling in db.ts.
   */
  #insertSession(sessionID: string, name: string, project: string | null, topic: string | null, kind: ChatHostKind): ChatResult {
    try {
      this.#db.run(
        "INSERT INTO chat_sessions (session_id, name, topic, project, host_kind, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [sessionID, name, topic, project, kind, nowIso(), nowIso()],
      );
      return { ok: true, topic };
    } catch (err) {
      // The two constraints fail differently: a UNIQUE hit on name means
      // someone else claimed it; a PK hit on session_id means this session
      // is somehow registered twice, which is an identity event, not a
      // naming one.
      if (this.#isConstraintError(err)) {
        return this.#alreadyRegistered();
      }
      throw err;
    }
  }

  #isConstraintError(err: unknown): boolean {
    return String((err as any)?.code ?? err).includes("CONSTRAINT");
  }

  /** The one taken-message every claim path returns, so a rewording cannot
   *  drift between the pre-checks and the race catches. Points at the
   *  guaranteed-success recovery (a pool draw) like every other failure
   *  path in this feature. */
  #nameTaken(name: string): ChatResult {
    return {
      ok: false,
      error: `Name "${name}" is taken by another session - pick another name, or omit the name to draw one from the pool.`,
    };
  }

  /** The one already-registered message for a session-ID PRIMARY KEY hit -
   *  a constraint collision that is not a taken name (the caller's own
   *  session row already exists under a different identity path). */
  #alreadyRegistered(): ChatResult {
    return { ok: false, error: "You are already registered - call chat_list to see your current name." };
  }
}

function rowFromSession(r: any): ChatSessionRow {
  return {
    session_id: r.session_id,
    name: r.name,
    // An empty-string topic (explicit clear) reads back as no topic, so the
    // API never leaks the sentinel.
    topic: r.topic || null,
    host_kind: r.host_kind === "mcp" ? "mcp" : "opencode",
    project: r.project,
    registered_at: r.registered_at,
    last_seen: r.last_seen,
  };
}

/**
 * Renders a chat participant for user-visible surfaces (wake prompts, the
 * tail feed, chat_read): the display name when the directory row still
 * exists, otherwise the shared unknown-departed convention. One helper
 * because the exact string is a cross-surface convention - a reword here
 * must reach every surface or the reader sees two names for the same
 * condition.
 */
export function renderChatParticipant(name: string | null, sessionID: string | null | undefined): string {
  if (name) return name;
  return `unknown (${String(sessionID ?? "").slice(0, 12)}, departed)`;
}

// ---------------------------------------------------------------------------
// Tail events (pure logic behind `thatch chat tail`)
// ---------------------------------------------------------------------------

export type ChatTailEvent =
  | { kind: "sent"; timestamp: string; from: string; to: string; body: string }
  | { kind: "read"; timestamp: string; reader: string; from: string; body: string };

/** One message row as the tail diff consumes it. */
export interface ChatTailRow {
  id: number;
  from: string | null;
  to: string | null;
  viaBroadcast: boolean;
  body: string;
  created_at: string;
  read_at: string | null;
}

/**
 * Diffs one feed snapshot against the previous one, emitting sent events
 * for rows the poller has not seen and read events for rows whose read_at
 * appeared since the last poll. Pure: the caller owns the state map (start
 * empty for a fresh tail) and updates it from the returned state. A message
 * inserted and read between two polls emits only its sent line - the sent
 * event is the primary record, and the read of a message nobody saw as sent
 * adds nothing.
 */
export function chatTailDiff(
  prev: Map<number, string | null>,
  rows: Array<ChatTailRow>,
): { events: ChatTailEvent[]; state: Map<number, string | null> } {
  const events: ChatTailEvent[] = [];
  for (const r of rows) {
    const isNew = !prev.has(r.id);
    if (isNew) {
      events.push({
        kind: "sent",
        timestamp: r.created_at,
        from: r.from ?? "unknown",
        to: r.viaBroadcast ? "broadcast" : r.to ?? "unknown",
        body: r.body,
      });
    } else {
      const prevRead = prev.get(r.id) ?? null;
      if (r.read_at !== null && prevRead === null) {
        events.push({
          kind: "read",
          timestamp: r.read_at,
          reader: r.to ?? "unknown",
          from: r.from ?? "unknown",
          body: r.body,
        });
      }
    }
    prev.set(r.id, r.read_at);
  }
  return { events, state: prev };
}

/** Renders one tail event in the CLI's line format. */
export function formatChatTailEvent(event: ChatTailEvent): string {
  if (event.kind === "sent") {
    return `[${event.timestamp}] ${event.from} -> ${event.to}: ${event.body}`;
  }
  const clipped = event.body.length > 60 ? event.body.slice(0, 60) + "..." : event.body;
  return `[${event.timestamp}] ${event.reader} read a message from ${event.from}: ${clipped}`;
}

/** "2026-09-12 19:46 MT" - the UTC timestamp converted to the terminal's
 *  local timezone (abbreviation from the locale, fallback "UTC"), one line
 *  for the card header. */
function localWhen(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())} ${tz}`
  );
}

/**
 * Renders one tail event as a chat card: header block (From / To / When),
 * blank line, full body, then a separator line. This is the human format
 * for `thatch chat tail` - the single-line formatChatTailEvent remains for
 * tests and compact contexts. Read events use the same card shape with the
 * reader in the From slot; broadcast events show "broadcast" as the
 * recipient. The separator is between cards, so the caller joins cards
 * with it and never gets a trailing rule.
 */
// ANSI styling for the tail cards: bg color for the field labels, a
// coordinated fg color for the names, dim for the timestamps, and a
// drawn rule for the separator. Bare ESC sequences rather than a color
// library - the tail is a terminal surface, and the codes are trivial.
const ANSI = {
  labelBg: (s: string) => `\x1b[44m\x1b[97m ${s} \x1b[0m`, // bright white on blue
  nameFg: (s: string) => `\x1b[96m${s}\x1b[0m`, // bright cyan
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`, // dim (timestamps, "a message from")
  rule: (s: string) => `\x1b[2m${s}\x1b[0m`, // dim (the drawn separator)
};

export function formatChatTailCard(event: ChatTailEvent): string {
  // Underscore rule spanning a fixed 60 columns - the drawn separator
  // Jeff asked for (an actual line, not dashes).
  const lines: string[] = [];
  const when = ANSI.dim(localWhen(event.timestamp));
  if (event.kind === "sent") {
    lines.push(`${ANSI.labelBg("From")} ${ANSI.nameFg(event.from)}`);
    lines.push(`      ${ANSI.labelBg("To")} ${ANSI.nameFg(event.to)}`);
    lines.push(`${ANSI.labelBg("When")} ${when}`);
    lines.push("");
    lines.push(event.body);
  } else {
    const clipped = event.body.length > 60 ? event.body.slice(0, 60) + "..." : event.body;
    lines.push(`${ANSI.labelBg("From")} ${ANSI.nameFg(event.reader)}`);
    lines.push(`      ${ANSI.dim("read")} ${ANSI.nameFg(event.from)}`);
    lines.push(`${ANSI.labelBg("When")} ${when}`);
    lines.push("");
    lines.push(clipped);
  }
  return lines.join("\n");
}

export const CHAT_TAIL_SEPARATOR = "_".repeat(60);

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
          const senders = [...new Set(messages.map((m) => renderChatParticipant(m.from_name, m.from_session)))];
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
