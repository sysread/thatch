import type { Database } from "bun:sqlite";
import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** Where the session's host process is running its checkout: "root" for the
 *  project's main checkout, "worktree" for a linked git worktree, null when
 *  undetected (e.g. an MCP host with no directory context). Displayed in
 *  the roster so sessions coordinating on a shared tree can tell who sits
 *  where. */
export type ChatWorktreeKind = "root" | "worktree" | null;

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
  worktree: ChatWorktreeKind;
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

/**
 * Derives the synthetic session ID for an MCP-host chat registration: a
 * pure function of the host's own stable session identifier (Claude Code
 * and Cursor pass one in their hook payloads), so identity survives the
 * ephemeral conversations those hosts run. The underscore keeps the ID
 * outside NAME_CHARSET, preserving the name-cannot-shadow-ID invariant
 * that find() relies on.
 */
export function mcpSessionID(hostSessionID: string): string {
  const hash = Bun.SHA256.hash(hostSessionID.toLowerCase(), "hex").slice(0, 12);
  return `mcp_${hash}`;
}

/**
 * Reads a Claude Code transcript's last line and returns the session id the
 * conversation continued INTO, when the file ends with a continued-in record
 * (Claude Code writes it when a conversation is resumed or forked into a new
 * session id). Returns null otherwise. This is the link that lets a hook
 * follow a continuation backwards: the NEW session id is all the hook knows,
 * and the OLD transcript names it.
 */
export function continuedInTarget(transcriptPath: string): string | null {
  let raw: string;
  try {
    // The marker is the file's final record; reading the tail avoids
    // loading potentially large transcripts.
    const stat = statSync(transcriptPath);
    const tailLen = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(tailLen);
    const fd = openSync(transcriptPath, "r");
    try {
      readSync(fd, buf, 0, tailLen, stat.size - tailLen);
    } finally {
      closeSync(fd);
    }
    raw = buf.toString("utf8");
  } catch {
    return null;
  }
  const lines = raw.trimEnd().split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const record = JSON.parse(last) as { type?: string; continuedInSessionId?: string };
    if (record.type !== "continued-in" || !record.continuedInSessionId) return null;
    return record.continuedInSessionId;
  } catch {
    return null;
  }
}

/**
 * Finds the immediate predecessor of a continued session by scanning the
 * transcript directory for a sibling whose tail hands off TO this session
 * (see continuedInTarget). Most recently modified wins. Returns the
 * predecessor's raw session id (transcript file stem), or null.
 */
export function scanPredecessorTranscript(
  transcriptPath: string,
  sessionID: string,
  maxFiles = 200,
): string | null {
  const dir = dirname(transcriptPath);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && f !== basename(transcriptPath))
      .map((f) => {
        try {
          return { f, m: statSync(join(dir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { f: string; m: number } => e !== null)
      .sort((a, b) => b.m - a.m)
      .slice(0, maxFiles)
      .map((e) => e.f);
  } catch {
    return null;
  }
  for (const f of files) {
    if (continuedInTarget(join(dir, f)) === sessionID) {
      return f.slice(0, -".jsonl".length);
    }
  }
  return null;
}

/**
 * Walks a continuation chain back to the nearest session that has a chat
 * directory row. Claude Code sessions fork on resume (new session id, same
 * conversation), so a hook registering an unknown session id can adopt the
 * predecessor's identity - same name, same mailbox - instead of stranding
 * it. `isRegistered` maps a raw host session id to its chat session id when
 * that row exists, else null. Bounded by maxHops; multi-hop forks resolve
 * to the oldest registered ancestor.
 */
export function resolveRegisteredPredecessor(
  transcriptPath: string,
  sessionID: string,
  isRegistered: (rawSessionID: string) => string | null,
  maxHops = 10,
): string | null {
  let current = sessionID;
  let currentPath = transcriptPath;
  for (let hop = 0; hop < maxHops; hop++) {
    const pred = scanPredecessorTranscript(currentPath, current);
    if (!pred) return null;
    const registered = isRegistered(pred);
    if (registered) return registered;
    current = pred;
    currentPath = join(dirname(transcriptPath), `${pred}.jsonl`);
  }
  return null;
}

/** Which kind of harness hosts a chat session: opencode rows are
 *  poller-driven (liveness = heartbeat fresh), mcp rows are turn-driven
 *  (liveness = a turn ran recently; mail is read at the next prompt). */
export type ChatHostKind = "opencode" | "mcp";

// Display names appear inside wake prompts and chat_list output, so they are
// capped tight. Bodies are capped so a runaway sender cannot turn a nudge
// into a context bomb; the reader fetches full content via chat_read anyway.
const MAX_BODY_LEN = 10_000;

// Assigned names are lowercase slugs of a pool name with a numeric counter
// suffix ("al-go-rithm-00001"), which satisfies NAME_CHARSET. The charset
// stays exported for the pool conformance test. Slugs never contain
// underscores, so the name-cannot-shadow-an-ID invariant in find() still
// holds.
export const NAME_CHARSET = /^[\p{L}\p{N} '.\-]+$/u;

// Topics are free text (unlike names) but must stay one line for the
// chat_list roster, so whitespace runs collapse and the value is capped.
const MAX_TOPIC_LEN = 80;

// Auto-registered sessions whose host has not heartbeat-ed them for this
// many days are pruned from the directory. Counters never decrement, so a
// pruned session's name is never reissued - pruning cannot create identity
// confusion, only roster silence.
const CHAT_AUTO_TTL_DAYS = 7;

/**
 * Slugifies a session title into a name base: lowercase, letter/number runs
 * joined by single hyphens, capped at 32 characters (leaving room for the
 * 6-character counter suffix). Returns null for titles with no usable
 * characters.
 *
 * Deliberately NOT the same as ThatchDB.slugify (src/db.ts): chat names
 * must never contain underscores (find() resolves name-first, and opencode
 * session IDs contain underscores - a legal display name could shadow an
 * ID), so non-alphanumeric runs all become hyphens and empty input returns
 * null rather than a hash fallback.
 */
export function slugifyTitle(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || null;
}

/**
 * Whether a session title is opencode's pre-autotitle placeholder
 * ("New session - <timestamp>" / "Child session - <timestamp>"). These must
 * not become names or topics: they carry no information about the work, and
 * the auto-titler usually replaces them within the first turn or two.
 */
export function isDefaultSessionTitle(title: string): boolean {
  return /^New session - /.test(title) || /^Child session - /.test(title);
}

// Poller cadence. A hosting harness beats each of its sessions once per
// interval and delivers their mail on the same tick.
export const CHAT_POLL_INTERVAL_MS = 30_000;
// Staleness threshold, shared by the poller, chat_list, chat_send, and the
// broadcast skip so every surface agrees on what "stale" means: a row that
// has missed two consecutive beats belongs to a harness that stopped
// (crash, kill, machine asleep). Two beats rather than one so a single
// late poll cycle does not flap the roster.
export const CHAT_STALE_MS = 2 * CHAT_POLL_INTERVAL_MS;
// Wake re-nudge window and the per-recipient hourly nudge cap (the anti-loop
// hard brake); see ChatPoller.
export const CHAT_RENUDGE_MINUTES = 15;
const CHAT_MAX_NUDGES_PER_HOUR = 6;

/** Human-readable age of an ISO timestamp: "45s ago", "5m ago", "3h ago",
 *  "2d ago". Shared by the CLI roster and the chat_list tool so both
 *  surfaces render the same last-check-in wording. */
export function humanAge(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return "unknown age";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** The liveness verdict for one roster row, from heartbeat age alone:
 *  - "fresh"/"stale" for opencode rows (poller-driven heartbeat; stale means *    the hosting harness has missed two beats and is presumed gone)
 *  - "active"/"idle" for MCP rows (turn-driven; idle between prompts is the
 *    NORMAL state, so an idle MCP row is reachable, not dead)
 *  Heartbeat age is the only signal on purpose. A process id cannot serve:
 *  the same session is re-hosted by a new process on every `-s` resume, so
 *  a pid stamped on the row lies as soon as a different harness beats it.
 *  One clock, one rule. */
export function chatLiveness(row: ChatSessionRow, now = Date.now()): "fresh" | "stale" | "active" | "idle" {
  const stale = isStale(row, now);
  if (row.host_kind === "mcp") return stale ? "idle" : "active";
  return stale ? "stale" : "fresh";
}

/** Orders roster rows for display: project first (so a shared-tree reader
 *  sees each repo's sessions together; rows with no project sort last),
 *  then by heartbeat, most recently seen first, so the recoverable rows
 *  lead and the long-dead trail at the bottom. Pure ordering - it never
 *  drops rows; the stale display cap is splitChatRoster's job. */
export function sortChatRoster(rows: ChatSessionRow[]): ChatSessionRow[] {
  return [...rows].sort((a, b) => {
    const projectA = a.project ?? "\uffff";
    const projectB = b.project ?? "\uffff";
    if (projectA !== projectB) return projectA.localeCompare(projectB);
    return Date.parse(b.last_seen) - Date.parse(a.last_seen);
  });
}

/** Splits the roster for the two-section display: Active (wake-able or
 *  reachable - fresh opencode rows and every MCP row, which read mail at
 *  their next prompt) and Stale (opencode rows whose harness has stopped
 *  reporting; mail to them waits until they resume).
 *  staleCapMs bounds how old a stale row the roster displays, so
 *  long-dead sessions cannot bury the fresh signal; hidden rows come
 *  back only as the staleHidden count, so the CLI can say what it left
 *  out. null (the default) shows every stale row - the tool surface has
 *  no cap, only the CLI applies one. */
export function splitChatRoster(rows: ChatSessionRow[], now = Date.now(), staleCapMs: number | null = null): { active: ChatSessionRow[]; stale: ChatSessionRow[]; staleHidden: number } {
  const active: ChatSessionRow[] = [];
  const stale: ChatSessionRow[] = [];
  let staleHidden = 0;
  for (const row of rows) {
    if (chatLiveness(row, now) === "stale") {
      if (staleCapMs !== null && now - Date.parse(row.last_seen) > staleCapMs) {
        staleHidden++;
      } else {
        stale.push(row);
      }
    } else {
      active.push(row);
    }
  }
  return { active, stale, staleHidden };
}

/**
 * The wake-delivery gate, shared by the chat poller and the watcher
 * registry: can this session be woken with a prompt right now? Three
 * layers - the compacting set, the event-fed status map (cheap pre-filter
 * for KNOWN busy/retry states), and the server's authoritative live status
 * map. ABSENCE from the event-fed map is not evidence of busy: the `-s`
 * startup session is hosted from init, before it has emitted any status
 * event, so absence falls through to the live check. A gate that rejected
 * on absence would leave that session mail-deaf - beating fine, never
 * woken - until its first turn. The live
 * map only carries ACTIVE sessions - the server deletes idle entries - so
 * absent means idle there; busy/retry fails closed, as does an unreachable
 * server (the mail stays pending and retries).
 */
export function createWakeGate(deps: {
  isCompacting: (sessionID: string) => boolean;
  mappedStatus: (sessionID: string) => string | undefined;
  fetchStatuses: () => Promise<Record<string, { type?: string } | undefined>>;
  onStatusError?: (sessionID: string, err: unknown) => void;
}): (sessionID: string) => Promise<boolean> {
  return async (sessionID: string) => {
    if (deps.isCompacting(sessionID)) return false;
    const mapped = deps.mappedStatus(sessionID);
    if (mapped === "busy" || mapped === "retry") return false;
    try {
      const statuses = await deps.fetchStatuses();
      const live = statuses[sessionID];
      return !live || live.type === "idle";
    } catch (err) {
      deps.onStatusError?.(sessionID, err);
      return false;
    }
  };
}

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
   * Joins the directory, or refreshes an existing registration. Names are
   * assigned by the system, never claimed: a new session gets
   * "<slug>-<counter>" (e.g. "al-go-rithm-00001"), where the slug is a
   * random pool name (chat-names.ts) and the per-base counter only ever
   * increments - so a name is minted exactly once, machine-wide, and
   * pruning an old session can never reissue its name to someone else. The
   * session title never feeds the name; it rides along as the topic, so a
   * placeholder or later-edited title cannot leave a misleading name
   * behind. Idempotent for an already-registered session: it keeps its
   * name and just refreshes liveness.
   *
   * `nameBase` overrides the pool draw with a fixed base (tests only; every
   * production caller passes null). `topic` is the live title for
   * auto-registrations; null leaves the topic unset. Every row minted here
   * is marked auto=1 - rows with auto=0 exist only as legacy data from the
   * claimed-names era.
   */
  register(
    sessionID: string,
    project: string | null,
    topic: string | null,
    kind: ChatHostKind,
    nameBase: string | null = null,
    worktree: ChatWorktreeKind = null,
  ): { ok: true; name: string; topic: string | null; created: boolean } | { ok: false; error: string } {
    const existing = this.#find(sessionID);
    if (existing) {
      // Reclaim: registration is keyed by session id, so a session
      // continued in a new harness process (`opencode -s <id>`) reclaims
      // its row and name by re-registering. Touching last_seen is the
      // whole of ownership: the harness that beats a row is its host.
      this.#touch(sessionID);
      // An explicit registration clears the leave tombstone for its own
      // session ID: "I want back in" is the opposite of "I left". This is
      // also what closes the in-flight race - an auto-register IIFE whose
      // session was deleted mid-await finds the tombstone here and stops.
      // The caller distinction is by ID: the idle path re-checks with the
      // session's own ID, so a tombstone set by chat_unregister or
      // session.deleted suppresses exactly that session.
      const gate = this.#tombstoneGate(sessionID, kind);
      if (gate) return gate;
      return { ok: true, name: existing.name, topic: existing.topic, created: false };
    }
    const gate = this.#tombstoneGate(sessionID, kind);
    if (gate) return gate;
    const cleanTopic = this.#cleanTopic(topic);
    const base =
      nameBase ??
      slugifyTitle(CHAT_NAME_POOL[Math.floor(Math.random() * CHAT_NAME_POOL.length)]) ??
      "session";
    // The counter draw is atomic, but the name INSERT can still lose to a
    // legacy row that already holds that exact name (custom claims from
    // before names were assigned). Each retry bumps the counter, so the
    // loop always makes forward progress and terminates.
    for (let attempt = 0; attempt < 10; attempt++) {
      const next = this.#bumpCounter(base);
      const name = `${base}-${String(next).padStart(5, "0")}`;
      const claimed = this.#insertSession(sessionID, name, project, cleanTopic, kind, worktree);
      if (claimed.ok) return { ok: true, name, topic: cleanTopic, created: true };
      if (claimed.reason === "already-registered") {
        // A concurrent registration of the same session ID won the race;
        // report its row rather than erroring.
        const winner = this.#find(sessionID);
        if (winner) return { ok: true, name: winner.name, topic: winner.topic, created: false };
      }
    }
    return { ok: false, error: "Could not assign a unique name after several attempts." };
  }

  /** Leaves the directory. Messages already sent to or from the session are
   *  kept as history; departed senders show as unknown names to readers. */
  unregister(sessionID: string): boolean {
    const existing = this.#find(sessionID);
    if (!existing) return false;
    this.#db.transaction(() => {
      // Tombstone before delete: auto-registration keys on the row being
      // absent, so without a marker the next idle event would silently
      // re-register the session under a brand-new name and the user's
      // "leave the directory" would last until the turn ended. The
      // tombstone survives the delete and suppresses auto-registration
      // until the session explicitly rejoins via chat_register (which
      // clears it). Both leave paths come through here - chat_unregister
      // AND session.deleted (a deleted TUI session is an exit too; without
      // the tombstone an in-flight auto-register could resurrect it).
      this.#db.run("INSERT OR REPLACE INTO chat_leave_tombstones (session_id, left_at) VALUES (?, ?)", [
        sessionID,
        nowIso(),
      ]);
      this.#db.run("DELETE FROM chat_sessions WHERE session_id = ?", [sessionID]);
    })();
    return true;
  }

  /** Whether the session explicitly left the directory and has not
   *  rejoined. Auto-registration consults this before inserting; manual
   *  registration (chat_register) clears the tombstone on join. */
  hasLeaveTombstone(sessionID: string): boolean {
    const row = this.#db
      .query("SELECT 1 FROM chat_leave_tombstones WHERE session_id = ?")
      .get(sessionID);
    return row !== null && row !== undefined;
  }

  /** Clears the leave tombstone (chat_register rejoin path). */
  clearLeaveTombstone(sessionID: string): void {
    this.#db.run("DELETE FROM chat_leave_tombstones WHERE session_id = ?", [sessionID]);
  }

  /**
   * Whether the leave tombstone for `sessionID` has been superseded: a
   * newer registration exists in the same project (registered after the
   * leave). The hook uses this to stop announcing a stale leave once the
   * model has rejoined under a fresh identity - the tombstoned identity
   * and the fresh one cannot be linked, but a newer join in the same
   * project is evidence the conversation moved on.
   */
  leaveSuperseded(sessionID: string, project: string | null): boolean {
    if (!project) return false;
    const row = this.#db
      .query(
        `SELECT 1 FROM chat_leave_tombstones t
         JOIN chat_sessions cs ON cs.project = ? AND cs.registered_at > t.left_at
         WHERE t.session_id = ?
         LIMIT 1`,
      )
      .get(project, sessionID);
    return row !== null && row !== undefined;
  }

  /**
   * Refreshes an auto-registered session's topic from its current title.
   * opencode's auto-titler usually lands a real title within the first turn
   * or two, so this converges the roster annotation to the actual work.
   * Manual (legacy) rows are never touched - the topic column on those is
   * user/model-set, not title-derived.
   */
  refreshAutoTopic(sessionID: string, title: string): void {
    const clean = this.#cleanTopic(title);
    if (!clean) return;
    this.#db.run("UPDATE chat_sessions SET topic = ? WHERE session_id = ? AND auto = 1 AND topic IS NOT ?", [
      clean,
      sessionID,
      clean,
    ]);
  }

  /**
   * Removes auto-registered directory rows whose host has not heartbeat-ed
   * them since `cutoff` (ISO), plus unread mail addressed to sessions no
   * longer in the directory. The mail delete is bounded by the same
   * cutoff: unread mail newer than the cutoff survives this sweep and is
   * removed by a later one once it ages past the moving cutoff - the
   * cutoff is a conservative bound, not an exact age match. Delivered/read
   * history and mail from pruned senders to live recipients are kept -
   * departed senders already render as unknown names. Counters are NOT
   * touched: never decrementing is what makes reissued names impossible.
   * Returns the number of directory rows pruned.
   */
  pruneStaleAuto(cutoff: string): number {
    const result = this.#db.run("DELETE FROM chat_sessions WHERE auto = 1 AND last_seen < ?", [cutoff]);
    this.#db.run(
      "DELETE FROM chat_messages WHERE read_at IS NULL AND to_session NOT IN (SELECT session_id FROM chat_sessions) AND created_at < ?",
      [cutoff],
    );
    // Tombstones age out too: they are leave markers, not identity records.
    // A resumed opencode session whose tombstone expired simply
    // auto-registers under a fresh name - the expiry window is the
    // grace period for that. Growth is bounded (one row per distinct
    // session), but the sweep keeps the table from growing monotonically
    // forever.
    this.#db.run("DELETE FROM chat_leave_tombstones WHERE left_at < ?", [cutoff]);
    return result.changes;
  }

  list(): ChatSessionRow[] {
    return (this.#db
      .query("SELECT session_id, name, topic, project, host_kind, registered_at, last_seen, worktree FROM chat_sessions ORDER BY name")
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
        if (row.host_kind === "opencode" && isStale(row)) {
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
   * Records (or refreshes) the hook-parent-process -> session mapping: the
   * identity anchor that closes the caller-claimed `as` hole on Claude Code.
   * Hooks receive the true session id from the host and run as children of
   * the same Claude Code process that spawned the MCP server, so the server
   * can resolve its own parent pid against this mapping - a fact the model
   * cannot influence. Recorded only from payloads that carried Claude Code's
   * `session_id`; Cursor's hooks come from a shared extension host with
   * per-workspace MCP servers, so ppid is ambiguous there and `as` stays the
   * identity source.
   */
  recordHostPid(ppid: number, sessionID: string): void {
    this.#db.run(
      `INSERT INTO chat_host_pids (ppid, session_id, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(ppid) DO UPDATE SET session_id = excluded.session_id, seen_at = excluded.seen_at`,
      [ppid, sessionID, nowIso()],
    );
  }

  /**
   * Resolves a host process id to a chat session id, when a hook recorded
   * the mapping recently and the session still exists in the directory.
   * Freshness bounds the pid-reuse hazard: a dead host's pid can be
   * reassigned by the OS, and a stale mapping must not hand the new
   * occupant the old conversation's identity.
   */
  findSessionByHostPid(ppid: number, maxAgeSeconds: number): string | null {
    const cutoff = isoMinutesAgo(Math.ceil(maxAgeSeconds / 60));
    const row = this.#db
      .query(
        `SELECT p.session_id FROM chat_host_pids p
         JOIN chat_sessions s ON s.session_id = p.session_id
         WHERE p.ppid = ? AND p.seen_at >= ?`,
      )
      .get(ppid, cutoff) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /**
   * Migrates a chat identity onto a continued session id. Claude Code forks
   * the session id on resume/fork while the conversation (name, mailbox,
   * leave state) belongs to the human-level conversation, so the old row's
   * key moves forward and everything referencing the old key follows:
   * message sender/recipient columns (no foreign keys by design - the
   * departed-sender degradation must not apply to a continued conversation),
   * hook-recorded host-pid anchors, and leave tombstones. No-op when the
   * old row does not exist.
   */
  continueSession(oldSessionID: string, newSessionID: string): void {
    if (oldSessionID === newSessionID) return;
    const row = this.#db.query("SELECT session_id FROM chat_sessions WHERE session_id = ?").get(oldSessionID);
    if (!row) return;
    this.#db.run("UPDATE chat_sessions SET session_id = ? WHERE session_id = ?", [newSessionID, oldSessionID]);
    this.#db.run("UPDATE chat_messages SET from_session = ? WHERE from_session = ?", [newSessionID, oldSessionID]);
    this.#db.run("UPDATE chat_messages SET to_session = ? WHERE to_session = ?", [newSessionID, oldSessionID]);
    this.#db.run("UPDATE chat_host_pids SET session_id = ? WHERE session_id = ?", [newSessionID, oldSessionID]);
    this.#db.run("UPDATE chat_leave_tombstones SET session_id = ? WHERE session_id = ?", [newSessionID, oldSessionID]);
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

  /** Refreshes last_seen for the given sessions - the heartbeat that keeps
   *  them out of the stale section. Sessions that never registered are absent from
   *  chat_sessions, so the UPDATE is a no-op for them - no filtering needed
   *  on the caller's side. */
  heartbeat(sessionIDs: string[]): void {
    if (sessionIDs.length === 0) return;
    const marks = sessionIDs.map(() => "?").join(",");
    this.#db.run(`UPDATE chat_sessions SET last_seen = ? WHERE session_id IN (${marks})`, [nowIso(), ...sessionIDs]);
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
    fromTopic: string | null;
    toTopic: string | null;
    viaBroadcast: boolean;
    body: string;
    created_at: string;
    read_at: string | null;
  }> {
    return (
      this.#db
        .query(
          `SELECT m.id, m.from_session, m.to_session, fs.name AS from_name, ts.name AS to_name, fs.topic AS from_topic, ts.topic AS to_topic, m.via_broadcast, m.body, m.created_at, m.read_at
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
      fromTopic: r.from_topic ?? null,
      toTopic: r.to_topic ?? null,
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
      .query("SELECT session_id, name, topic, project, host_kind, registered_at, last_seen, worktree FROM chat_sessions WHERE session_id = ?")
      .get(sessionID) as any;
    return row ? rowFromSession(row) : null;
  }

  #findByName(name: string): ChatSessionRow | null {
    const row = this.#db
      .query("SELECT session_id, name, topic, project, host_kind, registered_at, last_seen, worktree FROM chat_sessions WHERE name = ? COLLATE NOCASE")
      .get(name) as any;
    return row ? rowFromSession(row) : null;
  }

  #touch(sessionID: string): void {
    this.#db.run("UPDATE chat_sessions SET last_seen = ? WHERE session_id = ?", [nowIso(), sessionID]);
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

  /**
   * The leave-tombstone gate, applied on both register() paths (existing
   * row and fresh mint). Policy: an opencode registration is the plugin's
   * auto-registration, so a tombstone suppresses it outright - the in-
   * flight IIFE whose session was deleted mid-await lands here and stops
   * instead of resurrecting a dead session as a roster corpse. An MCP
   * registration over the hook-anchored ID is a genuine rejoin (the
   * derived session ID matches the tombstone), so the gate clears it and
   * lets the registration proceed. Defense in depth: no current
   * production caller reaches the MCP branch with a tombstoned ID (the
   * tool's rejoin clears at its own layer first); UC-101 pins the DB
   * contract. Returns the failure result when the gate refuses, or null
   * to proceed.
   */
  #tombstoneGate(sessionID: string, kind: ChatHostKind): { ok: false; error: string } | null {
    if (!this.hasLeaveTombstone(sessionID)) return null;
    if (kind === "opencode") {
      return { ok: false, error: "leave tombstone active" };
    }
    this.clearLeaveTombstone(sessionID);
    return null;
  }

  /**
   * Atomically draws the next counter value for a name base: the INSERT
   * ... ON CONFLICT upsert seeds the counter at 2 on first draw and
   * increments it on every later draw, returning the drawn value in one
   * statement - two processes racing the same base can never draw the same
   * number. Counters only ever increment (prune included), which is what
   * makes assigned names immortal.
   */
  #bumpCounter(base: string): number {
    // The insert seeds the counter at 2 (1 is being handed out now) so the
    // stored value always reads as the next unassigned number; the RETURNING
    // hands out the drawn value. One statement, race-safe.
    const row = this.#db
      .query(
        "INSERT INTO chat_name_counters (base, next) VALUES (?, 2) ON CONFLICT(base) DO UPDATE SET next = next + 1 RETURNING next - 1 AS drawn",
      )
      .get(base) as { drawn: number };
    return row.drawn;
  }

  /**
   * INSERTs a directory row as auto=1 (the only rows this class mints;
   * auto=0 rows are legacy data). Constraint violations are translated
   * into structured outcomes rather than raw SQLite errors: a UNIQUE hit
   * on name means the counter draw collided with a legacy row holding that
   * exact name (the caller bumps and retries), and a PK hit on session_id
   * means the session row already exists (a concurrent registration won
   * the race).
   */
  #insertSession(
    sessionID: string,
    name: string,
    project: string | null,
    topic: string | null,
    kind: ChatHostKind,
    worktree: ChatWorktreeKind,
  ): { ok: true; topic: string | null } | { ok: false; reason: "name-taken" | "already-registered" } {
    try {
      this.#db.run(
        "INSERT INTO chat_sessions (session_id, name, topic, project, host_kind, registered_at, last_seen, auto, worktree) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        [sessionID, name, topic, project, kind, nowIso(), nowIso(), worktree ?? ""],
      );
      return { ok: true, topic };
    } catch (err) {
      if (!this.#isConstraintError(err)) throw err;
      const msg = String((err as any)?.message ?? err);
      return msg.includes("chat_sessions.name")
        ? { ok: false, reason: "name-taken" }
        : { ok: false, reason: "already-registered" };
    }
  }

  #isConstraintError(err: unknown): boolean {
    return String((err as any)?.code ?? err).includes("CONSTRAINT");
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
    // Pre-migration rows carry the empty-string default; read back as
    // undetected so the roster omits the token instead of printing a blank.
    worktree: r.worktree === "root" || r.worktree === "worktree" ? r.worktree : null,
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

/**
 * One line of the `thatch chat tail` event log. Sending a message and
 * reading it are two events, each on its own line, linked by `id` (the
 * message row id). Broadcast fan-out is one message row per recipient, so
 * a broadcast to N sessions is N sent events with `broadcast: true`, each
 * naming its real recipient and tracking its own read. Timestamps are the
 * database's ISO-8601 UTC strings, untouched.
 */
export type ChatTailEvent =
  | {
      event: "sent";
      at: string;
      id: number;
      from: string;
      from_topic: string | null;
      to: string;
      to_topic: string | null;
      broadcast: boolean;
      body: string;
    }
  | { event: "read"; at: string; id: number; reader: string; reader_topic: string | null; from: string; from_topic: string | null };

/** One message row as the tail diff consumes it. */
export interface ChatTailRow {
  id: number;
  from: string | null;
  to: string | null;
  fromTopic: string | null;
  toTopic: string | null;
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
        event: "sent",
        at: r.created_at,
        id: r.id,
        from: r.from ?? "unknown",
        from_topic: r.fromTopic,
        to: r.to ?? "unknown",
        to_topic: r.toTopic,
        broadcast: r.viaBroadcast,
        body: r.body,
      });
    } else {
      const prevRead = prev.get(r.id) ?? null;
      if (r.read_at !== null && prevRead === null) {
        events.push({
          event: "read",
          at: r.read_at,
          id: r.id,
          reader: r.to ?? "unknown",
          reader_topic: r.toTopic,
          from: r.from ?? "unknown",
          from_topic: r.fromTopic,
        });
      }
    }
    prev.set(r.id, r.read_at);
  }
  return { events, state: prev };
}

/**
 * The default number of backlog messages `thatch chat tail` prints before
 * follow mode takes over. The message table is machine-scale but the
 * history still grows forever, so an unbounded default would dump the
 * entire database on every run.
 */
export const CHAT_TAIL_DEFAULT_LIMIT = 20;

/**
 * Parses a tail time-bound value into epoch milliseconds, interpreted in
 * the terminal's local timezone (event timestamps print in UTC; the bounds
 * are typed by a human at a terminal, so they read as local time).
 * Accepted: "YYYY-MM-DD" (midnight) or "YYYY-MM-DD HH:MM", with either a
 * space or a T between the date and the time. The component round-trip
 * rejects impossible calendar values like 2026-09-31 and 25:99, which
 * JavaScript's Date would otherwise silently normalize.
 */
export function parseChatTimeBound(value: string, flag: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) {
    throw new Error(`${flag} expects "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", got "${value}"`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const date = new Date(y, mo - 1, d, h, mi);
  // Date normalizes out-of-range components (month 13, hour 25); the
  // round-trip is the check that the value was real.
  if (!roundTrip(date, y, mo, d, h, mi)) {
    throw new Error(`${flag} is not a real date or time: "${value}"`);
  }
  return date.getTime();
}

function roundTrip(date: Date, y: number, mo: number, d: number, h: number, mi: number): boolean {
  return (
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi
  );
}

/**
 * Everything the tail can narrow a feed by, all ANDed together. `matches`
 * test the message body; `fromSubstr`/`toSubstr` are case-insensitive
 * substrings of the rendered participant names (so a departed sender can
 * only match as "unknown (...)", the string the reader actually sees).
 * Broadcast fan-out rows carry their real recipient in `to`, so `--to
 * <name>` matches them like any direct message. `sinceMs`/`untilMs`
 * bound created_at in a since-inclusive, until-exclusive window. An empty
 * field is no constraint.
 *
 * Name inputs are not stable across polls: they are re-resolved from the
 * live directory on every feed snapshot, so an unregister or rename
 * flips which rows match. chatTailBacklog's full-feed state seeding is
 * what keeps such flips from resurfacing old rows as sent events; reads
 * of rows whose name stopped matching simply go quiet.
 */
export interface ChatTailFilter {
  matches: RegExp[];
  fromSubstr: string[];
  toSubstr: string[];
  sinceMs: number | null;
  untilMs: number | null;
}

/** Filters a feed snapshot down to the rows the tail should consider. */
export function filterChatTailRows(rows: Array<ChatTailRow>, filter: ChatTailFilter): Array<ChatTailRow> {
  const froms = filter.fromSubstr.map((s) => s.toLowerCase());
  const tos = filter.toSubstr.map((s) => s.toLowerCase());
  return rows.filter((r) => {
    const t = Date.parse(r.created_at);
    if (filter.sinceMs !== null && t < filter.sinceMs) return false;
    if (filter.untilMs !== null && t >= filter.untilMs) return false;
    if (!filter.matches.every((re) => re.test(r.body))) return false;
    if (froms.some((s) => !(r.from ?? "").toLowerCase().includes(s))) return false;
    if (tos.some((s) => !(r.to ?? "").toLowerCase().includes(s))) return false;
    return true;
  });
}

/**
 * Prepares the tail's first render. The diff state seeds from EVERY row in
 * the feed - filtered or not, rendered or not - for two reasons. First,
 * the limit hides messages, not history: a state seeded only from the
 * printed slice would re-emit the elided history as new sent events on
 * the first follow poll. Second, the name filters test JOIN-resolved
 * participant names that can flip mid-follow (a peer unregisters and its
 * history starts rendering as "unknown (... departed)", or it re-registers
 * under a new name); seeding everything means an old row can never resurface
 * as a sent event no matter how its rendered name changes. The last
 * `limit` filtered rows (null = all) shape into sent events, plus a read
 * event for each row already read, via chatTailDiff, so event shaping
 * keeps a single source. `shown` and `elided` count MESSAGES (not
 * events: a shown message contributes one or two lines) for the CLI's
 * summary line.
 *
 * The caller must re-apply the same filter to every follow poll's feed
 * BEFORE the diff (filterChatTailRows, then chatTailDiff with the state
 * returned here). Skipping the poll filter resurrects non-matching
 * history; mutating the state between polls corrupts the read diff.
 */
export function chatTailBacklog(
  rows: Array<ChatTailRow>,
  filter: ChatTailFilter,
  limit: number | null,
): { events: ChatTailEvent[]; state: Map<number, string | null>; shown: number; elided: number } {
  const state = new Map(rows.map((r) => [r.id, r.read_at]));
  const filtered = filterChatTailRows(rows, filter);
  const shown = limit === null ? filtered : filtered.slice(-limit);
  // A snapshot has the full history of each shown message: its send, and
  // its read if read_at is set. Emit both, in time order, so `--once`
  // prints the same event log a follow would have accumulated. Reads of
  // messages the limit hid stay hidden with them.
  const events: ChatTailEvent[] = [];
  for (const r of shown) {
    events.push(...chatTailDiff(new Map(), [r]).events);
    if (r.read_at !== null) events.push(...chatTailDiff(new Map([[r.id, null]]), [r]).events);
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.event === b.event ? 0 : a.event === "sent" ? -1 : 1));
  return { events, state, shown: shown.length, elided: filtered.length - shown.length };
}

/**
 * Renders one tail event as a JSON line. Plain JSON.stringify of the event
 * object: no ANSI, no markdown rendering, no local-time conversion. The
 * tail is a log, and a log is for grep and jq; a terminal reader who wants
 * color pipes through their own tool.
 */
export function formatChatTailJsonl(event: ChatTailEvent): string {
  return JSON.stringify(event);
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
  /** Hourly TTL prune of auto-registered directory rows (and the mail that
   *  can no longer reach a reader). Optional so test fakes stay minimal. */
  pruneStaleChatAuto?(cutoff: string): number;
}

export interface ChatPollerOptions {
  store: ChatPollerStore;
  /** Session IDs this process hosts: those it has seen events for plus the
   *  `-s` startup session. Only sessions hosted by this process can be
   *  delivered to - the recipient's host is the single deliverer, by
   *  design. */
  hostedSessions: () => string[];
  /** Delivers a wake prompt for a recipient. Injected so tests never spawn. */
  deliver: (sessionID: string, senders: string[], count: number) => Promise<void>;
  /** Gate for delivery: true only when the session can accept a proactive
   *  prompt right now (idle, not compacting). May be async - the plugin's
   *  gate verifies against the server's live status, because the event-fed
   *  map can be stale and a wake injected into a running turn is mid-turn
   *  context injection. Undeliverable messages stay pending and retry on
   *  later cycles. */
  canDeliver: (sessionID: string) => boolean | Promise<boolean>;
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
/**
 * Computes the chat poller's hosted set - the sessions this plugin instance
 * may heartbeat and deliver mail to.
 *
 * - Event-fed sessions (status keys): always hosted by the instance that
 *   saw them.
 * - Startup-resumed sessions (-s/-c): hosted by their own instance before
 *   any event arrives.
 * - Re-hosted sessions (a reload rehydration): the instance's own journaled
 *   hosted set, restored so the poller can wake a session the reload left
 *   asleep instead of waiting for the user to type.
 *
 * Child sessions are never hosted (heartbeating one fresh-forever burns
 * nudge budget on undeliverable wake prompts).
 */
export function hostedSessionIds(options: {
  statusKeys: Iterable<string>;
  resumedSessions: Iterable<string>;
  rehostedSessions: Iterable<string>;
  exclude: Iterable<string>;
}): string[] {
  const hosted = [...options.statusKeys, ...options.resumedSessions, ...options.rehostedSessions];
  const excluded = new Set(options.exclude);
  return [...new Set(hosted)].filter((id) => !excluded.has(id));
}

export class ChatPoller {
  #opts: Required<ChatPollerOptions>;
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #delivering = false;
  /** Per-recipient wake-prompt timestamps inside the last hour. */
  #nudges = new Map<string, number[]>();
  /** Last TTL prune epoch ms. Auto-registered rows are pruned hourly, not
   *  every cycle - the prune is a maintenance sweep, not delivery. */
  #lastPrune = 0;

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
      // Hourly sweep: drop auto-registered rows whose host died more than
      // CHAT_AUTO_TTL_DAYS ago, plus the unread mail addressed to sessions
      // no longer in the directory. Automatic registration makes one-shots
      // and crashed sessions routine, so without this the roster fills
      // with corpses; counters never decrement, so pruning cannot reissue
      // a name. The stamp lands before the call, so a throwing prune
      // retries on the next hourly sweep, not the next cycle.
      const now = Date.now();
      if (now - this.#lastPrune > 3_600_000 && this.#opts.store.pruneStaleChatAuto) {
        this.#lastPrune = now;
        this.#opts.store.pruneStaleChatAuto(isoMinutesAgo(CHAT_AUTO_TTL_DAYS * 24 * 60));
      }
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
        if (!(await this.#opts.canDeliver(recipient))) continue;
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

/** True when a session row has missed two heartbeats (see CHAT_STALE_MS).
 *  The one staleness rule: chat_list, chat_send's stale note, and the
 *  broadcast skip all go through here so they can never disagree. */
export function isStale(row: ChatSessionRow, now = Date.now()): boolean {
  return now - Date.parse(row.last_seen) > CHAT_STALE_MS;
}
