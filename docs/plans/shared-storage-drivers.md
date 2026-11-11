# Opt-in shared storage: driver-style database backends

## Synopsis

ThatchDB opens its database through a driver interface with two
implementations: `bun:sqlite` on a local file (the default, exactly today's
behavior) and a libsql client pointed at a remote SQLite-compatible database
(opt-in). A user who opts in gets one knowledge store shared across machines
-- entries, predictions, behaviors, and the chat directory -- so two laptops
running the same user converge on the same data, and the chat tables become
the substrate for a manual cross-machine cluster. Local stays the default and
the README promise survives for everyone who does not opt in.

## Reviewer orientation

The change is a storage-layer rework plus a small config and CLI surface.
Start at "The driver boundary" for the interface, then "Shared and
machine-local tables" for the split, then "Open-time behavior under the
remote driver" for the part that reworks today's eager open, then "The chat
cluster mapping" for why no chat code changes. The spike in Phase 0 is the
go/no-go gate: the whole remote design stands or falls on whether the
synchronous libsql client actually behaves like SQLite under Bun, including
its behavior when the remote is unreachable. Nothing in this plan is
implemented yet; it is the plan for that work.

## Background

The stated purpose (Jeff, quoted from the commissioning brief relayed by the
coordinating session, 2026-11-11): "a driver-style implementation, where one
is sqlite and another is supabase... allow users (including future users that
do not yet use it) to have persistent data that spans multiple physical
systems. I could share the same memory between a personal laptop and a work
laptop. Both systems would have access to the same memories, including
global ones, as well as behaviors and triggers that customize them to the
user. It would also allow this plugin to let computers form a sort of
manual cluster using thatch chat for coordination."

A research pass completed the day before this plan
(`~/.local/state/thatch-coordinator/external-storage-research-findings.md`)
concluded that no user demand justified live external storage, and named the
change-triggers that would reopen the question. Jeff's message is the first
named trigger realized: the multi-machine user declared himself, with the
same user on two machines, sharing memories, behaviors, and predictions, and
coordinating through chat. The research's architecture facts all still hold
and this plan builds on them:

- The database call graph is synchronous `bun:sqlite` end to end. Every
  raw-SQL call site in `src/db.ts`, `src/chat.ts`, `src/scoring-engine.ts`,
  and `src/prediction.ts` is written against a synchronous client, as are
  all callers: tools, the chat poller, the CLI, and one-shot hook processes.
  (`src/tool-defs.ts` holds no raw SQL; it calls the ThatchDB facade, plus
  the `SessionDB` facade for opencode's own database, which this plan does
  not touch.)
  A Postgres-family client is async-only, so it is not a driver swap -- it
  is an async refactor through the whole codebase.
- libsql (Turso) ships a synchronous, better-sqlite3-compatible client with
  Bun support and embedded replicas. Supabase acquired Turso on 2026-10-02,
  so the SQLite-compatible remote is inside Supabase's platform orbit; a
  "Supabase driver" does not have to mean Postgres.
- Store keys (`owner/repo` parsed from the git remote, `src/git.ts:239-248`
  and `src/git.ts:31-40`) are machine-independent for clones that carry an
  origin remote: two machines cloning the same repo converge on the same
  store identity without any config.
- Embeddings are deterministic from content (a pinned local BGE model,
  `src/embeddings.ts:218`), so two machines running the same model produce
  identical vectors for identical content, and a shared store's vectors are
  valid on both machines.
- The tombstone hold (every `remember` checks the delete ledger before
  writing, inside one transaction, `src/db.ts:830-843`) is the invariant that
  makes deliberate deletes stay deleted. Any shared-store design must keep
  that check running at write time against the same ledger the deletes write
  to.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Driver boundary at the connection-handle level, not a query abstraction | Every raw-SQL call site keeps its SQL text and its synchronous call shape, including the call-through form of transactions (see the boundary section). A per-backend query abstraction would fork every statement per backend forever -- the forked-backend option the research rejected. |
| Two drivers only: `bun:sqlite` (local, default) and libsql (remote, opt-in) | Both speak SQLite, so the boundary stays thin: the dialect, the upsert idioms, and the migration machinery carry over. See the evaluation below for why Supabase-Postgres is rejected as a driver and why the research's local-first outbox shape is rejected as the architecture. |
| Remote-primary writes, local-replica reads | The remote database is the serialization point. Ordinary reads (the per-prompt brute-force search, `src/db.ts:974-990`) come from an embedded replica (a local file the libsql client syncs), so they never pay a network round trip. Reads issued inside a write transaction -- whether through `transaction(fn)` or the raw `BEGIN IMMEDIATE` forget path -- go to the remote, not the replica; that is what keeps the tombstone check, forget's under-lock row read, and transactional upserts at their exact single-database semantics. The name draw stays atomic by single-statement execution on the remote, and the wake budget's count reads the replica and accepts bounded cross-machine skew (see the cluster mapping). See the boundary section's third shape note. |
| Open becomes conditional and offline-safe under the remote driver | Today's constructor eagerly runs schema DDL, migration guards, and two unconditional writes on every open (`src/db.ts:140`, `src/db.ts:191-218`, `src/db.ts:224-584`). Over a remote that means every CLI call and every hook pays remote writes and dies offline. Under the remote driver, schema work runs only when a cheap guard says the shared schema is stale, and an unreachable remote never throws out of the constructor. |
| Write classes: knowledge and identity writes fail loud; loop-control and delivery-accounting writes fail safe (bounded); maintenance writes degrade silently | The full classification -- every chat and memory write, its class, its failure surface, and its catch site -- is the table in "The libsql driver" section. The load-bearing rule it encodes: the anti-loop wake cap must still bind when the remote is unreachable, which requires the poller's budget to fall back to in-process accounting when wake rows cannot land. |
| Offline posture: reads degrade to the (possibly stale, possibly empty) replica, knowledge writes fail loudly | Honest and cheap: memory search and chat reads keep working offline from the replica; a knowledge write that cannot reach the remote fails loudly -- an in-band error for tool-shaped writes, a throw for forget and unregister, per the classification table. A local write queue is a named future extension, not v1 (open question for Jeff). |
| Table split: shared tables vs machine-local tables, routed per statement | The concern line the research found: pid-scoped runtime state, absolute local paths, and per-machine process anchoring must not share. Routing is per statement, not per method -- one chat method mixes handles (see the split section). Everything a second machine needs to look like "the same thatch" shares. |
| Predictions and behaviors share across machines | The research called sharing them semantically wrong for teams, where predictions model one user and behaviors model one agent. This plan shares them for the same user on two machines, which is exactly the case where sharing is semantically right: one user's decision model and one agent's discipline rules, converging from both laptops. |
| Chat tables share; no chat machinery redesign | The chat tables are already inter-process shared state by design (`src/chat.ts:11-13`); extending the sharing from machine-wide to cluster-wide is a store swap, not a protocol change. The delivery rules, the wake machinery, and the store's SQL are untouched; the named small changes (a stamp catch inside the read path, a `sentIds` budget fallback in the poller, adoption-catch log lines) are listed in the cluster mapping. The host-owned delivery rule is preserved: only the machine that hosts a session delivers its mail. |
| Seeding and rollback move knowledge tables only; chat tables are never seeded | The chat tables have no merge-safe keys across machines (`chat_messages` ids are per-database `AUTOINCREMENT`, `chat_wakes` has no primary key), and they do not need seeding: the remote's chat tables start empty and refill as machines register and talk. `push` and `pull` copy memories, predictions, behaviors, and their ledgers -- not chat history. |
| Storage config in `config.json` under a new `storage` section; env overrides for QA | Follows the existing strict-section config model (`src/config.ts:37-41`, `src/config.ts:70-71`). The token is masked in `config_get` (new surface -- no masking precedent exists). All database-path resolution sites centralize through one resolver. |
| Phases as gates, spike first | The spike's pass/fail criteria decide whether the remote driver exists at all. If it fails, the plan stops and the failure evidence goes to Jeff. |

### Driver evaluation: why libsql, not Supabase-Postgres, and not local-first outbox

Jeff named "supabase" as the second driver. Supabase's Postgres client
(supabase-js) is async-only. Adopting it means rewriting every database call
and every caller to async: tool execute functions, the chat poller, the CLI,
one-shot hook processes, and the sideband socket protocol. It also means a
full SQL dialect rewrite per idiom the code relies on: `PRAGMA table_info`
migration guards (`src/db.ts:590-696`) become catalog queries, the
`sqlite_master` schema detection (`src/db.ts:725-744`) becomes a different
catalog, `strftime` defaults become `to_char`, `changes()`
(`src/db.ts:1191`) becomes `RETURNING`, `IN (VALUES ...)` row tuples
(`src/db.ts:1008-1011`) become `unnest`, and `COLLATE NOCASE` uniqueness
(`src/db.ts:411`) becomes a case-insensitive type. That is the forked-forever
backend the research rejected, plus the async refactor on top. Supabase's
paying features for a storage backend (managed auth, row-level security) serve
multi-user team stores, which are out of scope here.

The research's own "smallest version worth building" for a future
multi-machine trigger was local-first replication: local SQLite stays the
write target and a sync layer merges rows (last-writer-wins on `updated_at`
plus a merge-time tombstone re-check). That shape is smaller than this plan
for a memories-only scope, and it is rejected here because the stated
purpose is half chat cluster, and the chat tables are where replication
merges explode: `chat_name_counters` is a monotonic counter where
last-writer-wins is wrong (needs max-merge, and the single-database atomic
draw at `src/chat.ts:1819-1829` is exactly what two divergent local
databases lose); `chat_wakes` is a rolling window that one machine's prune
(`src/chat.ts:1750-1754`) can empty before another machine has pulled;
`chat_messages` rows mutate on the recipient's machine through
`delivered_at`/`read_at` stamps (`markDelivered` stamps the first at
`src/chat.ts:1714-1718`; the read path stamps the second) with no per-column
rule; and heartbeats UPDATE `chat_sessions` every poll cycle
(`src/chat.ts:1627-1631`) against a staleness threshold tuned to that
cadence. Remote-primary replaces every one of those merge rules with the
database's own serialization. The outbox's one durable advantage -- offline
writes -- remains the plan's named future extension, built as a local queue
in front of write-through, without surrendering the serialization point.

Supabase acquired Turso on 2026-10-02. The SQLite-compatible remote database
is now the option inside Supabase's platform that fits this architecture, and
the libsql protocol is not hostage to one vendor: the driver accepts any
libsql endpoint, including a self-hosted libsql server. The honest costs of
the libsql path -- a hosted dependency class the README today promises never
exists, native bindings to validate under two Bun versions, and
post-acquisition hosting terms that are not yet confirmed -- are recorded in
the risk table with mitigations.

## Architecture

### The driver boundary

A `SqlDriver` interface in a new `src/storage.ts`, shaped as exactly the
surface the call sites already use:

```ts
export interface SqlDriver {
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
  run(sql: string, ...params: unknown[]): { changes: number };
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}
```

The statement-level `run` is load-bearing: `runtimeStatePut` and
`runtimeStateDelete` call `.query(...).run(...)` (`src/db.ts:1478-1483`,
`src/db.ts:1488`), and an interface without it fails Phase 1's typecheck on
contact.

Two shape notes are load-bearing:

- `transaction` returns the callable, not the result. `bun:sqlite`'s
  `Database.transaction(fn)` returns a wrapped function (with
  `.deferred`/`.immediate`/`.exclusive` variants), and five engine call sites
  invoke the returned closure (`src/chat.ts:980`, `src/chat.ts:1207`,
  `src/chat.ts:1349`, `src/scoring-engine.ts:303`, `src/scoring-engine.ts:375`),
  as does ThatchDB's own facade (`const t = this.#db.transaction(fn); return
  t();`, `src/db.ts:1679-1682`). With the member typed as `() => T`, the
  `Database` satisfies the interface structurally (checked against the bun
  type definitions; Phase 1's typecheck plus the untouched suite is the
  proof), every call site keeps
  working verbatim, and the libsql adapter returns a closure that runs its
  transaction and returns the result.
- The adapter must preserve transaction begin-modes. bun's `transaction()`
  is DEFERRED, and `remember` depends on that: the busy/snapshot conflict
  from a deferred upgrade is caught and returned as a failure arm
  (`src/db.ts:831`, `src/db.ts:844-852`), while `forgetEntry` deliberately
  bypasses the helper and issues raw `BEGIN IMMEDIATE` (`src/db.ts:1106`).
  An adapter that "improves" transactions to immediate would silently change
  `remember`'s retry semantics. Raw `exec` statements pass through
  untranslated for exactly this reason.
- Nested transactions must compose. bun nests transaction functions via
  savepoints (`src/scoring-engine.ts:292-295` documents the composition),
  and the tool layer relies on it: prediction and behavior writes wrap
  engine transactions inside facade transactions (`src/tool-defs.ts:1095`,
  `src/tool-defs.ts:1290`). An adapter whose `transaction()` issues BEGIN
  while a transaction is already open throws and breaks both write paths;
  the adapter must reproduce savepoint nesting.
- Reads issued inside a transaction go to the remote, not the replica --
  and a transaction means both spellings: `transaction(fn)`, and the raw
  `exec` BEGIN ... COMMIT span that `forgetEntry` runs (`src/db.ts:1106-1120`),
  whose under-lock row read (`src/db.ts:1108-1110`) would otherwise serve
  stale content and hash the wrong generation into the tombstone. The
  tombstone hold is a read of the same class: `remember` checks the ledger
  inside the write transaction (`src/db.ts:830-843`), and a stale-replica
  read there would let a concurrent forget from the other machine slip
  between the check and the write -- the resurrection the hold exists to
  prevent. Only
  the remote can serialize remember against forget exactly as one database
  does. Ordinary (non-transactional) reads stay replica-local; the cost is
  one remote round trip per read inside a write transaction, and every
  write already requires the network.

The call sites use several binding forms: array arguments (`src/db.ts:878`),
varargs (`src/db.ts:1483`), spread-varargs (`src/chat.ts:1702`), the
statement-level `.run` form above, plus zero-argument queries. The libsql
adapter normalizes all of them; a naive
adapter would bind an array as one parameter.

`createDriver(storage)` resolves the config and returns either the local
handle (no wrapper: the `Database` itself) or the libsql driver. The engines
type against the interface instead of the concrete `Database` they take
today (`src/chat.ts:873-875`, `src/scoring-engine.ts:76-77`,
`src/prediction.ts:75`, `src/behavior.ts:52`). The `ThatchDB` constructor's
storage parameter is OPTIONAL and defaults to local, so every existing test
construction site keeps its current call shape. The storage error class
(`StorageUnavailable`, carrying the url) lives in `src/storage.ts` beside the
interface, following the typed-error shape of `DeliverySkippedError`
(`src/capabilities.ts:35-40`); placing it there lets both the driver and
`db.ts` import it without a module cycle.

### Shared and machine-local tables

ThatchDB holds two handles after the split:

- `#local`: a `bun:sqlite` database on `thatch.db`, always. Serves the
  machine-local tables.
- `#shared`: the driver. With the default config it is the same
  `bun:sqlite` handle on the same `thatch.db` file -- today's exact
  single-file layout, so no default user migrates anything. With the libsql
  config it is the remote driver over an embedded replica.

| Routing | Tables | Why |
|---------|--------|-----|
| Shared | `stores`, `entries`, `dedup_pairs`, `memory_tombstones`, `prediction_*`, `behavior_*`, `prediction_dedup_pairs`, `chat_sessions`, `chat_messages`, `chat_wakes`, `chat_name_counters`, `chat_name_claims`, `chat_leave_tombstones`, `chat_machinery`, `storage_meta` (new in this plan: the seed-completion marker's key-value home) | The data a second machine needs to be "the same thatch": memories, the user model, the agent discipline rules, and the chat directory. |
| Machine-local | `runtime_state`, `repo_paths`, `chat_host_pids` | `runtime_state` rows are pid-scoped plugin state (`src/db.ts:537-547`); `repo_paths` caches absolute local paths (`src/db.ts:1607-1629`); `chat_host_pids` maps local process ids to sessions (`src/db.ts:523-529`) and a pid on machine A collides with an unrelated pid on machine B. |

Routing is per statement, not per method, and two ChatStore methods make
that explicit:

- `continueSession` (`src/chat.ts:1549-1558`) writes `chat_host_pids` at
  `src/chat.ts:1556` alongside writes to shared tables. Its host-pid
  statement routes to the local handle; its session, message, and
  leave-tombstone statements route to the shared handle. The method has no
  wrapping transaction today, so the split costs no atomicity.
- `findSessionByHostPid` (`src/chat.ts:1527-1537`) joins `chat_host_pids`
  with `chat_sessions` in one statement. A join cannot span two handles, so
  it becomes two steps: read the pid row through the local handle, then
  resolve the session row through the shared handle. This keeps the MCP
  host-pid identity anchor (the spoofing defense the table exists for)
  working against the live shared directory instead of a frozen local
  snapshot.

`#initSchema` partitions along the same line: local tables are created on
`#local`, shared tables on `#shared`. Every existing migration except the
`runtime_state` directory column (`src/db.ts:597-602`) touches shared tables.
Engine construction (`src/db.ts:214-216`) becomes
`PredictionEngine(#shared)`, `BehaviorEngine(#shared)`, and
`ChatStore(#shared, #local)`. `ThatchDB`'s `runtimeState*` and `repoPath*`
methods route to `#local`. ThatchDB's own shared-table statements -- the
`remember` and `forgetEntry` write paths, recall telemetry, the tombstone
and dedup methods -- and its public `transaction()` (which the tool layer
calls for prediction and behavior writes) route to `#shared`. In default
mode the two handles are one object, so nothing in the existing suite can
catch a misroute; the Phase 2 routing tests are what catch it.

`close()` drops both handles as one unit. In default mode they are the same
object and close must not double-close; in remote mode a straggler read
after close reopens through the existing lazy-reopen accessors
(`src/db.ts:165-189`), where the reworked open (below) keeps the reopen
cheap and never throwing.

### Open-time behavior under the remote driver

Today `#open()` runs eagerly on every construction and every reopen:
`PRAGMA` setup, all schema DDL, the twelve `#migrateXxx` methods, and two
unconditional writes -- the `global` store seed (`src/db.ts:446`) and the
empty-branch normalization UPDATE (`src/db.ts:706`). Over a remote, that
would make every CLI invocation that runs a subcommand (help and version
exit earlier) and every hook process (they construct
`ThatchDB` through the dispatcher at `bin/thatch:101` -- the sideband spares
them the embedding model, not the database) pay remote write round trips for
schema no-ops, and die entirely when offline. The remote driver reworks
open:

- Conditional schema work. A cheap guard (a schema-state marker read from
  the replica, or the first `PRAGMA table_info` probe) decides whether the
  shared-schema DDL, migration guards, and unconditional writes run at all.
  Opening against an already-current shared schema performs no remote
  writes. The local handle keeps today's always-run behavior (its schema is
  tiny and its file is local). The schema guard and the seed-completion
  marker are separate concerns: the guard is a cheap probe answering "is
  the schema current", the marker is a `storage_meta` row answering "did a
  push finish" -- the lifecycle depends only on the marker.
- Offline-safe construction. An unreachable or unauthenticated remote never
  throws out of the constructor: the process opens, reads serve the replica,
  and the first knowledge write returns the typed failure. Schema work
  retries on a later open once the remote is reachable.
- Driver-owned replica sync. The libsql driver arms an unref'd
  `setInterval` (the same timer pattern as the chat poller,
  `src/chat.ts:2716-2722`) that syncs the replica from the remote on a
  cadence satisfying sync-cadence + the writer's poll interval (30s,
  `src/chat.ts:397`) < the chat staleness threshold (60s,
  `src/chat.ts:403`) -- the default is 15s, leaving margin on both bounds.
  Each sync is gated by the replica file's last-sync
  age, so the many processes sharing one replica file on a machine produce
  one sync per window machine-wide, not one per process. This covers every
  long-lived reader uniformly: the opencode poller, the bundled MCP server
  (whose chat-wake path `computePluginChatWake`, `src/flush.ts:202`, polls
  delivery reads on the mod's clock with no poller of its own), and the
  standalone MCP server. One-shot processes never fire the timer (unref'd
  and short-lived); they open against the replica as it stands, and the
  open-time sync is best-effort -- inline if the client's sync call is
  synchronous, fire-and-forget otherwise (the spike pins which) -- so a
  one-shot's reads serve the last-synced replica.
- Explicit sync for interactive loops. The facade gains an optional
  `syncSharedReads()` (the optional-member pattern the poller's store
  interface already uses, `src/chat.ts:2515-2520`) that the `thatch chat
  tail` follow loop calls before each feed read and `thatch storage status`
  calls
  before reporting. No-op on the local driver.
- Seeded behaviors never downgrade. `seedDefaultBehaviors` deletes and
  re-seeds any behavior whose stamped version differs from the running
  package (`src/seed-behaviors.ts:311-322`). Two machines on different
  thatch versions would ping-pong those deletes forever. The rule: when the
  found seed version is newer than the running package, skip the re-seed
  (log it); a machine only ever seeds at or above what the store holds.
  The version read is an ordinary read, so it serves the possibly-stale
  replica: a machine on an older version with a lagging replica can read
  an older-or-absent seed version, pass the check, and delete the remote's
  newer seed -- bounded (converges after sync; the same-version requirement
  is the real mitigation), and stated here the way the wake budget's
  replica-skew is. The seed writes themselves are fail-safe per behavior:
  the existing catch (`src/seed-behaviors.ts:335-337`) logs and continues,
  which is the correct class for startup seeding.

### The libsql driver

- Config: `url`, `authToken`, `replicaPath` (default `thatch-shared.db`
  beside `thatch.db`).
- Writes: forwarded to the remote and applied to the local replica
  (write-through), and read-your-writes holds: after a write-through write
  returns, the replica reflects it -- either the client applies writes
  locally or the adapter syncs after the write (the spike pins which) -- so
  the next prompt's search sees what was just written. The remote is the
  serialization point: concurrent
  `remember` calls from two machines reach the same retryable-failure
  outcome as two processes on one machine today -- locally `busy_timeout`
  retries for five seconds (`src/db.ts:202`), remotely the busy catch's
  failure arm returns (`src/db.ts:844-852`) -- through the same
  transactions.
- Write volume shape: chat liveness produces one batched heartbeat write per
  poll cycle per process hosting sessions (`src/chat.ts:1627-1631`); replica
  syncs are one per freshness window machine-wide. The user docs point at
  the provider's quota page rather than promising a number.
- Errors: network and auth failures map to `StorageUnavailable` carrying the
  url; lock and contention errors keep `SQLITE_BUSY`-shaped messages so
  `isBusyError` (`src/db.ts:56-59`) keeps catching them. The two classes
  must be distinguishable (spike criterion 7).
- Offline: reads serve the replica (stale, or empty when no replica exists
  yet); writes fail per the classification table below. The adapter cannot
  know a write's class -- routing is per statement over raw SQL -- so the
  catch sites live at the facade and at the named in-store and in-poller
  sites the table lists. The chat poller already catches store errors per
  cycle and retries on the next tick (`src/chat.ts:2782-2786`).

Write classification -- class, failure surface, catch site:

| Write | Class | Failure surface and catch site |
|-------|-------|-------------------------------|
| `remember`, prediction and behavior updates | Knowledge | Returned error naming the remote, through the tool layer as today |
| `forget` | Knowledge | Thrown, matching its existing deliberate-throw contract (`src/db.ts:1089-1092`) |
| Chat send, broadcast, explicit and auto registration | Knowledge | In-band `{ok: false, error}` via the facade delegation -- the shape every chat tool already returns; the auto-register callers all handle it (`src/runtime.ts:763-793` startup, `:2649` idle, `:2202` prompt path) |
| Unregister | Knowledge | Throws: `unregister` returns a boolean (`src/chat.ts:977-1002`, facade `src/db.ts:1467-1469`) with no error arm to convert, and a thrown `StorageUnavailable` is the fail-loud posture -- its runtime callers already catch and log (`src/runtime.ts:2577-2581`, `:2787-2791`), and the tool layer surfaces the throw as a host tool error |
| Leave-tombstone clears, session continuation | Identity | Loud logging at the continuation catches (`src/chat.ts:483-487`, `src/cli/hooks.ts:105-110`); the restore-rejoin tombstone clears at `src/runtime.ts:774` and `src/runtime.ts:2178` have no local catch today (safe locally because SQLite runs inline, per the comment at `src/runtime.ts:2163`) and gain one -- an uncaught `StorageUnavailable` there would land inside the host's `chat.message` pipeline; transient failures self-heal on the next registration event, and a persistently offline machine honestly stays out of the directory -- never a silent suppress, because `clearRejoinableTombstone` returning false on a storage failure is a tombstone-gate effect, not liveness |
| Wake rows (the wake-row write: `ChatStore.recordWake`, `src/chat.ts:1728-1729`, facade `recordChatWake`) | Loop-control | Must NOT degrade silently. When the write fails, the poller substitutes a per-recipient, time-windowed in-process prompt count -- wake timestamps for the rolling hour -- for the DB count (`chatWakeCount`, `src/chat.ts:1734-1738`). The id-set alone cannot budget: it classifies fresh-vs-held, it does not count prompts, and a small batch's ids never drain a budget. Without a working fallback the replica's count never rises while the write fails, and an unbudgeted 30-second wake loop is exactly the failure class the cap exists to stop (`src/chat.ts:2921-2930`, `src/chat.ts:404-411`). Recovery seam: when writes recover after an offline stretch, the failed-era prompts are uncounted in the DB, so the budget overshoots by that era's prompts for the rest of the window -- bounded, and the cap is an anti-loop brake, not a correctness guarantee |
| Delivered/read stamps (`markDelivered` `src/chat.ts:1714-1718`; the read stamp at `src/chat.ts:1453`) | Delivery-accounting | Caught at the stamp site, inside the store or its callers: the read path returns the selected rows with the stamp skipped; `markDelivered`'s poller path already falls back to `sentIds` (`src/chat.ts:2959-2968`); the Stop-hook caller (`src/cli/commands/hook-commands.ts:336`) and the bundled regime's chat-wake caller (`src/flush.ts:213`) gain the same catch -- the command-level catch already keeps the Stop-hook process alive (`src/cli/commands/hook-commands.ts:276-348`), so the catch's job there is preserving the nudge with the stamp skipped, and the bundled path would otherwise throw on every mod-clock poll offline |
| Heartbeats, topic refresh, machinery markers, prune sweeps, recall telemetry (`src/db.ts:1008-1012`, `src/chat.ts:1627-1631`) | Maintenance | Best-effort, caught inside the facade method itself -- not merely inside the poller's cycle catch (`src/chat.ts:2782-2786`), which aborts the whole cycle before delivery if a heartbeat throw reaches it; caught, logged, skipped, all retry naturally (heartbeat every cycle, prunes hourly, telemetry on the next recall), so the roster still renders and recall still returns results offline |

### Storage configuration and lifecycle

New `storage` section in `config.json`, following the strict-section model
(`src/config.ts:37-41`): `{ driver: "local" | "libsql", url, authToken,
replicaPath }`, all optional (absent `driver` means local).

The section surfaces in four places, three of which are hand-rolled in
`src/tool-defs.ts` today and pinned by no existing test (no test references
`CONFIG_SECTIONS`): the config schema and section list
(`src/config.ts:37-41`, `src/config.ts:70-71`) plus a `mergeStoragePrefs`
following `mergeChatPrefs` (`src/config.ts:163-165`); the `config_get` args
enum (`src/tool-defs.ts:1516`); the `config_get` render chain
(`src/tool-defs.ts:1535-1547`); and the `config_set` args schemas
(`src/tool-defs.ts:1567-1621`). The token renders masked (new surface: no
masking precedent exists in the codebase; a first-4/last-2 shape decided in
review). Phase 3 lands tool-level tests for all four, following the existing
config tool test pattern (`tests/notify.test.ts:331-523`).

Env overrides `THATCH_STORAGE_DRIVER`, `THATCH_STORAGE_URL`, and
`THATCH_STORAGE_TOKEN` cover QA and tests, and register in `ENV_KNOBS`
(`src/env-knobs.ts:31-34`) -- the drift test
(`tests/env-knobs.test.ts:46-60`) fails the gate on any unregistered
`THATCH_*` read in `src/` or `bin/`, so registration is self-enforcing. The
env-gated remote integration test's `THATCH_TEST_REMOTE_URL` is read only
inside `tests/`, outside the drift test's scan.

A `resolveStorage(dbPath?)` helper in `src/config.ts` reads config plus env
and returns the effective driver settings, following the
`configFilePath(dbPath?)` precedent (`src/config.ts:78-84`): optional
parameter, env/XDG fallback inside the helper. It absorbs the path
resolution sites -- `bin/thatch:20-21`, `src/mcp.ts:179`,
`src/runtime.ts:259`, and `src/setup.ts:77-78` -- unifying their two
disagreeing HOME-fallback forms onto `homedir()` (a micro behavior change
only when `HOME` is unset). `src/index.ts:43` keeps its own resolution
because the debug log only needs the path.

A forward-compatibility caveat, documented rather than engineered: the
config schema is strict, so an older thatch build that predates `storage`
ignores the entire config file when the section exists (parse failure falls
back to the empty config with a warning, `src/config.ts:102-111`). A
two-machine user running different thatch versions loses that machine's
notification/chat/alerts prefs until both machines update -- and worse: the
older machine reverts to LOCAL-DEFAULT, so its knowledge writes land in the
frozen local `thatch.db` while the other machine writes the remote. The
bytes survive, but the shared store silently diverges until both machines
run the same version and the stranded writes are merged by hand. The user
doc states the same-version requirement in exactly these terms.

Storage lifecycle states:

| State | Shared-table reads | Knowledge writes | How entered |
|-------|--------------------|------------------|-------------|
| LOCAL-DEFAULT | local `thatch.db` | local `thatch.db` | No `storage` config (every user today) |
| REMOTE-CONFIGURED | replica of the (possibly empty) remote | remote | User hand-writes the config (or sets the env overrides) without running `push` -- the remote is not yet verified seeded |
| SHARED-ACTIVE | replica, synced within the freshness window | write-through to remote | `push` completed (marker written), or a fresh machine whose first successful sync found a marker-carrying remote |
| OFFLINE-DEGRADED | replica, stale or empty, warning surfaced | typed failure naming the remote | Remote unreachable or unauthenticated, from ANY configured state |

Transition precedence: reachability beats configuration -- OFFLINE-DEGRADED
is entered by connectivity alone, and left by connectivity or by removing
the storage config, whatever configured state it interrupts. Freshness is not a state of its own: within whichever state
holds, it is only how current the replica is. The boundary between
REMOTE-CONFIGURED and SHARED-ACTIVE is one rule: the seed-completion marker
is known-present -- written by this machine's `push`, or found by a sync.
Without the marker -- empty or partial -- the machine is REMOTE-CONFIGURED
(the footgun, with `status` naming
the partial case distinctly). Reads always serve the replica in every
configured state; the
difference is only how current that replica is (or whether one exists yet).
REMOTE-CONFIGURED-unseeded otherwise exists only through hand-editing:
`push` writes the config after a successful seed, so the recommended path
never passes through it. `thatch storage status` names the state explicitly
and warns in the unseeded case. Rollback (SHARED-ACTIVE to LOCAL-DEFAULT) is
`thatch storage pull` followed by removing the `storage` config; `pull`
refreshes the local snapshot so post-opt-in knowledge writes are not lost,
and it requires a reachable remote (or `--from-replica`, below) --
removing the config while offline, without pulling, strands the opt-in era
inside the replica file, so the user doc states the pull-first ordering.
Opt-in-era chat history is not merged back (below).

Offline warnings: sync and knowledge-write failures surface as a
rate-limited `console.error` line plus the debug log, and `thatch storage
status` reports the state, replica age, and last error on demand.

### Seeding and rollback

`thatch storage` namespace in the CLI registry (the namespace-with-children
pattern `bin/thatch:34-45` resolves). The registry itself is pinned by no
test today (`tests/cli-help.test.ts` exercises the renderer with fake
commands), so Phase 3 adds a registry test before or with the verbs.

- `thatch storage status [--url --token]` -- effective driver, url with
  masked token, env
  overrides when active, replica path and age, knowledge-table row counts
  local vs remote, the lifecycle state, and warnings (unseeded, partial --
  a non-empty remote without the marker -- offline). The flags matter in
  exactly one case: after a push dies mid-copy the machine is still
  LOCAL-DEFAULT (config is written last), so `status` can only see the
  remote it is told about -- and in that inspection-only case the state
  line reports the machine's own state plus the remote's seeded-ness
  (marker present, absent, or partial).
- `thatch storage push [--url --token]` -- verify the remote is reachable,
  create the shared schema on it (the verbs run on raw handles, so the
  facade's conditional open-time DDL does not run there; a fresh remote
  needs the tables before the first copy), copy knowledge-table rows from
  the local `thatch.db` into the remote,
  write the seed-completion marker -- a `seed_complete` row in a new shared
  `storage_meta` key-value table, created with the shared schema, absent
  from every user-facing surface (not a memory store, not rendered, and not
  part of push/pull's knowledge copy, since `push` itself is its only
  writer) -- as the copy's last step, then write the
  `storage` config, then report "shared storage active". The
  order is load-bearing: the config flips only after the seed succeeds, and
  the marker is what distinguishes a seeded remote from a partial one -- a
  push that dies mid-copy is not transactional across tables, so `status`
  warns whenever a non-empty remote lacks the marker, and the user doc says
  to re-run `push` after a failure.
  `push` refuses to run while a storage config is active: the local shared
  tables are then a frozen snapshot, and re-pushing it would insert-if-absent
  opt-in-era-deleted content back into the remote -- the pull-direction
  resurrection, in push form. The refusal message and the user doc state
  the escape in full: pull first (`--from-replica` if the old remote is
  gone), then remove the `storage` config, then push -- because removing
  the config alone does not refresh the frozen snapshot, and pushing it
  still resurrects the opt-in-era forgets as coexist rows to re-forget.
- `thatch storage pull [--from-replica]` -- copy remote knowledge-table rows
  back into the local `thatch.db`. The rollback and refresh path.
  `--from-replica` reads the replica file instead of the remote -- the
  replica is expected to be a plain SQLite database, which spike criterion 4
  pins -- and is the recovery path when the
  hosted remote is gone or unreachable.

Merge semantics, by row class: mutable rows (`entries`,
`prediction_matchers`/`predictions`, `behavior_matchers`/`behaviors`) upsert
by primary key with the newer `updated_at` winning; append-only rows
(`memory_tombstones`, `dedup_pairs`, `prediction_dedup_pairs`, edges,
provenance, `stores`) insert-if-absent; nothing ever deletes. The verbs
operate on raw handles, not the routed facade: `pull` writes the local
`thatch.db` while a storage config is active, and a facade write there
would route to `#shared` and copy the remote onto itself. Pushing into a
live remote can create the coexist state -- a live entry plus a same-label
tombstone from an earlier generation -- which already has defined behavior
locally (`clearMemoryTombstones` never touches entries,
`src/db.ts:1180-1193`), so the remote inherits it without new rules.

Chat tables are never seeded. The remote's chat tables begin empty; the
directory refills as each machine's sessions register; the local frozen
`thatch.db` keeps pre-opt-in chat history readable after rollback.
Opt-in-era chat history lives in the remote and its replicas and is not
merged back on rollback -- a documented, accepted loss (chat is
TTL-pruned coordination state, not knowledge).

One rollback hazard, documented rather than engineered in v1: an entry
forgotten during the opt-in era is absent from the remote but still live in
the frozen local snapshot, so `pull` leaves it live again alongside its
pulled tombstone -- the coexist state. The tombstone hold still guards
re-writes of that content (`src/db.ts:830-843`); the visible fix is
re-forgetting the entry. The gotchas entry and the user doc name this
before the user runs `pull`.

A fresh machine needs no push: configure url and token, and the first open
syncs the seeded remote into the replica.

### The chat cluster mapping

What the cluster gains without new chat code:

- Cross-machine delivery. A message from machine A to a session on machine B
  lands as a row in the shared `chat_messages` (`src/chat.ts:1226-1229`).
  B's poller queries `pendingChatNotifications` for its own hosted set
  (`src/chat.ts:2881-2883`); the hosted set is machine-local, the rows are
  shared, and the recipient-registered check resolves against the shared
  directory (`src/chat.ts:1699`). B's poller wake-prompts through its own
  SDK client. The host-owned delivery rule (`src/chat.ts:14-21`) is intact:
  a sender never prompts a session in another process, on any machine.
- One roster across machines. `chat_sessions` and heartbeats
  (`src/chat.ts:1770-1772`) are shared, so each machine's `chat_list` shows
  the cluster with live staleness markers. The OPEN-vs-RECENT split degrades
  honestly: liveness resolves through `chatLiveness`
  (`src/chat.ts:457-462`), and open tabs are a machine-local signal feeding
  it (`src/chat.ts:1257-1267` is where broadcast consumes them), so
  other-machine sessions read as RECENT,
  never falsely OPEN. Staleness stays honest by arithmetic: a reader's view
  of a remote heartbeat is bounded by the writer's poll interval (30s,
  `src/chat.ts:397`) plus the reader's sync period, and `isStale` fires
  past 60s (`src/chat.ts:403`, `src/chat.ts:3003-3005`) -- so the sync
  cadence must satisfy cadence + 30s < 60s, which is a tighter constraint
  than "under the threshold" alone. The guarantee assumes a long-lived
  reader on the machine: a machine in an all-one-shot moment (pure CLI,
  every session closed) reads a replica bounded only by the open-time
  best-effort sync, so a live remote session can render STALE there --
  delivery is unaffected, and the user doc says so.
- Cluster-wide name uniqueness and wake budget. The name counter draw is one
  atomic statement (`src/chat.ts:1819-1829`), which stays atomic on the
  shared remote; the wake budget table is shared
  (`src/chat.ts:1720-1754`), so the per-recipient cap counts prompts from
  every machine. The cap's count reads the replica, so a brief cross-machine
  skew can exceed it by one window's worth of prompts -- bounded, and the
  cap is an anti-loop brake, not a correctness guarantee.
- All hosts covered by one mechanism. The driver's sync timer refreshes the
  replica in every long-lived process, so the bundled-plugin regime (Claude
  Code, whose chat-wake path `computePluginChatWake` at `src/flush.ts:202`
  polls delivery reads on the mod's clock) and the standalone MCP server get
  the same cross-machine freshness as opencode's poller -- no per-host
  wiring.

What changes in chat code -- a short, named list, nothing else: the
facade's optional `syncSharedReads()`; the `chat tail` follow loop calling
it per tick; log lines at the two continuation-adoption catches
(`src/chat.ts:485-487`, `src/cli/hooks.ts:108-110`) distinguishing a
storage failure from a failed transcript walk; a stamp catch inside
`ChatStore.read()` so the read path returns rows with the `read_at` stamp
skipped when the write cannot land (`src/chat.ts:1441-1463`); the same
catch around the Stop-hook's and the bundled regime's `markDelivered`
callers (`src/cli/commands/hook-commands.ts:336`, `src/flush.ts:213`);
catches around the restore-rejoin tombstone clears
(`src/runtime.ts:774`, `src/runtime.ts:2178`); and the poller's budget
fallback -- when `recordChatWake` fails, a per-recipient time-windowed
in-process prompt count substitutes for the DB count, so the anti-loop cap
binds offline (`src/chat.ts:2921-2930`).

Verified behaviors to document and test, not change: `pruneStaleAuto`
(`src/chat.ts:1106-1137`) prunes cluster-wide after the auto-row TTL, so a
machine offline past the TTL has its directory rows reaped everywhere -- and
reclaims its names through `chat_name_claims` when it returns; unread mail
addressed to reaped sessions ages out with the same sweep, exactly as for a
dead local process today. The wake nudge itself is pointer-only
(`src/prompts.ts:1372-1380`), so no message bodies cross the wire in prompts.

Invariant, stated for the implementer: no model-executed protocol steps
anywhere in the cluster machinery. The poller, the wake budget, the
tombstone gates, and delivery are host code (`src/runtime.ts:618-629` does
the wiring). Sharing the store extends their reach; it does not add protocol
steps the models run.

### Migration idempotency hardening

There is no central migration runner today: `#initSchema`
(`src/db.ts:224-584`) calls twelve `#migrateXxx` methods -- nine guard a
column `ALTER` and one guards a `DROP COLUMN` through `PRAGMA table_info`,
the collation rebuild guards through `sqlite_master` (`src/db.ts:725-744`),
and the branch normalization is a guardless idempotent UPDATE
(`src/db.ts:705-707`) that needs no guard. The hardening lands as one
shared guarded-run helper that the guarded migrations route through,
following the existing catch-and-classify precedent (`src/db.ts:881-890`),
and it must cover every race shape in the set, not just the obvious one:

- Two machines can both read "column missing" through their replicas and
  both `ALTER`; the loser's "duplicate column name" error is idempotent
  success.
- The DROP COLUMN guard (`#migrateChatHostPid`, `src/db.ts:636-641`) races
  to "no such column" on the loser; also idempotent success.
- The collation rebuild (`src/db.ts:725-744`) is a CREATE / INSERT / DROP /
  RENAME inside a transaction; two racing rebuilds fail on "table already
  exists" or a lost DROP; the helper wraps the whole rebuild, and the
  loser's failure reads as "someone else migrated it" -- verified by
  re-running the guard's detection, not by trusting the error text alone.

## Blast radius and consumers

- Every raw-SQL call site and its callers: `src/db.ts`, `src/chat.ts`,
  `src/scoring-engine.ts`, `src/prediction.ts`, and `src/behavior.ts` type
  against `SqlDriver`; no
  SQL text changes except the one rewrite the split section names --
  `findSessionByHostPid`'s join becomes two steps, a behavior-relevant
  change to the host-pid identity anchor's resolution that belongs in SQL
  review. `src/tool-defs.ts` calls the facade only and changes
  only where the config tools render the new section.
- `ThatchDB` consumers: the CLI dispatcher (`bin/thatch:101-103`), the MCP
  server (`src/mcp.ts:184`), the opencode runtime (`src/runtime.ts:275`).
  Construction gains an optional storage parameter; behavior for the
  default config does not change.
- One-shot processes DO open the driver: the dispatcher constructs
  `ThatchDB` for every subcommand including the hook commands, and the hooks
  use it directly (`src/cli/commands/hook-commands.ts:133`, `:162`, `:168`).
  The sideband (`src/mcp.ts:165-168`) spares them the embedding model, not
  the database. This is why open-time behavior is reworked (above) and why
  the offline constructor contract is load-bearing.
- The config surface: the schema, section list, and merge machinery in
  `src/config.ts` (`tests/config.test.ts` extends), plus the three
  hand-rolled tool-defs surfaces listed in the configuration section, plus
  tool tests including a masked-token assertion.
- The chat roster, `chat tail`, and every chat tool reader: they now see
  cluster-wide rows through the shared store. No reader code changes;
  `thatch mcp` opens two `ThatchDB` instances in one process
  (`bin/thatch:101` then `src/mcp.ts:184`), which the spike exercises as the
  two-clients-one-replica-path shape.
- The nudge hot path: per-prompt search reads the replica, local and fast;
  knowledge writes on opted-in machines require connectivity; the
  maintenance writes degrade silently and the loop-control and
  delivery-accounting writes fail safe per the classification table in the
  driver section.
- The SharedModelPool stays keyed on the `thatch.db` path
  (`src/embeddings.ts:170-203`); pin that so nobody keys it on the replica
  path and double-loads the model.
- QA surfaces that open `thatch.db` raw with `bun:sqlite` (among them
  `tests/qa/auto/uc-008`, `uc-058`, `uc-081`, `uc-088`, `uc-089`, `uc-097`,
  `uc-099`, `uc-100`, `uc-102`, `uc-104`, `uc-117`, `uc-122`, `uc-128` --
  the schema-creation
  and column-migration use cases assert the single-file layout itself, so
  they break first; the live `tests/qa/live/opencode/uc-098` opens the db
  raw too) assume the chat
  tables live in that file -- true in default mode, false under libsql.
  Storage-mode QA variants must target the replica path, and the
  containerized QA image must gain the libsql client dependency before
  storage-mode QA can run in it.
- The README pitch (`README.md:10-11`) gains an opt-in companion sentence
  (wording is an open question). The default promise is untouched.
- `src/session-db.ts` reads opencode's own database, not thatch's, and is
  unaffected.

## The spike (Phase 0) and its pass/fail criteria

One working day, timeboxed. Setup: a throwaway hosted database (Turso free
tier), plus a self-hosted libsql server as the fallback endpoint. Runtime:
Bun as pinned by mise, checked against the newer Bun the CI matrix also
gates.

Pass requires every criterion:

1. Package: the synchronous libsql client (repo `tursodatabase/libsql-js`;
   the spike pins the npm package name and version) installs and loads under
   Bun, and its API covers `query`/`get`/`run`/`exec`/`transaction`/`close`
   in every binding form the call sites use (array, varargs,
   spread-varargs, zero-argument) -- and its plain local-file mode works,
   because the network-free driver-contract tests in Phase 3 run against
   it.
2. Schema: `ThatchDB` opened through the libsql driver creates the
   shared-table schema and runs every migration against the remote without
   error; `PRAGMA table_info` and the `sqlite_master` read work; a second
   open is a no-op that performs no remote writes; two concurrent opens do
   not corrupt (the guarded-run hardening is verified here, including the
   DROP and rebuild shapes).
3. SQL idioms behave identically to `bun:sqlite`: `ON CONFLICT DO UPDATE`
   with `COALESCE` (`src/db.ts:908-923`), `IN (VALUES ...)` row tuples
   (`src/db.ts:1008-1011`), `COLLATE NOCASE` uniqueness (`src/db.ts:411`),
   `RETURNING` (`src/chat.ts:1825`), `changes()` (`src/db.ts:1191`),
   `strftime` defaults (`src/db.ts:256-257`), deferred and `BEGIN IMMEDIATE`
   transactions (`src/db.ts:831`, `src/db.ts:1106`), savepoint nesting of
   transaction functions (`src/scoring-engine.ts:292-295`; the tool layer
   wraps engine transactions at `src/tool-defs.ts:1095` and `:1290`), and
   Float32 embedding
   BLOB round-trips (`src/db.ts:864`). Constraint-violation errors surface
   in a shape the existing `CONSTRAINT`-keyed catches recognize
   (`src/db.ts:882`, `src/chat.ts:1863-1865`), or the adapter maps them --
   otherwise the friendly label-collision arm and the register retry loop
   degrade to thrown host errors.
4. Replica: embedded-replica mode serves reads from the local replica file;
   a sync applies remote deltas; a write-through write from one client is
   visible to a second client's replica after its sync, and visible to the
   same client immediately after it returns (read-your-writes); and reads
   issued inside a transaction hit the remote under both spellings --
   `transaction(fn)` and the raw `exec` BEGIN ... COMMIT span -- so a
   forget committed by another client between the last sync and the
   transaction is visible to the in-transaction tombstone check and to
   forget's under-lock row read. The replica file also opens with a raw
   `bun:sqlite` connection and reads the full shared schema (the
   `pull --from-replica` dependency).
5. Concurrency: two processes sharing one replica file path on one machine,
   two replica files against one remote (the two-machine shape), and two
   clients on one replica path in one process (the `thatch mcp` shape) all
   serialize writes without corruption; two processes passing the
   last-sync-age gate together and syncing the same replica file
   concurrently (the gate is check-then-act) do not corrupt it, or the
   adapter holds a machine-local lock around the sync; a read on the
   replica file concurrent with another process's sync on the same file
   behaves like today's WAL readers (no corruption, no error); contention
   surfaces as `SQLITE_BUSY`-shaped errors caught by `isBusyError`
   (`src/db.ts:56-59`).
6. Pragmas: `foreign_keys` enforcement is confirmed on the remote path; the
   local-only pragmas (`journal_mode`, `busy_timeout`) are no-ops or handled
   by the client without error.
7. Offline and error mapping: opening against an unreachable remote with a
   replica present succeeds for reads from the replica and fails knowledge
   writes with a typed error; network and auth failures are distinguishable
   from `SQLITE_BUSY`-shaped contention; a first open offline with no
   replica yet does not throw -- reads return empty with a warning,
   knowledge writes return the typed failure, and nothing hangs or
   corrupts local state.

Fail on any criterion: the remote-driver design stops, and the failing
criterion plus evidence goes to Jeff. Phases 1 and 2 do not proceed on a
failed spike -- their value is the boundary a working second driver pays
for.

## Phases and gates

Each phase is a separately reviewable, separately mergeable unit; each gate
is explicit.

- Phase 0 -- the spike. Gate: all seven criteria pass.
- Phase 1 -- the `SqlDriver` boundary. A type-level refactor: extract the
  interface with the callable-returning `transaction` member, type the
  engines and `ThatchDB` against it, no behavior change. Gate: the full
  existing test suite passes with no test edits.
- Phase 2 -- local/shared routing. The two handles, the partitioned
  `#initSchema`, `ChatStore` taking both handles, the two-step host-pid
  resolution, the per-statement routing for `continueSession`. Gate: the
  existing suite green (one mechanical test edit allowed: the direct
  `ChatStore` construction in `tests/chat-poller.test.ts:1087` gains the
  second handle argument); a new test proves the default config still
  produces one file with every table; the routing tests land here too --
  machine-local statements land in `thatch.db`, shared statements land in
  the driver's target, exercisable pre-libsql by passing the storage
  parameter directly to the `ThatchDB` constructor with `#shared` pointed
  at a second local file -- because in default
  mode the two handles are one object and nothing else can catch a
  misroute.
- Phase 3 -- the libsql driver, config surface, CLI verbs, migration
  hardening, open-time rework. Gate: driver-contract tests pass against both
  drivers over file-backed databases (network-free, using the libsql
  client's local file mode); the env-gated remote integration test passes
  when `THATCH_TEST_REMOTE_URL` is set; `storage status/push/pull` tests
  against a local libsql file standing in for the remote; the registry test
  pins the new namespace; the config tool tests cover the four surfaces
  including the masked token; the migration-hardening tests (all three race
  shapes) and the open-time tests (conditional schema, offline
  construction, write classes, never-downgrade seeds) pass.
- Phase 4 -- cluster verification, QA, docs. Gate: `mise run qa-auto` green
  including the new auto use cases (config resolution, default-path
  invariance, offline knowledge-write failure); the live QA use case below
  passes; both doc tiers updated; `mise run lint-md` clean.

Rollback: every phase lands behind the default config, which never changes;
a user who opted in rolls back with `thatch storage pull` plus removing the
`storage` section. A release that ships any phase is safe for every default
user by construction.

## Testing and QA

- Driver-contract tests: one test file asserts the same behaviors against
  both drivers over file-backed databases -- no network in CI. The libsql
  client's local-file mode is the second driver's test harness, covering
  every binding form and both transaction paths (deferred default, raw
  `BEGIN IMMEDIATE` pass-through).
- Routing tests: machine-local statements land in `thatch.db`, shared
  statements land in the driver's target, `continueSession`'s mixed writes
  split correctly, and the two-step host-pid resolution finds sessions that
  exist only in the shared handle. A default-layout test proves the
  no-storage config still produces one file containing every table -- the
  routing split is invisible to every existing test under the default
  config, so this test is the only thing that catches a misroute into two
  files.
- Open-time tests: the conditional schema guard skips remote writes when the
  schema is current; construction against an unreachable remote serves
  replica reads and fails knowledge writes; every row of the write
  classification table holds in its failure mode (in-band chat failures,
  the time-windowed prompt-count fallback binding offline -- a small
  pending batch must not re-deliver every cycle -- the read path returning
  rows with the stamp skipped, maintenance writes degrading silently); the
  seeded-behavior never-downgrade rule holds.
- Config tests: section merge semantics in `tests/config.test.ts`; the four
  tool surfaces in the `tests/notify.test.ts:331-523` pattern including the
  masked token; resolution precedence (env over file, absent means local)
  in `resolveStorage`.
- CLI tests: the registry/namespace test; `storage status/push/pull`
  behavior against a local libsql file standing in for the remote.
- Migration hardening tests: all three race shapes (duplicate column, no
  such column, already-exists rebuild) treated as idempotent success.
- Remote integration test, env-gated (`THATCH_TEST_REMOTE_URL`,
  `THATCH_STORAGE_TOKEN`): full schema plus idioms plus replica convergence
  plus two-client write serialization plus the offline and error-mapping
  behaviors. Skipped silently without the env, so the default gate stays
  network-free.
- QA auto use cases: storage config resolution and default-path invariance
  (a machine with no storage config behaves exactly as before); offline
  knowledge-write failure (an unreachable url makes `remember` return the
  clear error and nothing is written).
- QA live use case: the two-machine simulation on one box -- two config
  homes with separate `thatch.db` and replica files against one scratch
  remote; sessions registered on both sides; a cross-machine `chat_send`
  delivers through the "remote" machine's poller; a memory written on one
  side recalls on the other. The scratch remote is provisioned the same way
  as the env-gated integration test (a self-hosted libsql server or a
  hosted scratch database via the test env), and the use case states which.
  Honest label: simulated two machines, not two
  physical laptops.

## Docs touch points

- `docs/dev/features/database.md` -- the driver boundary, the table split,
  and the PRAGMA differences replace the "single SQLite file" framing of the
  Configuration section.
- New `docs/dev/features/shared-storage.md` -- driver architecture, replica
  and sync model, the write classes, the offline contract, seeding and
  rollback, the cluster mapping, the lifecycle states.
- New `docs/user/shared-storage.md` -- what sharing does, how to opt in with
  `push`, what stays local, and the limitations: offline knowledge writes
  fail, freshness is sync-lagged (and a machine with no long-lived process
  can render live remote sessions as stale), the design assumes one user,
  both machines
  must run the same thatch version and the same embedding model and backend
  (`THATCH_EMBEDDING_BACKEND`, default wasm), rollback
  ordering (pull before removing the config), the resurrection of opt-in-era
  forgets after pull, chat
  history does not merge on rollback, and self-hosting a libsql server is
  the exit from hosted terms.
- `docs/user/cross-session-chat.md` and
  `docs/dev/features/cross-session-chat.md` -- both state machine-only scope
  today ("Same machine only... no network relay"; "on one machine"); opted-in
  users make those sentences false, so both tiers gain the shared-store
  branch.
- `README.md` -- the opt-in companion sentence after the existing promise
  (`README.md:10-11`), and the Privacy section (`README.md:95-101`,
  "Everything is local... no data leaves your machine") gains the
  opted-in-storage exception alongside the existing `gh` watcher exception.
- `docs/user/README.md` -- the Privacy bullets (`docs/user/README.md:544-548`,
  "All data stays on your machine... Nothing is sent to any service") gain
  the opt-in branch, and the feature index (`docs/user/README.md:14-28`)
  gains the shared-storage entry.
- `docs/dev/features/README.md` -- the docs table gains the
  shared-storage entry.
- `docs/dev/gotchas.md` -- the unseeded-config blank-read window, the frozen
  local snapshot after opting in, the rollback chat-history loss, the
  rollback resurrection of opt-in-era forgets, and replica-file salvage when
  the hosted remote is gone.
- `docs/dev/README.md` -- the module map gains `src/storage.ts` and the CLI
  namespace.
- `docs/dev/mcp-parity.md` -- no parity change: the driver is host-agnostic
  and the sync timer covers every host's long-lived processes; state that
  explicitly so the matrix is not left implying a gap.

## Intent breadcrumbs

The comments the implementation writes, and the future-reader question each
answers:

- `SqlDriver` doc comment: why the interface is synchronous-only (the whole
  call graph is synchronous; an async driver would be a refactor of every
  caller, not a swap), and why `transaction` returns the callable (bun's
  signature and the five call-through sites).
- The libsql adapter doc comment: why writes are write-through (the remote
  is the serialization point, so the write-lock-first forget keeps its exact
  semantics), why ordinary reads are replica-local (the per-prompt
  brute-force search must not pay a network round trip) while in-transaction
  reads are remote (the tombstone hold must see the remote's current
  ledger), and why the transaction begin-modes must not be "improved"
  (`remember`'s retry
  semantics depend on deferred plus the busy catch).
- `#open` comment in `src/db.ts`: the two-handle split; why `chat_host_pids`
  can never share (a pid on machine A is an unrelated pid on machine B); why
  schema work is conditional under the remote driver (one-shot processes and
  offline opens).
- The write-class comment: which writes may degrade silently and which must
  fail loud, and why recall telemetry is not worth failing a read over.
- The sync-timer comment: why the cadence satisfies cadence + the writer's
  poll interval < the chat staleness threshold, and why the gate is the
  replica file's age (machine-wide pull bounding).
- The two-step host-pid resolution comment: why the join split (a join
  cannot span two handles; the anchor must resolve against the live shared
  directory).
- The `storage` config comment: `push` writes the config last, so a
  half-configured machine never reads blank shared stores.
- The guarded-run migration comment: the three race shapes and why the
  loser's error is success.

## Dependencies

- One new runtime dependency: the synchronous libsql client. The spike pins
  the package name and version, and validates that its bindings load under
  both Bun versions the project gates. It is the first runtime dependency
  with native bindings beyond the already-present ONNX stack.
- `zod` (already present) extends for the `storage` config section.
- The remote database is the user's operational dependency (a hosted Turso
  database or a self-hosted libsql server), not a package dependency; the
  default install path gains nothing.

## Risks and accepted risks

| Risk | Mitigation |
|------|------------|
| libsql client health and post-acquisition hosting terms are unconfirmed | The driver speaks the libsql protocol, so any endpoint works, including a self-hosted libsql server; the spike pins the version; the user docs name self-hosting as the exit. |
| Hosted dependency class (quota, pausing, support surface) that the README today promises never exists | Opt-in only; data leaves the machine only through an explicit `push`; the README companion sentence states the default promise unchanged; sync volume is one machine-gated sync per freshness window plus one batched heartbeat write per poll cycle per hosting process, and the user docs point at the provider's quota page instead of promising a number. |
| Offline knowledge writes fail (v1 posture) | Loud typed error naming the remote; the failure string is agent-readable so a session retries rather than assuming success; the local write queue is the named future extension. Pending Jeff's sign-off (open question 2). |
| Freshness lag for chat (sync period plus poll interval) | Documented; the sync cadence satisfies cadence + the writer's poll interval (30s) < the staleness threshold (60s), defaulting to 15s, so live remote sessions do not read STALE; the wake machinery already tolerates delayed delivery through the re-nudge timer and budget; `status` reports replica age. |
| Clock skew between machines | Timestamps are client-generated ISO strings (`src/chat.ts:49-59`, `src/db.ts:871`) except where a schema `strftime` default fills a column the writer omits -- `chat_machinery.created_at` (`src/chat.ts:1044-1046`, default at `src/db.ts:513`) evaluates on the remote's clock under libsql and is TTL-pruned against a client-generated cutoff (`src/chat.ts:1135`); harmless at NTP-typical skew. The skew-sensitive rules are `updated_at`-wins on mutable-row push collisions, chat staleness (a 60s comparison over the writer's `last_seen`), the rolling wake-budget hour, and the re-nudge cutoff; NTP-typical skew sits far below all of them, and the research judged last-writer-wins skew tolerable for this data. |
| A post-forget write on the other machine resurrects deleted content | Guarded by routing, not by hope: the tombstone check is a read inside the write transaction (`src/db.ts:830-843`), and the adapter routes in-transaction reads to the remote -- a stale-replica read there would be exactly the resurrection window. The push path copies ledger and entries together, and the coexist state has defined behavior (`src/db.ts:1180-1193`). |
| Migration races between machines | The guarded-run hardening covers all three race shapes; verified as spike criterion 2. |
| Seeded-behavior version ping-pong between machines on different thatch versions | The never-downgrade rule (a machine seeds only at or above the store's stamped version); the user doc states the same-version requirement. |
| An older thatch build ignores the whole config file once `storage` exists | Documented same-version requirement; the degradation is a warning line in the older process's log, not silent data loss. |
| Env overrides are per-process; mixed env/file resolution on one machine splits the store | `thatch storage status` reports when env overrides the file; the user doc warns. |
| Embedding-model divergence across machines silently skips entries | Documented same-model requirement, extended to the backend knob (`THATCH_EMBEDDING_BACKEND`, default wasm) -- a same-id model on a different backend can drift cosine scores without tripping the dimension skip; the dimension-discriminated skip is existing behavior (`src/db.ts:982-987`) and degrades rather than corrupts. |
| Rollback loses opt-in-era chat history | Accepted and documented (chat is TTL-pruned coordination state, not knowledge); the user doc states it before the user runs `pull`. |
| Rollback can resurrect an opt-in-era forget | The forgotten entry stays live in the frozen local snapshot while absent from the remote; `pull` leaves it live beside its pulled tombstone (the coexist state). The tombstone hold still guards re-writes; the user doc names the re-forget fix before `pull` runs. |
| The hosted remote dies permanently (vendor loss, quota purge) | The replica file is expected to be a plain SQLite database holding the full shared schema (spike criterion 4 pins it); `thatch storage pull --from-replica` recovers from it without the remote; the user doc documents direct file salvage as the floor. |
| Default-path regression | Phases 1 and 2 are pure refactors gated on the untouched existing suite; a QA auto use case asserts default invariance after Phase 3. |

## Open questions for Jeff

1. Hosted Turso or a self-hosted libsql server for the two laptops? This is
   a posture call as much as an ops call; the driver works with either.
2. Is the offline-knowledge-writes-fail posture acceptable for v1, or should
   the feature wait for a local write queue?
3. The README companion sentence wording -- the existing promise stays, but
   the opt-in sentence is the public posture and belongs to Jeff.
4. Should the roster show which machine a session lives on? A small
   `chat_sessions` schema addition (a host label captured at registration);
   useful for cluster legibility, but it is shared-table schema churn and
   goes nowhere without a yes.
5. Should the `storage` section's `authToken` be settable through
   `config_set` -- a model tool call -- or restricted to `push` flags,
   hand-editing, and env? The render is masked either way; this is a
   trust-boundary call.

## Out of scope

- Team stores and any multi-user identity, permissions, or row-level
  security -- the Supabase-Postgres value; a different product decision.
- A local write queue (offline knowledge writes); named as the future
  extension.
- `thatch backup` -- the research's separate, cheaper recommendation for the
  one real gap it found; not this plan.
- cr-sqlite (CRDT sync) and the Turso Sync product; the embedded-replica
  client is the evaluated path.
