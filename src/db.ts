import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { blobToVector, cosineSimilarity } from "./vector-math";
import {
  PredictionEngine,
} from "./prediction";
import { BehaviorEngine } from "./behavior";
import { ChatStore, type ChatHostKind, type ChatWorktreeKind, type LeaveTombstoneReason } from "./chat";
import { PREDICTION_K, PREDICTION_P0, PREDICTION_W_SOFT } from "./scoring-engine";
import type { RepoPathCache, RepoPathRow } from "./git";
import type { NotifyChannel, NotifyJournalEntry, NotifyJournalRow } from "./notify";

export { cosineSimilarity } from "./vector-math";
export type { PredictionNudgeItem, MatcherRow, PredictionRow, ScoredPrediction, PredictionDedupCandidate } from "./prediction";
export type { BehaviorNudgeItem, BehaviorRow, ScoredBehavior } from "./behavior";
export type { ChatSessionRow, ChatInboxItem, ChatNotificationRow, ChatWorktreeKind, LeaveTombstoneReason } from "./chat";

/**
 * The tombstone hold's output prefix, homed at the actual emitter: the hold
 * message is formatted inside remember() below, so the constant lives here
 * rather than in tool-defs with the [saved]/[forgotten] family (that home
 * would force db.ts to value-import the entire tool-defs tree). The runtime
 * hook's held-counter gate imports it from here over the existing ./db
 * edge. Like [saved] and [forgotten], both the emitter and the gate import
 * the same constant so a wording change moves the gate with it.
 *
 * The message must CONTAIN no [saved] marker anywhere, not merely avoid
 * starting with it: the MCP queue's drain gate is inclusion-based
 * (content-array responses stringify with markers inside the JSON), so a
 * wording tweak that let the token slip in would drain a queue on a write
 * that never happened.
 */
export const MEMORY_HELD_MARKER = "[held]";

/**
 * The cosine bar for the tombstone similarity path. Higher than the 0.85
 * live-duplicate warning because a hold is heavier than a warning; the
 * asymmetry that justifies biasing toward matching: a false hold is
 * visible and one-step recoverable (the message names the un-guard),
 * while a false miss silently undoes a deliberate forget.
 */
export const MEMORY_TOMBSTONE_THRESHOLD = 0.9;

/** SHA-256 hex of stored-form content - the tombstone's exact-match key. */
function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * SQLite busy-family errors: lock contention or a WAL snapshot conflict
 * (a concurrent commit invalidated this transaction's read snapshot).
 * busy_timeout retries plain lock waits but never snapshot conflicts, so
 * both reach callers of transactional writes as thrown errors.
 */
function isBusyError(err: any): boolean {
  const text = String(err?.code ?? err?.message ?? err);
  return text.includes("SQLITE_BUSY") || text.includes("database is locked");
}

/**
 * The surfaced hold message, formatted once here (the db layer has the
 * tombstone's label and date) and emitted verbatim by the tool execute
 * and the CLI. Contains no [saved] marker anywhere - see
 * MEMORY_HELD_MARKER for why "anywhere" is the operative word. The
 * un-guard instruction names the store explicitly because the CLI
 * resolves it positionally and defaults to the project store: a
 * global-store guard cleared without the store argument clears nothing.
 */
function heldMessage(
  store: string,
  label: string,
  guard: { label: string; forgotten_at: string },
): string {
  const date = guard.forgotten_at.slice(0, 10);
  return (
    `${MEMORY_HELD_MARKER} ${store} :: ${label} - nothing was saved: this content matches a memory ` +
    `deliberately deleted on ${date} (label "${guard.label}", store "${store}").\n` +
    `If the deletion was right, no action is needed - do not retry this write.\n` +
    `To deliberately re-admit this knowledge: clear the guard first with ` +
    `\`thatch tombstones --clear ${guard.label} ${store}\` (omit the store argument for the ` +
    `project store; a live memory sharing the label, if any, is untouched), then repeat this remember.`
  );
}

export interface MemoryRow {
  slug: string;
  store: string;
  label: string;
  content: string;
  embedding: Uint8Array | null;
  model: string | null;
  branch: string | null;
  confidence: number | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  recall_count: number;
  last_recalled_at: string | null;
}

/** A semantically-similar existing entry, surfaced at write time. */
export interface SimilarEntry {
  slug: string;
  label: string;
  score: number;
}

export interface DedupCandidate {
  store: string;
  slugA: string;
  labelA: string;
  contentA: string;
  slugB: string;
  labelB: string;
  contentB: string;
  score: number;
}

/**
 * SQLite-backed store for thatch. All stores live in a single database
 * partitioned by a `store` column. Embeddings are raw Float32Array bytes
 * stored as BLOBs. Similarity search is brute-force cosine in JS.
 */
export class ThatchDB {
  #path: string;
  #handle: Database | null = null;
  #predictionsStore!: PredictionEngine;
  #behaviorsStore!: BehaviorEngine;
  #chatStore!: ChatStore;
  // The open-tab provider for broadcast targeting (roster OPEN-vs-RECENT).
  // Optional: unwired (tests, callers with no tab reader) means no tab
  // signal, so every fresh opencode row degrades to RECENT - honest, never
  // a false OPEN. Production callers wire chatOpenTabs(src/tab-state.ts).
  #chatOpenTabs?: () => ReadonlySet<string>;
  // The stale-row resumability provider for broadcast fan-out (which
  // session ids the host session database still knows - see
  // resumableSessionIds in src/session-db.ts). Optional: unwired means
  // every stale row stays skipped, the fan-out's conservative default.
  #chatResumableSessions?: (sessionIDs: string[]) => Set<string>;

  constructor(
    path: string,
    opts: { chatOpenTabs?: () => ReadonlySet<string>; chatResumableSessions?: (sessionIDs: string[]) => Set<string> } = {},
  ) {
    this.#path = path;
    this.#chatOpenTabs = opts.chatOpenTabs;
    this.#chatResumableSessions = opts.chatResumableSessions;
    this.#open();
  }

  /**
   * Connection accessor. Every read goes through here, so a handle closed by
   * dispose() (a v2 plugin reload tears down the old activation while tool
   * calls may still be in flight) transparently reopens on the next touch
   * instead of surfacing bun:sqlite's "Cannot use a closed database". WAL
   * journaling plus busy_timeout make the extra connection safe - the chat
   * subsystem already runs as several concurrent connections by design.
   *
   * OWNERSHIP RULE: reopen serves READS and in-flight callers only. After a
   * reload, the RELOADED instance owns the runtime_state journal rows, so
   * post-dispose journal writes must no-op - they are guarded by the
   * disposed flag at their call sites in src/runtime.ts, checked BEFORE any
   * db access reaches this accessor. Do not move that guard in here: this
   * method cannot distinguish a legitimate in-flight caller from a stale
   * writer.
   *
   * Reopen caveat: a `:memory:` database has no file behind it, so a
   * close-then-use cycle on one yields a brand-new EMPTY database. No
   * production path does that (:memory: is test-only and tests never use the
   * instance after close), but keep it that way - use a tmp-file db if a
   * test needs close-then-use.
   */
  get #db(): Database {
    if (this.#handle === null) this.#open();
    return this.#handle!;
  }

  // The engine facades get the same treatment as #db: every accessor
  // ensures an open connection first, so delegation routes through the
  // facade REBUILT by the reopen rather than the stale one. Without this,
  // a post-close chat call would reach the old ChatStore's captured handle
  // and throw "Cannot use a closed database" even though ThatchDB itself
  // reopened.
  get #predictions(): PredictionEngine {
    if (this.#handle === null) this.#open();
    return this.#predictionsStore;
  }

  get #behaviors(): BehaviorEngine {
    if (this.#handle === null) this.#open();
    return this.#behaviorsStore;
  }

  get #chat(): ChatStore {
    if (this.#handle === null) this.#open();
    return this.#chatStore;
  }

  #open(): void {
    const path = this.#path;
    // bun:sqlite creates the file but not its parent directory. On a fresh
    // machine the default path (~/.config/thatch/thatch.db) has no dir yet, so
    // create it here - otherwise every command fails with SQLITE_CANTOPEN.
    // `:memory:` and other special paths have no meaningful parent to create.
    if (path !== ":memory:" && !path.startsWith("file:")) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    // Enforce FK constraints per connection. The prediction tables use
    // ON DELETE CASCADE for edges and provenance; enabling this pragma
    // ensures those cascades fire. Also enforces the entries table's
    // existing FK to stores(name), which was declarative but unenforced
    // before this branch.
    db.run("PRAGMA foreign_keys = ON");
    this.#handle = db;
    // The engine facades hold the Database handle they were constructed
    // with, so a reopened connection rebuilds them. They are stateless
    // views over SQLite - all durable state lives in the tables - so
    // reconstruction is lossless.
    this.#predictionsStore = new PredictionEngine(db);
    this.#behaviorsStore = new BehaviorEngine(db);
    this.#chatStore = new ChatStore(db, { resumableSessions: this.#chatResumableSessions });
    this.#initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  #initSchema(): void {
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS stores (
        name TEXT PRIMARY KEY
      )
    `);

    // Cache mapping worktree directories to their main checkout and repo
    // identity, recorded by detectRepo while the directory is alive. When the
    // worktree is deleted (merged and cleaned up), identity recovery and the
    // watcher cwd fallback read this instead of failing. Never delete the
    // table on upgrade - the whole point is surviving restarts.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS repo_paths (
        worktree_path TEXT PRIMARY KEY,
        main_path     TEXT NOT NULL,
        repo_slug     TEXT NOT NULL,
        resolved_at   INTEGER NOT NULL
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        slug      TEXT NOT NULL,
        store     TEXT NOT NULL REFERENCES stores(name),
        label     TEXT NOT NULL,
        content   TEXT NOT NULL,
        embedding BLOB,
        model     TEXT,
        branch    TEXT,
        confidence INTEGER,
        archived  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at TEXT,
        PRIMARY KEY (slug, store)
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS dedup_pairs (
        store     TEXT NOT NULL,
        slug_a    TEXT NOT NULL,
        slug_b    TEXT NOT NULL,
        status    TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (store, slug_a, slug_b)
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_matchers (
        id          TEXT PRIMARY KEY,
        store       TEXT NOT NULL REFERENCES stores(name),
        description TEXT NOT NULL,
        embedding   BLOB,
        model       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS predictions (
        id              TEXT PRIMARY KEY,
        store           TEXT NOT NULL REFERENCES stores(name),
        statement       TEXT NOT NULL,
        rationale       TEXT,
        embedding       BLOB,
        model           TEXT,
        confidence      REAL NOT NULL DEFAULT 0.5,
        confirm_count   REAL NOT NULL DEFAULT 0,
        disconfirm_count REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_edges (
        matcher_id    TEXT NOT NULL,
        prediction_id TEXT NOT NULL,
        weight        REAL NOT NULL DEFAULT 1.0,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (matcher_id, prediction_id),
        FOREIGN KEY (matcher_id) REFERENCES prediction_matchers(id) ON DELETE CASCADE,
        FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_provenance (
        id            TEXT PRIMARY KEY,
        prediction_id TEXT NOT NULL,
        signal        TEXT NOT NULL,
        detail        TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
      )
    `);

    // Pairwise dedup verdicts for predictions (the prediction-side analog of
    // dedup_pairs). findPredictionDuplicates skips pairs recorded here;
    // prediction_mark_checked writes them. The id pair is stored in canonical
    // sorted order so (A,B) and (B,A) are the same row - readers must sort
    // identically.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS prediction_dedup_pairs (
        store      TEXT NOT NULL,
        id_a       TEXT NOT NULL,
        id_b       TEXT NOT NULL,
        status     TEXT NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (store, id_a, id_b)
      )
    `);

    // Behavior engine: the LLM's codified self-discipline rules. Same
    // shape as the prediction engine (matchers, behaviors, edges,
    // provenance) but separate tables because the semantics differ.
    // Predictions model what the USER wants; behaviors model what the
    // LLM should do. The LLM grades its own behaviors (ham/spam), while
    // the user is the ground truth for predictions.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS behavior_matchers (
        id          TEXT PRIMARY KEY,
        store       TEXT NOT NULL REFERENCES stores(name),
        description TEXT NOT NULL,
        embedding   BLOB,
        model       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS behaviors (
        id              TEXT PRIMARY KEY,
        store           TEXT NOT NULL REFERENCES stores(name),
        statement       TEXT NOT NULL,
        rationale       TEXT,
        embedding       BLOB,
        model           TEXT,
        confidence      REAL NOT NULL DEFAULT 0.5,
        confirm_count   REAL NOT NULL DEFAULT 0,
        disconfirm_count REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS behavior_edges (
        matcher_id   TEXT NOT NULL,
        behavior_id  TEXT NOT NULL,
        weight       REAL NOT NULL DEFAULT 1.0,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (matcher_id, behavior_id),
        FOREIGN KEY (matcher_id) REFERENCES behavior_matchers(id) ON DELETE CASCADE,
        FOREIGN KEY (behavior_id) REFERENCES behaviors(id) ON DELETE CASCADE
      )
    `);

    this.#db.run(`
      CREATE TABLE IF NOT EXISTS behavior_provenance (
        id           TEXT PRIMARY KEY,
        behavior_id  TEXT NOT NULL,
        signal       TEXT NOT NULL,
        detail       TEXT,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        FOREIGN KEY (behavior_id) REFERENCES behaviors(id) ON DELETE CASCADE
      )
    `);

    // Cross-session chat: the machine-wide session directory and message
    // inbox, shared by every opencode process (delivery itself stays local
    // to each host process - see src/chat.ts). Display-name uniqueness is
    // case-insensitive ("Landru" and "landru" are one name), so two visually
    // identical identities cannot coexist. Message endpoints are plain
    // columns, not foreign keys, on purpose: unregistering a session must
    // not be blocked by message history, and a departed sender still
    // renders under the name snapshotted on its message rows (legacy rows
    // without a snapshot degrade to an unknown name) rather than vanishing.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id    TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
        topic         TEXT,
        project       TEXT,
        host_kind     TEXT NOT NULL DEFAULT ('opencode'),
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        last_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        auto          INTEGER NOT NULL DEFAULT 0,
        worktree      TEXT NOT NULL DEFAULT ('')
      )
    `);

    // delivered_at is the last wake-prompt stamp: set when the recipient's
    // host accepts a nudge, restamped on re-nudges (which resets the
    // re-nudge timer). read_at is set when the recipient drains its inbox.
    // via_broadcast marks rows a chat_broadcast fan-out created, so the
    // tail feed can render one broadcast line instead of N direct sends.
    // from_name/to_name snapshot each participant's roster name at send
    // time: names are never reused, so the snapshot cannot go stale the
    // way a cache would, and it survives the participant leaving the
    // directory.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_session  TEXT NOT NULL,
        to_session    TEXT NOT NULL,
        body          TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        delivered_at  TEXT,
        read_at       TEXT,
        via_broadcast INTEGER NOT NULL DEFAULT 0,
        from_name     TEXT,
        to_name       TEXT
      )
    `);

    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES ('global')");

    // Wake-budget accounting: one row per wake PROMPT sent to a recipient,
    // written at send time (before the delivered_at stamp), so a failed
    // stamp cannot turn the nudge cap into an uncounted re-delivery loop.
    // Shared state on purpose: the poller enforces the cap here, and
    // chat_send in any other process reads the same budget. Rows outside
    // the rolling one-hour window are pruned by the poller's hourly sweep.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_wakes (
        to_session TEXT NOT NULL,
        at         TEXT NOT NULL
      )
    `);
    this.#db.run("CREATE INDEX IF NOT EXISTS idx_chat_wakes_window ON chat_wakes (to_session, at)");

    // Per-base name counters for assigned chat names. A row only ever
    // increments (never on prune), so a name is minted exactly once.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_name_counters (
        base TEXT PRIMARY KEY,
        next INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Reaped auto-registered rows leave their name-to-session binding here,
    // so the SAME session can reclaim its name when it re-registers (a
    // crash-and-resume must not churn the identity). Names are still never
    // reissued to a DIFFERENT session: a claim only ever resolves for the
    // session id it was recorded with.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_name_claims (
        name       TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      )
    `);

    // Leave tombstones. Written on every path that removes a directory row
    // while the session stays alive; suppresses auto-registration so the
    // next idle event cannot silently re-register the session. reason
    // distinguishes the leaves a RESUME may undo from the leaves that
    // persist: 'exit' (the wrap-up exit's unregister - the host vanished,
    // so restoring the session rejoins it) clears at the startup-resume and
    // prompt paths; 'explicit' (the chat_unregister tool - a deliberate
    // leave) persists until the session explicitly rejoins via
    // chat_register; 'deleted' (session.deleted bookkeeping - there is no
    // restore path for a deleted session, and a resumed subordinate's
    // rejoin is desired). Survives the directory-row delete, which is the
    // point.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_leave_tombstones (
        session_id TEXT PRIMARY KEY,
        left_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        reason     TEXT NOT NULL DEFAULT 'explicit'
      )
    `);

    // Sessions the plugin itself created as machinery (direct-extraction
    // children). The in-memory child maps that keep these sessions out of
    // the chat directory are lost on plugin reloads and daemon restarts;
    // a marker here is durable, so the auto-registration paths refuse the
    // session even when the maps were lost. Markers age out with the
    // auto-row TTL (session ids are never reused).
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_machinery (
        session_id TEXT PRIMARY KEY,
        reason     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    // Hook-parent-process -> session mapping (Claude Code identity anchor):
    // hooks learn the true session id from the host's hook payload and run
    // as children of the same process that spawned the MCP server, so the
    // server resolves its own parent pid against this table - an identity
    // the model cannot claim. Rows are timestamped; stale rows are ignored
    // (pid reuse) rather than deleted.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS chat_host_pids (
        ppid       INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )
    `);

    // Volatile plugin-runtime state, persisted so a v2 plugin reload (the
    // host rebuilds the location graph and re-runs setup) or a process
    // restart can rehydrate instead of silently dropping it. The writer's
    // pid is the discriminator: a row written by the CURRENT process means
    // "reload - keep and rehydrate"; a row from another (dead) pid means
    // "restart - prune unless the session was resumed".
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_state (
        kind       TEXT NOT NULL,
        session_id TEXT NOT NULL,
        directory  TEXT NOT NULL DEFAULT '',
        value      TEXT NOT NULL,
        pid        INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (kind, session_id)
      )
    `);

    // The forget promise's guard ledger: every deliberate forget writes a
    // row here, and every remember checks it before writing. "Deleted, and
    // guarded" - a display of deleted content reaching the extractor
    // re-minted a forgotten memory once (November 2026), and this table is
    // the backstop that makes the re-mint a held, surfaced write instead.
    // The chat_leave_tombstones precedent ages out; these do NOT - chat
    // rows are leave markers for never-reused session ids, while this
    // table guards re-mintable content, which is the whole point. PK
    // allows one row per content generation per label; INSERT OR REPLACE
    // upserts (a version-skew byte-identical re-save, later forgotten
    // again, targets the standing row - a plain INSERT would throw).
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS memory_tombstones (
        store        TEXT NOT NULL,
        slug         TEXT NOT NULL,
        label        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding    BLOB,
        forgotten_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (store, slug, content_hash)
      )
    `);

    // The notification journal: one row per sendNotification delivery
    // attempt (src/notify.ts records it; outcome is delivered / failed /
    // suppressed / unsupported). Desktop banners are write-only - an
    // osascript banner's text cannot be selected or copied, and clicking
    // one opens a Script Editor file dialog - so this table is the
    // durable, readable record of what was said, read back by
    // `thatch notifications`. Append-only and never pruned: a row is
    // tiny and a machine emits a handful per day.
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS notify_journal (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        channel    TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT '',
        title      TEXT NOT NULL DEFAULT '',
        message    TEXT NOT NULL,
        outcome    TEXT NOT NULL
      )
    `);

    this.#migrateColumns();
    this.#migrateEmptyBranchScope();
    this.#migrateChatNameCollation();
    this.#migrateChatTopic();
    this.#migrateChatHostKind();
    this.#migrateChatBroadcastFlag();
    this.#migrateChatMessageNameSnapshot();
    this.#migrateChatAuto();
    this.#migrateChatWorktree();
    this.#migrateChatHostPid();
    this.#migrateRuntimeStateDirectory();
    this.#migrateChatLeaveReason();
    this.#sweepPhantomPredictionPairs();
  }

  // A prediction pair verdict is garbage by construction when either id is
  // not a live prediction in the pair's own store: prediction_dedup_pairs
  // has no FK, its only reader (PredictionEngine.#checkedPairs) joins
  // nothing, so such a row suppresses nothing. Prediction ids are UUIDs no
  // write path ever reuses, so a missing id can never become live again.
  // Three sources produce these rows: fabricated ids (prediction_mark_checked
  // accepted anything before validation), the merge flow (record 'duplicate',
  // then delete the loser), and wrong-store ids (real predictions that live
  // in a different store's rows). The memory side's dedup_pairs does NOT
  // qualify for a sweep: slugs are derived from content and a forgotten slug
  // can legitimately be re-created, so a stale-looking verdict there can
  // become meaningful again. Runs on every open; idempotent, and the
  // correlated NOT EXISTS probes are PK lookups on small tables.
  #sweepPhantomPredictionPairs(): void {
    this.#db.run(`
      DELETE FROM prediction_dedup_pairs
      WHERE NOT EXISTS (
              SELECT 1 FROM predictions
              WHERE predictions.id = prediction_dedup_pairs.id_a
                AND predictions.store = prediction_dedup_pairs.store
            )
         OR NOT EXISTS (
              SELECT 1 FROM predictions
              WHERE predictions.id = prediction_dedup_pairs.id_b
                AND predictions.store = prediction_dedup_pairs.store
            )
    `);
  }

  // chat_leave_tombstones tables created before the reason column lack it;
  // the ALTER adds it, and existing rows read as explicit (which they were
  // - every tombstone writer predating the column was a leave that should
  // persist until an explicit rejoin).
  #migrateChatLeaveReason(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_leave_tombstones)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("reason")) {
      this.#db.run("ALTER TABLE chat_leave_tombstones ADD COLUMN reason TEXT NOT NULL DEFAULT 'explicit'");
    }
  }

  #migrateRuntimeStateDirectory(): void {
    const cols = (this.#db.query("PRAGMA table_info(runtime_state)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("directory")) {
      this.#db.run("ALTER TABLE runtime_state ADD COLUMN directory TEXT NOT NULL DEFAULT ''");
    }
  }

  // chat_sessions tables created before the auto column lack it; the ALTER
  // adds it, and existing rows read as manual (which they were - auto is
  // only set by the assigned-name registration path).
  #migrateChatAuto(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_sessions)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("auto")) {
      this.#db.run("ALTER TABLE chat_sessions ADD COLUMN auto INTEGER NOT NULL DEFAULT 0");
    }
  }

  // chat_sessions tables created before the host_kind column lack it; the
  // ALTER adds it, and existing rows read as opencode (which they were).
  #migrateChatHostKind(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_sessions)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("host_kind")) {
      this.#db.run("ALTER TABLE chat_sessions ADD COLUMN host_kind TEXT NOT NULL DEFAULT 'opencode'");
    }
  }

  // chat_sessions tables created before the worktree column lack it; the
  // ALTER adds it, and existing rows read as undetected (rendered as no
  // loc token in chat_list) - they registered before the capture existed.
  #migrateChatWorktree(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_sessions)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("worktree")) {
      this.#db.run("ALTER TABLE chat_sessions ADD COLUMN worktree TEXT NOT NULL DEFAULT ''");
    }
  }

  // The released schema has no host_pid column (liveness is heartbeat age;
  // see chatLiveness). A development database may carry one; drop it so
  // every database matches a fresh install.
  #migrateChatHostPid(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_sessions)").all() as any[]).map((r) => r.name);
    if (cols.includes("host_pid")) {
      this.#db.run("ALTER TABLE chat_sessions DROP COLUMN host_pid");
    }
  }

  // chat_messages tables created before the via_broadcast column lack it;
  // the ALTER adds it, and existing rows read as direct sends (which they
  // were).
  #migrateChatBroadcastFlag(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_messages)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("via_broadcast")) {
      this.#db.run("ALTER TABLE chat_messages ADD COLUMN via_broadcast INTEGER NOT NULL DEFAULT 0");
    }
  }

  // chat_messages tables created before the name snapshot columns lack
  // them; the ALTER adds both. Rows written before the migration keep NULL
  // names: no snapshot was captured at their send. Rendering falls back to
  // the live roster join for those rows, and to the unknown-departed
  // fallback when the sender has also left.
  #migrateChatMessageNameSnapshot(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_messages)").all() as any[]).map((r) => r.name);
    if (cols.length > 0) {
      if (!cols.includes("from_name")) {
        this.#db.run("ALTER TABLE chat_messages ADD COLUMN from_name TEXT");
      }
      if (!cols.includes("to_name")) {
        this.#db.run("ALTER TABLE chat_messages ADD COLUMN to_name TEXT");
      }
    }
  }

  // chat_sessions tables created before the topic column lack it; the
  // ALTER adds it, and rows degrade to a NULL topic (rendered as no topic
  // in chat_list).
  #migrateChatTopic(): void {
    const cols = (this.#db.query("PRAGMA table_info(chat_sessions)").all() as any[]).map((r) => r.name);
    if (cols.length > 0 && !cols.includes("topic")) {
      this.#db.run("ALTER TABLE chat_sessions ADD COLUMN topic TEXT");
    }
  }

  // Databases created before recall telemetry lack these columns; the CREATE
  // above only covers fresh files.
  #migrateColumns(): void {
    const existing = new Set(
      (this.#db.query("PRAGMA table_info(entries)").all() as any[]).map((r) => r.name),
    );
    const wanted: [string, string][] = [
      ["recall_count", "INTEGER NOT NULL DEFAULT 0"],
      ["last_recalled_at", "TEXT"],
      ["archived", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [col, decl] of wanted) {
      if (!existing.has(col)) {
        this.#db.run(`ALTER TABLE entries ADD COLUMN ${col} ${decl}`);
      }
    }
  }

  // Rows written before branch-scope normalization can carry branch = ''
  // (an agent passed an empty string - a detached HEAD yields "" from
  // git branch --show-current). An empty string passes the IS NOT NULL
  // filters, so such rows inflated hygiene's orphaned-branch list while
  // memory_list rendered no branch marker for them. Git refnames cannot be
  // empty, so '' is never a legitimate scope; normalize to unscoped.
  // Idempotent: a second open matches zero rows.
  #migrateEmptyBranchScope(): void {
    this.#db.run("UPDATE entries SET branch = NULL WHERE branch = ''");
  }

  // A chat_sessions table created before the NOCASE uniqueness change has a
  // case-SENSITIVE unique constraint, which let "Landru" and "landru"
  // coexist as distinct identities. SQLite cannot ALTER a column
  // constraint, so the repair is a table rebuild. Detection reads the
  // stored CREATE statement from sqlite_master: the NOCASE schema text
  // contains COLLATE NOCASE, the older one does not. Colliding rows
  // collapse via INSERT OR IGNORE (one row wins per case group; scan order
  // decides which). chat_messages has no foreign key into this table, so
  // message history survives untouched.
  //
  // ORDERING TRAP: the rebuild's CREATE and SELECT are pinned to the
  // columns the OLDEST chat_sessions schema had, because a legacy table
  // only has those columns - a SELECT naming a newer column would throw.
  // This migration must run BEFORE any ALTER-based chat_sessions migration
  // (which add newer columns afterward); when adding a column to
  // chat_sessions, extend the ALTER-based migrations, not this SELECT.
  #migrateChatNameCollation(): void {
    const row = this.#db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions'")
      .get() as any;
    if (!row?.sql || /COLLATE\s+NOCASE/i.test(row.sql)) return;
    this.transaction(() => {
      this.#db.run(`
        CREATE TABLE chat_sessions_migrated (
          session_id    TEXT PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
          project       TEXT,
          registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          last_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )
      `);
      this.#db.run("INSERT OR IGNORE INTO chat_sessions_migrated SELECT session_id, name, project, registered_at, last_seen FROM chat_sessions");
      this.#db.run("DROP TABLE chat_sessions");
      this.#db.run("ALTER TABLE chat_sessions_migrated RENAME TO chat_sessions");
    });
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------

  /** Lists all store names in the database. */
  listStores(): string[] {
    return this.#db
      .query("SELECT name FROM stores ORDER BY name")
      .all()
      .map((r: any) => r.name);
  }

  /** Ensures a store exists, creating it if it doesn't. Idempotent. */
  ensureStore(name: string): void {
    this.#db.run("INSERT OR IGNORE INTO stores (name) VALUES (?)", [name]);
  }

  // ---------------------------------------------------------------------------
  // Entries
  // ---------------------------------------------------------------------------

  /**
   * Slugs are the primary key half derived from labels. Unicode letters and
   * digits are preserved so non-English labels don't collapse onto each other;
   * all-symbol labels fall back to a hash so no label ever maps to "".
   * ASCII labels produce the same slugs as earlier releases.
   */
  slugify(label: string): string {
    const slug = label
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .replace(/-+/g, "-");
    if (slug) return slug;

    let h = 0;
    for (const ch of label) {
      h = ((h << 5) - h + ch.codePointAt(0)!) | 0;
    }
    return "x" + (h >>> 0).toString(36);
  }

  entryExists(store: string, slug: string): boolean {
    const row = this.#db
      .query("SELECT 1 FROM entries WHERE slug = ? AND store = ?")
      .get(slug, store);
    return row !== null;
  }

  /**
   * Upserts a memory entry. Returns { ok: false } if a memory with the same
   * label already exists and `overwrite` is not set, or if the content
   * matches a tombstone (a memory deliberately deleted from this store -
   * the write is held, not saved, and the error field carries the full
   * surfaced message; `held` is metadata for tests and introspection, never
   * a formatting source).
   *
   * The tombstone guard governs ENTRY CREATION ONLY. A write carrying
   * overwrite: true that resolves to a live row at (slug, store) is an
   * update, not a creation - it skips the guard entirely, because
   * updating a live record cannot resurrect a deleted one and the
   * deleted sibling stays deleted. Bare saves and overwrites onto
   * absent labels are creations and keep the full guard, so the
   * recursion-loop threat (forgotten content silently re-minted under a
   * fresh label) stays blocked.
   *
   * The tombstone check runs BEFORE the label checks and before
   * ensureStore: a held write creates nothing, not even a store row, and a
   * label complaint would invite a retry that "fixes" the wrong thing.
   *
   * The whole check-and-insert sequence is write-lock-first (BEGIN
   * IMMEDIATE, forgetEntry's pattern): the lock is taken before the
   * tombstone read, so two thatch processes doing label maintenance on
   * one store serialize here - one commits, the other re-reads fresh
   * state under the lock and upserts - instead of racing a deferred
   * read snapshot into a busy failure the agent must retry its way out
   * of. A busy error from that wrapping is CAUGHT and returned on the
   * failure arm rather than thrown: a thrown remember would surface as
   * a host tool error instead of this tool's failure string, and the
   * runtime drain gate is fail-open on unreadable output shapes - a
   * failed write draining the buffer is the silent-loss class the
   * [saved] gate exists to prevent.
   */
  remember(
    store: string,
    label: string,
    content: string,
    embedding: Float32Array,
    model: string,
    opts?: { branch?: string; confidence?: number; overwrite?: boolean; archived?: boolean },
  ): { ok: true } | { ok: false; error: string; held?: { label: string; forgottenAt: string } } {
    const slug = this.slugify(label);
    type RememberResult = { ok: true } | { ok: false; error: string; held?: { label: string; forgottenAt: string } };

    // Write-lock-first: BEGIN IMMEDIATE takes the write lock at
    // transaction start, BEFORE any read (bun's transaction() wrapper
    // begins deferred, which would snapshot the tombstone and entry
    // reads before contending for the write lock - the failure mode the
    // lock ordering here exists to rule out). Inside the try on
    // purpose: a busy BEGIN (another process holds the write lock past
    // busy_timeout) must land on the failure arm like any other busy
    // error, and the rollback catch tolerates there being no
    // transaction to roll back.
    let out: RememberResult;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      // Creation vs update decides the guard: a near-duplicate's
      // tombstone polices the whole content neighborhood its live
      // sibling shares, so holding UPDATES there blocked legitimate
      // corrections of live siblings (November 2026 incidents - the
      // held corrections included polarity-negating ones, whose
      // embeddings sit close to the content they negate). Updates of
      // live rows pass; creations of any shape are guarded.
      const updatesLiveRow = opts?.overwrite === true && this.entryExists(store, slug);
      const guard = updatesLiveRow ? null : this.#findTombstoneMatch(store, content, embedding);
      if (guard) {
        out = {
          ok: false,
          error: heldMessage(store, label, guard),
          held: { label: guard.label, forgottenAt: guard.forgotten_at },
        };
      } else {
        this.ensureStore(store);
        out = this.#writeEntry(store, slug, label, content, embedding, model, opts);
      }
      this.#db.exec("COMMIT");
    } catch (err: any) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* the transaction already failed closed */
      }
      if (isBusyError(err)) {
        return {
          ok: false,
          error: `The memory was not saved - the store was busy (another thatch process was writing). Retry the write.`,
        };
      }
      throw err;
    }
    return out;
  }

  #writeEntry(
    store: string,
    slug: string,
    label: string,
    content: string,
    embedding: Float32Array,
    model: string,
    opts?: { branch?: string; confidence?: number; overwrite?: boolean; archived?: boolean },
  ): { ok: true } | { ok: false; error: string } {
    const blob = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    // branch: "" is not a scope - git refnames cannot be empty, and a
    // detached HEAD yields "" from git branch --show-current, so an agent
    // reading it can pass the empty string by accident. Store unscoped.
    const branch = opts?.branch || null;
    const confidence = opts?.confidence ?? null;
    const archived = opts?.archived === true ? 1 : (opts?.archived === false ? 0 : null);
    const now = new Date().toISOString();

    if (!opts?.overwrite) {
      try {
        this.#db.run(
          `INSERT INTO entries (slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [slug, store, label, content, blob, model, branch, confidence, archived ?? 0, now, now] as any,
        );
        return { ok: true };
      } catch (err: any) {
        if (String(err?.code ?? err).includes("CONSTRAINT")) {
          return {
            ok: false,
            error: `A memory with label "${label}" already exists in store "${store}". ` +
              `Pass overwrite: true to replace it.`,
          };
        }
        throw err;
      }
    }

    const existing = this.#db
      .query("SELECT archived FROM entries WHERE slug = ? AND store = ?")
      .get(slug, store) as { archived: number } | null;

    if (existing && existing.archived && opts?.archived === undefined) {
      return {
        ok: false,
        error: `"${label}" is archived. Pass archived: true to keep it archived, or archived: false to unarchive it.`,
      };
    }

    // archived column for upsert: the INSERT VALUES always needs a non-null
    // value (NOT NULL constraint), so use archived ?? 0. To preserve the
    // existing value when the caller doesn't specify archived, the UPDATE
    // clause accepts a nullable extra param: NULL means "keep existing."
    this.#db.run(
      `
      INSERT INTO entries (slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug, store) DO UPDATE SET
        label = excluded.label,
        content = excluded.content,
        embedding = excluded.embedding,
        model = excluded.model,
        branch = COALESCE(excluded.branch, entries.branch),
        confidence = COALESCE(excluded.confidence, entries.confidence),
        archived = COALESCE(?, entries.archived),
        updated_at = excluded.updated_at
      `,
      [slug, store, label, content, blob, model, branch, confidence, archived ?? 0, now, now, archived] as any,
    );

    this.#db.run(
      "DELETE FROM dedup_pairs WHERE store = ? AND (slug_a = ? OR slug_b = ?)",
      [store, slug, slug],
    );

    return { ok: true };
  }

  /**
   * Brute-force cosine similarity search across the given stores.
   * When branch is specified, includes project-wide (branch IS NULL) plus
   * branch-specific entries. Does NOT stamp recall telemetry - the prompt-aware
   * nudge uses this to check whether memories relate to a prompt without
   * polluting recall_count/last_recalled_at (the agent hasn't actually read
   * them yet, only the plugin has checked for relevance).
   */
  search(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { branch?: string; limit?: number; includeArchived?: boolean },
  ): (MemoryRow & { _score: number })[] {
    if (stores.length === 0) return [];

    const limit = opts?.limit ?? 10;
    const branch = opts?.branch;
    const includeArchived = opts?.includeArchived ?? false;

    const placeholders = stores.map(() => "?").join(", ");

    interface SqlParams { sql: string; params: any[] }

    const { sql, params }: SqlParams = (() => {
      const clauses = ["store IN (" + placeholders + ")", "embedding IS NOT NULL"];
      if (!includeArchived) clauses.push("archived = 0");
      const base = `
        SELECT slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at, recall_count, last_recalled_at
        FROM entries
        WHERE ${clauses.join(" AND ")}
      `;

      if (branch) {
        return {
          sql: base + " AND (branch IS NULL OR branch = ?)",
          params: [...stores, branch],
        };
      }
      return { sql: base, params: stores };
    })();

    const rows = this.#db.query(sql).all(...(params as [any, ...any[]])) as unknown as MemoryRow[];

    if (rows.length === 0) return [];

    // Entries embedded by a different model live in a different vector space;
    // comparing them would produce NaN or nonsense scores, so they're skipped
    // rather than ranked. Dimension is the discriminator - model tags are
    // informational only.
    const scored = rows.flatMap((row) => {
      row.archived = !!row.archived;
      const emb = blobToVector(row.embedding!);
      if (emb.length !== queryEmbedding.length) return [];
      return [{ ...row, embedding: row.embedding, _score: cosineSimilarity(queryEmbedding, emb) }];
    });

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  /**
   * Semantic recall for agent-initiated searches. Delegates to search() for
   * cosine scoring, then stamps recall telemetry - retrieval is the "used
   * recently" signal hygiene reporting keys on.
   */
  recall(
    stores: string[],
    queryEmbedding: Float32Array,
    opts?: { branch?: string; limit?: number; includeArchived?: boolean },
  ): (MemoryRow & { _score: number })[] {
    const top = this.search(stores, queryEmbedding, opts);

    if (top.length > 0) {
      const now = new Date().toISOString();
      const rowKeys = top.map(() => "(?, ?)").join(", ");
      this.#db.run(
        `UPDATE entries SET recall_count = recall_count + 1, last_recalled_at = ?
         WHERE (store, slug) IN (VALUES ${rowKeys})`,
        [now, ...top.flatMap((r) => [r.store, r.slug])] as any,
      );
    }

    return top;
  }

  /**
   * Entries in a store semantically close to the given embedding - the
   * write-time collision check. Unlike recall(), this records no telemetry:
   * it's the plugin looking, not the agent using.
   */
  findSimilar(
    store: string,
    embedding: Float32Array,
    opts?: { threshold?: number; limit?: number; excludeSlug?: string },
  ): SimilarEntry[] {
    const threshold = opts?.threshold ?? 0.85;
    const limit = opts?.limit ?? 3;

    const rows = this.#db
      .query("SELECT slug, label, embedding FROM entries WHERE store = ? AND archived = 0 AND embedding IS NOT NULL")
      .all(store) as any[];

    const hits: SimilarEntry[] = [];
    for (const r of rows) {
      if (r.slug === opts?.excludeSlug) continue;
      const emb = blobToVector(r.embedding);
      if (emb.length !== embedding.length) continue;
      const score = cosineSimilarity(embedding, emb);
      if (score >= threshold) {
        hits.push({ slug: r.slug, label: r.label, score: Math.round(score * 1000) / 1000 });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** Lists all entries in a store, returning metadata without content. */
  listEntries(store: string): { slug: string; label: string; branch: string | null; confidence: number | null; archived: boolean; updated_at: string }[] {
    return this.#db
      .query(
        "SELECT slug, label, branch, confidence, archived, updated_at FROM entries WHERE store = ? ORDER BY label",
      )
      .all(store)
      .map((r: any) => ({
        slug: r.slug,
        label: r.label,
        branch: r.branch,
        confidence: r.confidence,
        archived: !!r.archived,
        updated_at: r.updated_at,
      }));
  }

  /** Full content of a single entry by label. */
  showEntry(store: string, label: string): MemoryRow | null {
    const slug = this.slugify(label);
    const row = this.#db
      .query(
        "SELECT slug, store, label, content, embedding, model, branch, confidence, archived, created_at, updated_at, recall_count, last_recalled_at FROM entries WHERE slug = ? AND store = ?",
      )
      .get(slug, store) as Record<string, unknown> | null;
    if (!row) return null;
    row.archived = !!row.archived;
    return row as unknown as MemoryRow;
  }

  /**
   * Removes a memory by label and writes the deletion guard. The write is
   * transactional and WRITE-LOCK-FIRST (bun:sqlite's immediate mode): the
   * lock is taken before the row read, so no read-then-write snapshot
   * hazard and no stale-read window (a concurrent overwrite cannot commit
   * between the read and the tombstone insert). Tombstone before delete,
   * the chat subsystem's ordering for the same hazard class (an in-flight
   * write resurrecting a just-deleted thing).
   *
   * A failed lock acquisition throws (a host tool error, naturally
   * retried) rather than returning a false miss - telling the agent the
   * label was wrong would send it did-you-mean hunting for a memory that
   * exists. The insert is INSERT OR REPLACE: the reachable collision path
   * is version skew (an un-upgraded writer saved byte-identical content
   * over a standing tombstone; forgetting that entry re-inserts the
   * standing (store, slug, content_hash) row). Concurrent double-forget
   * cannot collide under the lock-first shape - the second forget's
   * under-lock read finds no row and does nothing.
   */
  forgetEntry(store: string, label: string): boolean {
    const slug = this.slugify(label);
    let deleted = false;
    // Write-lock-first: BEGIN IMMEDIATE takes the write lock at transaction
    // start, BEFORE the row read (bun's transaction() flag form works at
    // runtime but is not in its type definitions, and the explicit BEGIN
    // states the lock ordering better than a boolean argument anyway).
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .query("SELECT content, embedding FROM entries WHERE slug = ? AND store = ?")
        .get(slug, store) as { content: string; embedding: Uint8Array | null } | null;
      if (row) {
        this.#db.run(
          "INSERT OR REPLACE INTO memory_tombstones (store, slug, label, content_hash, embedding, forgotten_at) VALUES (?, ?, ?, ?, ?, ?)",
          [store, slug, label, contentHash(row.content), row.embedding ?? null, new Date().toISOString()],
        );
        this.#db.run("DELETE FROM entries WHERE slug = ? AND store = ?", [slug, store]);
        this.#db.run("DELETE FROM dedup_pairs WHERE store = ? AND (slug_a = ? OR slug_b = ?)", [store, slug, slug]);
        deleted = true;
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* the transaction already failed closed */
      }
      throw err;
    }
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Tombstones (the forget guard ledger)
  // ---------------------------------------------------------------------------

  /**
   * The write-time tombstone check, scoped to one store (matching the
   * data model's store-scoped symmetry). Exact hash first - free, exact,
   * and dimension-independent - then the dimension-guarded cosine sweep
   * over the store's embedded tombstones. NULL-embedding rows (a
   * never-embedded forgotten entry) are skipped like dimension
   * mismatches; their hash path still covers them.
   */
  #findTombstoneMatch(
    store: string,
    content: string,
    embedding: Float32Array,
  ): { label: string; forgotten_at: string } | null {
    const exact = this.#db
      .query("SELECT label, forgotten_at FROM memory_tombstones WHERE store = ? AND content_hash = ?")
      .get(store, contentHash(content)) as { label: string; forgotten_at: string } | undefined;
    if (exact) return exact;

    const rows = this.#db
      .query("SELECT label, forgotten_at, embedding FROM memory_tombstones WHERE store = ? AND embedding IS NOT NULL")
      .all(store) as any[];
    for (const r of rows) {
      const emb = blobToVector(r.embedding);
      if (emb.length !== embedding.length) continue;
      if (cosineSimilarity(embedding, emb) >= MEMORY_TOMBSTONE_THRESHOLD) {
        return { label: r.label, forgotten_at: r.forgotten_at };
      }
    }
    return null;
  }

  /** Lists a store's standing guards: label, date, hash prefix. */
  listMemoryTombstones(store: string): { slug: string; label: string; forgottenAt: string; hashPrefix: string }[] {
    return (this.#db
      .query("SELECT slug, label, forgotten_at, content_hash FROM memory_tombstones WHERE store = ? ORDER BY forgotten_at DESC")
      .all(store) as any[]).map((r) => ({
        slug: r.slug,
        label: r.label,
        forgottenAt: r.forgotten_at,
        hashPrefix: String(r.content_hash).slice(0, 12),
      }));
  }

  /**
   * The explicit un-guard: removes all tombstone rows for the (store,
   * slug) - every content generation under the label - and touches
   * nothing else. Never touches entries: in the coexist state (a live
   * entry plus a same-label tombstone from an earlier generation) the
   * live entry survives the clear. Takes the label, the tool/CLI
   * currency, and resolves it through the same slugify the forget keyed
   * on.
   */
  clearMemoryTombstones(store: string, label: string): number {
    const slug = this.slugify(label);
    this.#db.run("DELETE FROM memory_tombstones WHERE store = ? AND slug = ?", [store, slug]);
    const changed = this.#db.query("SELECT changes() AS n").get() as { n: number };
    return changed.n;
  }

  // ---------------------------------------------------------------------------
  // Notification journal
  // ---------------------------------------------------------------------------

  /**
   * Appends one delivery-attempt row. The stamp is the database's (the
   * same strftime default every other table uses); the caller passes
   * everything else, including the outcome. Called through the
   * NotifyJournalWriter seam (src/notify.ts), which never lets a failure
   * here reach the notification dispatch.
   */
  recordNotifyJournal(entry: NotifyJournalEntry): void {
    this.#db.run(
      "INSERT INTO notify_journal (channel, source, title, message, outcome) VALUES (?, ?, ?, ?, ?)",
      [entry.channel, entry.source, entry.title, entry.message, entry.outcome],
    );
  }

  /**
   * The most recent `limit` journal rows, returned oldest-first: display
   * order for `thatch notifications`, which prints newest last. The id
   * (autoincrement) is the ordering key - rows written in the same second
   * keep their insert order.
   */
  listNotifyJournal(limit: number): NotifyJournalRow[] {
    return (this.#db
      .query("SELECT id, created_at, channel, source, title, message, outcome FROM notify_journal ORDER BY id DESC LIMIT ?")
      .all(limit) as any[]).reverse().map((r) => ({
      id: r.id as number,
      created_at: r.created_at as string,
      channel: r.channel as NotifyChannel,
      source: r.source as string,
      title: r.title as string,
      message: r.message as string,
      outcome: r.outcome as NotifyJournalRow["outcome"],
    }));
  }

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  /** Finds pairs of entries with cosine similarity above the threshold. */
  findDuplicates(store: string, threshold = 0.85): DedupCandidate[] {
    const rows = this.#db
      .query(
        "SELECT slug, label, content, embedding FROM entries WHERE store = ? AND archived = 0 AND embedding IS NOT NULL ORDER BY slug",
      )
      .all(store) as any[];

    if (rows.length < 2) return [];

    const entries = rows.map((r: any) => ({
      slug: r.slug,
      label: r.label,
      content: r.content,
      embedding: blobToVector(r.embedding),
    }));

    const candidates: DedupCandidate[] = [];
    const checked = this.#checkedPairs(store);

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const key = [entries[i].slug, entries[j].slug].sort().join("|");
        if (checked.has(key)) continue;
        if (entries[i].embedding.length !== entries[j].embedding.length) continue;

        const score = cosineSimilarity(entries[i].embedding, entries[j].embedding);
        if (score >= threshold) {
          candidates.push({
            store,
            slugA: entries[i].slug,
            labelA: entries[i].label,
            contentA: entries[i].content,
            slugB: entries[j].slug,
            labelB: entries[j].label,
            contentB: entries[j].content,
            score: Math.round(score * 1000) / 1000,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  #checkedPairs(store: string): Set<string> {
    const rows = this.#db
      .query("SELECT slug_a, slug_b FROM dedup_pairs WHERE store = ?")
      .all(store) as any[];
    return new Set(rows.map((r: any) => [r.slug_a, r.slug_b].sort().join("|")));
  }

  // ---------------------------------------------------------------------------
  // Prediction engine: delegates to PredictionEngine
  // ---------------------------------------------------------------------------

  static readonly PREDICTION_K = PREDICTION_K;
  static readonly PREDICTION_P0 = PREDICTION_P0;
  static readonly PREDICTION_W_SOFT = PREDICTION_W_SOFT;

  findMatchers(stores: string[], queryEmbedding: Float32Array, opts?: { limit?: number }) {
    return this.#predictions.findMatchers(stores, queryEmbedding, opts);
  }

  scorePredictions(matchers: { id: string; description: string; score: number }[]) {
    return this.#predictions.scorePredictions(matchers);
  }

  scorePredictionNudge(stores: string[], embedding: Float32Array, threshold: number, limit = 5) {
    return this.#predictions.scorePredictionNudge(stores, embedding, threshold, limit);
  }

  findPredictionDuplicates(store: string, threshold = 0.70) {
    return this.#predictions.findPredictionDuplicates(store, threshold);
  }

  markPredictionPairChecked(store: string, idA: string, idB: string, status: string): void {
    this.#predictions.markPairChecked(store, idA, idB, status);
  }

  findNearestMatcher(store: string, embedding: Float32Array, threshold: number) {
    return this.#predictions.findNearestMatcher(store, embedding, threshold);
  }

  createMatcher(store: string, description: string, embedding: Float32Array, model: string) {
    return this.#predictions.createMatcher(store, description, embedding, model);
  }

  findNearestPrediction(store: string | string[], embedding: Float32Array, threshold: number) {
    return this.#predictions.findNearestPrediction(store, embedding, threshold);
  }

  createPrediction(store: string, statement: string, rationale: string, embedding: Float32Array, model: string) {
    return this.#predictions.createPrediction(store, statement, rationale, embedding, model);
  }

  createEdge(matcherId: string, predictionId: string, weight: number) {
    return this.#predictions.createEdge(matcherId, predictionId, weight);
  }

  adjustConfidence(predictionId: string, signal: "confirm" | "disconfirm" | "soft") {
    return this.#predictions.adjustConfidence(predictionId, signal);
  }

  getPrediction(predictionId: string) {
    return this.#predictions.getPrediction(predictionId);
  }

  addProvenance(predictionId: string, signal: string, detail: string) {
    return this.#predictions.addProvenance(predictionId, signal, detail);
  }

  getProvenance(predictionId: string) {
    return this.#predictions.getProvenance(predictionId);
  }

  deletePrediction(predictionId: string) {
    return this.#predictions.deletePrediction(predictionId);
  }

  listPredictions(store: string) {
    return this.#predictions.listPredictions(store);
  }

  // ---------------------------------------------------------------------------
  // Behavior engine: delegates to BehaviorEngine
  // ---------------------------------------------------------------------------

  findBehaviorMatchers(stores: string[], queryEmbedding: Float32Array, opts?: { limit?: number }) {
    return this.#behaviors.findBehaviorMatchers(stores, queryEmbedding, opts);
  }

  scoreBehaviors(matchers: { id: string; description: string; score: number }[]) {
    return this.#behaviors.scoreBehaviors(matchers);
  }

  scoreBehaviorNudge(stores: string[], embedding: Float32Array, threshold: number, limit = 5) {
    return this.#behaviors.scoreBehaviorNudge(stores, embedding, threshold, limit);
  }

  findNearestBehaviorMatcher(store: string, embedding: Float32Array, threshold: number) {
    return this.#behaviors.findNearestBehaviorMatcher(store, embedding, threshold);
  }

  createBehaviorMatcher(store: string, description: string, embedding: Float32Array, model: string) {
    return this.#behaviors.createBehaviorMatcher(store, description, embedding, model);
  }

  findNearestBehavior(store: string | string[], embedding: Float32Array, threshold: number) {
    return this.#behaviors.findNearestBehavior(store, embedding, threshold);
  }

  createBehavior(store: string, statement: string, rationale: string, embedding: Float32Array, model: string) {
    return this.#behaviors.createBehavior(store, statement, rationale, embedding, model);
  }

  createBehaviorEdge(matcherId: string, behaviorId: string, weight: number) {
    return this.#behaviors.createBehaviorEdge(matcherId, behaviorId, weight);
  }

  adjustBehaviorConfidence(behaviorId: string, signal: "confirm" | "disconfirm" | "soft") {
    return this.#behaviors.adjustBehaviorConfidence(behaviorId, signal);
  }

  getBehavior(behaviorId: string) {
    return this.#behaviors.getBehavior(behaviorId);
  }

  addBehaviorProvenance(behaviorId: string, signal: string, detail: string) {
    return this.#behaviors.addBehaviorProvenance(behaviorId, signal, detail);
  }

  getBehaviorProvenance(behaviorId: string) {
    return this.#behaviors.getBehaviorProvenance(behaviorId);
  }

  deleteBehavior(behaviorId: string) {
    return this.#behaviors.deleteBehavior(behaviorId);
  }

  listBehaviors(store: string) {
    return this.#behaviors.listBehaviors(store);
  }

  // ---------------------------------------------------------------------------
  // Cross-session chat: delegates to ChatStore
  // ---------------------------------------------------------------------------

  registerChatSession(sessionID: string, project: string | null, topic: string | null, kind: ChatHostKind, nameBase: string | null = null, worktree: ChatWorktreeKind = null) {
    return this.#chat.register(sessionID, project, topic, kind, nameBase, worktree);
  }

  refreshChatTopic(sessionID: string, title: string) {
    return this.#chat.refreshAutoTopic(sessionID, title);
  }

  pruneStaleChatAuto(cutoff: string) {
    return this.#chat.pruneStaleAuto(cutoff);
  }

  hasChatLeaveTombstone(sessionID: string) {
    return this.#chat.hasLeaveTombstone(sessionID);
  }

  clearChatLeaveTombstone(sessionID: string) {
    return this.#chat.clearLeaveTombstone(sessionID);
  }

  /** Clears the session's tombstone only when the leave was rejoinable
   *  ("exit"/"deleted"); an "explicit" leave persists. Returns whether it
   *  cleared. Used by the restore-rejoin call sites (startup resume +
   *  prompt path), never by the register gate. */
  clearRejoinableTombstone(sessionID: string) {
    return this.#chat.clearRejoinableTombstone(sessionID);
  }

  markChatMachinery(sessionID: string, reason: string) {
    return this.#chat.markMachinery(sessionID, reason);
  }

  isChatMachinery(sessionID: string) {
    return this.#chat.isMachinery(sessionID);
  }

  chatLeaveSuperseded(sessionID: string, project: string | null) {
    return this.#chat.leaveSuperseded(sessionID, project);
  }

  broadcastChatMessage(fromSession: string, body: string) {
    return this.#chat.broadcast(fromSession, body, this.#chatOpenTabs?.());
  }

  /** The CLI's user-voiced broadcast: sentinel sender, mail-check
   *  delivery, optional project filter. Deliberately NOT routed through
   *  the tab provider - a terminal has no tab signal, and the
   *  mail-check path does not need one. */
  broadcastChatMessageFromUser(body: string, opts: { projects?: string[]; senderName: string }) {
    return this.#chat.broadcastFromUser(body, opts);
  }

  /**
   * Confirmed tab closes recorded by the roster (the session_tab tool's
   * bridge event). Readers subtract the fresh ones from the open-tab set
   * (effectiveOpenTabs) so a residue tabs.json row cannot read OPEN right
   * after a confirmed close.
   */
  chatTabClosures(): { sessionID: string; at: string }[] {
    return this.runtimeStateAll()
      .filter((r) => r.kind === "chat_tab_closed")
      .flatMap((r) => {
        const at = (r.value as { at?: string } | null)?.at;
        return typeof at === "string" ? [{ sessionID: r.sessionID, at }] : [];
      });
  }

  chatMessageStatus(sessionID: string) {
    return this.#chat.status(sessionID);
  }

  chatPendingByProject(project: string) {
    return this.#chat.pendingByProject(project);
  }

  chatMessageFeed() {
    return this.#chat.messageFeed();
  }

  unregisterChatSession(sessionID: string, reason: LeaveTombstoneReason = "explicit") {
    return this.#chat.unregister(sessionID, reason);
  }

  /**
   * Persist one runtime-state record (upsert by kind+session). `directory`
   * is the writing instance's location: one v2 serve hosts one plugin
   * instance per directory sharing this db, and rehydration must be
   * instance-scoped, not process-scoped.
   */
  runtimeStatePut(kind: string, sessionId: string, value: unknown, directory: string, pid: number = process.pid) {
    this.#db
      .query(
        `INSERT INTO runtime_state (kind, session_id, directory, value, pid) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, session_id) DO UPDATE SET directory = excluded.directory, value = excluded.value, pid = excluded.pid, created_at = excluded.created_at`,
      )
      .run(kind, sessionId ?? "", directory ?? "", JSON.stringify(value), pid);
  }

  /** Drop one runtime-state record. */
  runtimeStateDelete(kind: string, sessionId: string) {
    this.#db.query(`DELETE FROM runtime_state WHERE kind = ? AND session_id = ?`).run(kind, sessionId);
  }

  /**
   * One runtime-state record by its (kind, session) primary key, or null.
   * An indexed point read, unlike runtimeStateAll's full scan - callers on
   * per-event paths (the wrap-up arm fallback) use this one.
   */
  runtimeStateGet(kind: string, sessionId: string): { kind: string; sessionID: string; directory: string; value: unknown; pid: number } | null {
    const row = this.#db
      .query(`SELECT kind, session_id, directory, value, pid FROM runtime_state WHERE kind = ? AND session_id = ?`)
      .get(kind, sessionId ?? "") as
      | { kind: string; session_id: string; directory: string | null; value: string; pid: number }
      | null;
    if (!row) return null;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    return {
      kind: row.kind as string,
      sessionID: row.session_id as string,
      directory: (row.directory ?? "") as string,
      value,
      pid: row.pid as number,
    };
  }

  /** Every runtime-state record, oldest first (rehydration source). */
  runtimeStateAll(): { kind: string; sessionID: string; directory: string; value: unknown; pid: number }[] {
    return this.#db
      .query(`SELECT kind, session_id, directory, value, pid FROM runtime_state ORDER BY created_at, session_id`)
      .all()
      .map((row: any) => {
        let value: unknown;
        try {
          value = JSON.parse(row.value);
        } catch {
          value = null;
        }
        return {
          kind: row.kind as string,
          sessionID: row.session_id as string,
          directory: (row.directory ?? "") as string,
          value,
          pid: row.pid as number,
        };
      });
  }

  /**
   * Extraction-journal rows (given kinds) with their age fields, for the
   * staleness sweep. Unlike runtimeStateAll this skips JSON parsing - the
   * values can be large and the sweep only needs identity + age.
   */
  runtimeStateJournalRows(kinds: readonly string[]): { kind: string; sessionID: string; directory: string; createdAt: string }[] {
    const placeholders = kinds.map(() => "?").join(", ");
    return this.#db
      .query(
        `SELECT kind, session_id, directory, created_at FROM runtime_state WHERE kind IN (${placeholders})`,
      )
      .all(...kinds)
      .map((row: any) => ({
        kind: row.kind as string,
        sessionID: row.session_id as string,
        directory: (row.directory ?? "") as string,
        createdAt: row.created_at as string,
      }));
  }

  listChatSessions() {
    return this.#chat.list();
  }

  findChatSession(nameOrID: string) {
    // Facade surface: production resolves recipients inside send()/find();
    // this delegation exists so callers (and tests) can resolve a session
    // by name or ID without reaching past the ThatchDB API.
    return this.#chat.find(nameOrID);
  }

  sendChatMessage(fromSession: string, toNameOrID: string, body: string) {
    return this.#chat.send(fromSession, toNameOrID, body);
  }

  readChatMessages(sessionID: string) {
    return this.#chat.read(sessionID);
  }

  chatMessageById(sessionID: string, id: number) {
    return this.#chat.messageById(sessionID, id);
  }

  unreadChatCount(sessionID: string) {
    return this.#chat.unreadCount(sessionID);
  }

  recordChatHostPid(ppid: number, sessionID: string) {
    return this.#chat.recordHostPid(ppid, sessionID);
  }

  findChatSessionByHostPid(ppid: number, maxAgeSeconds: number): string | null {
    return this.#chat.findSessionByHostPid(ppid, maxAgeSeconds);
  }

  continueChatSession(oldSessionID: string, newSessionID: string) {
    return this.#chat.continueSession(oldSessionID, newSessionID);
  }

  heartbeatChatSessions(sessionIDs: string[]) {
    return this.#chat.heartbeat(sessionIDs);
  }

  pendingChatNotifications(sessionIDs: string[], renudgeCutoff: string) {
    return this.#chat.pendingNotifications(sessionIDs, renudgeCutoff);
  }

  markChatDelivered(ids: number[]) {
    return this.#chat.markDelivered(ids);
  }

  recordChatWake(toSession: string) {
    return this.#chat.recordWake(toSession);
  }

  chatWakeCount(toSession: string, cutoff: string) {
    return this.#chat.wakeCount(toSession, cutoff);
  }

  /** Oldest wake row inside the budget window, for the renewal-time note in
   *  chat_send. Null when the window holds no wakes for the recipient. */
  chatWakeOldest(toSession: string, cutoff: string) {
    return this.#chat.wakeOldest(toSession, cutoff);
  }

  pruneChatWakes(cutoff: string) {
    return this.#chat.pruneWakes(cutoff);
  }

  // ---------------------------------------------------------------------------
  // Repo path cache - worktree dir to main checkout + identity, written by
  // detectRepo while the directory is alive and read after it is deleted.
  // ---------------------------------------------------------------------------

  repoPathGet(worktreePath: string): RepoPathRow | null {
    const row = this.#db
      .query("SELECT worktree_path, main_path, repo_slug FROM repo_paths WHERE worktree_path = ?")
      .get(worktreePath) as any;
    if (!row) return null;
    return { worktreePath: row.worktree_path, mainPath: row.main_path, repoSlug: row.repo_slug };
  }

  repoPathPut(row: RepoPathRow): void {
    this.#db.run(
      `INSERT INTO repo_paths (worktree_path, main_path, repo_slug, resolved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(worktree_path) DO UPDATE SET
         main_path = excluded.main_path,
         repo_slug = excluded.repo_slug,
         resolved_at = excluded.resolved_at`,
      [row.worktreePath, row.mainPath, row.repoSlug, Date.now()],
    );
  }

  repoPathEvict(worktreePath: string): void {
    this.#db.run("DELETE FROM repo_paths WHERE worktree_path = ?", [worktreePath]);
  }

  // ---------------------------------------------------------------------------
  // Hygiene - signals for the session-start heartbeat. Staleness means
  // neither written nor recalled since the cutoff; recall telemetry keeps
  // actively-used old memories out of the count.
  // ---------------------------------------------------------------------------

  /** Entries neither updated nor recalled since the cutoff (ISO timestamp). */
  staleEntryCount(store: string, cutoffIso: string): number {
    const row = this.#db
      .query(
        `SELECT COUNT(*) AS n FROM entries
         WHERE store = ? AND archived = 0 AND max(updated_at, COALESCE(last_recalled_at, updated_at)) < ?`,
      )
      .get(store, cutoffIso) as any;
    return row?.n ?? 0;
  }

  /** Distinct branches with at least one non-archived entry. Fully-archived
   * branches are excluded so hygiene's orphaned list agrees with
   * entryCountForBranches, which also skips archived entries. */
  branchesInStore(store: string): string[] {
    return this.#db
      .query("SELECT DISTINCT branch FROM entries WHERE store = ? AND archived = 0 AND branch IS NOT NULL ORDER BY branch")
      .all(store)
      .map((r: any) => r.branch);
  }

  /** Number of entries scoped to any of the given branches. */
  entryCountForBranches(store: string, branches: string[]): number {
    if (branches.length === 0) return 0;
    const placeholders = branches.map(() => "?").join(", ");
    const row = this.#db
      .query(`SELECT COUNT(*) AS n FROM entries WHERE store = ? AND archived = 0 AND branch IN (${placeholders})`)
      .get(store, ...branches) as any;
    return row?.n ?? 0;
  }

  /** Records a pair as reviewed with its classification. */
  markPairChecked(store: string, slugA: string, slugB: string, status: string): void {
    const [a, b] = [slugA, slugB].sort();
    const now = new Date().toISOString();
    this.#db.run(
      "INSERT OR REPLACE INTO dedup_pairs (store, slug_a, slug_b, status, checked_at) VALUES (?, ?, ?, ?, ?)",
      [store, a, b, status, now],
    );
  }

  /** Runs fn inside a SQLite transaction (BEGIN/COMMIT/ROLLBACK). */
  transaction<T>(fn: () => T): T {
    const t = this.#db.transaction(fn);
    return t();
  }

  close(): void {
    // Drops the current handle only. A later use reopens (see the #db
    // accessor) - the MCP server and CLI call this on process shutdown,
    // where nothing follows; the opencode plugin's dispose calls it on
    // reload, where straggler in-flight tool calls must survive.
    this.#handle?.close();
    this.#handle = null;
  }
}

/**
 * Adapts ThatchDB to the RepoPathCache interface src/git.ts consumes, so
 * git.ts never imports the database. Callers pass this into detectRepo /
 * resolveSpawnCwd / listBranches.
 */
export function repoPathCache(db: ThatchDB): RepoPathCache {
  return {
    get: (p) => db.repoPathGet(p),
    put: (row) => db.repoPathPut(row),
    evict: (p) => db.repoPathEvict(p),
  };
}
