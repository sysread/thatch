# Opt-in shared storage: driver-style database backends

## Synopsis

ThatchDB goes through a driver/client pattern: its methods call
`get_client()`, which caches the client and builds it from config on first
use. Absent config (or `sqlite`) is today's behavior, exactly. Driver 2 is
Supabase (Postgres), which shares one knowledge store -- entries,
predictions, behaviors, and the chat directory -- across machines for one
user, and turns the chat tables into a cross-machine cluster substrate.
Milestone 1 is the wrapper refactor: the client seam exists with sqlite as
the only driver, behavior-preserving. Driver 2 follows behind its own
spike, and it must cross two walls head-on: Supabase's client is async-only
while thatch's entire call graph is synchronous, and the SQL dialects
differ. Local stays the default; the README gains Jeff's line: "private and
local by default, with an option to bring your own storage."

## Reviewer orientation

Start at "The driver boundary" for Jeff's client pattern and milestone 1,
then "The two walls" for the async and dialect evaluation that shapes
driver 2, then "The supabase driver" for the remote architecture, then "The
chat cluster mapping" for why the chat semantics survive unchanged.
Milestone 1 needs no spike -- it is a pure refactor gated on the untouched
suite. Driver 2 stands behind a spike whose criteria decide whether a
synchronous bridge to Supabase is real. Nothing in this plan is implemented
yet.

## Background

The requirements record is Jeff's ruling (2026-11-12, relayed by the
coordinating session):

- The driver pattern, verbatim intent: "we don't need to worry about
  routing or the network or anything. we just need some kind of
  interface/driver pattern, so that thatch does something like: calls
  db.do_stuff() -> calls db.get_client() which caches -> (not cached) builds
  client from config. from thatch's perspective, it's calling the same
  thing either way." Config decides the backend: absent = sqlite (the
  default), explicit sqlite = the same, or `supabase` (and future drivers).
- Milestone 1 = the wrapper refactor, sqlite-only, behavior-preserving.
  Supabase is driver 2, after that.
- The target is supabase.com ("essentially just hosts a pg in the sky"),
  not Turso. The sync/async wall is confronted head-on, not routed around.
- Config pattern: "each thatch client would be configured locally with env
  vars maybe (iirc opencode has some provider config patterns that let you
  inject env vars into the config by symbol/reference we could reuse for
  thatch config)." The storage section references env vars by symbol; the
  credentials stay in the environment.
- Machine label in the roster: approved. A config-set name per machine,
  defaulting to the hostname.
- README wording, decided: "private and local by default, with an option to
  bring your own storage."
- Offline: fail loudly stands. (The embedding model is local anyway -- the
  offline constraint is only the remote connection.)

A research pass (2026-11-10,
`~/.local/state/thatch-coordinator/external-storage-research-findings.md`)
and a full refinement run on the pre-ruling plan shape the load-bearing
facts. The research's verdict was "No need justifies live external
storage today"; Jeff's two-machine request is the first named
change-trigger realized. The architecture facts all hold:

- The database call graph is synchronous `bun:sqlite` end to end: every
  raw-SQL site in `src/db.ts`, `src/chat.ts`, `src/scoring-engine.ts`, and
  `src/prediction.ts`, plus every caller -- tools,
  the chat poller, the CLI, one-shot hook processes, and the sideband
  socket protocol. (`src/behavior.ts` holds no SQL of its own -- it
  delegates to `ScoringEngine` -- but its constructor takes the client and
  joins the milestone-1 seam. `src/tool-defs.ts` holds no raw SQL; it calls
  the ThatchDB facade, plus the `SessionDB` facade for opencode's own
  database.)
- supabase-js officially supports Bun, but is async-only. There is no
  synchronous Postgres client for Bun.
- The SQL is SQLite-native: `PRAGMA table_info` migration guards
  (`src/db.ts:590-696`), `sqlite_master` schema detection
  (`src/db.ts:725-744`), `strftime` defaults (`src/db.ts:256-257`),
  `changes()` (`src/db.ts:1191`), `IN (VALUES ...)` row tuples
  (`src/db.ts:1008-1011`), `COLLATE NOCASE` uniqueness (`src/db.ts:411`).
  The migration machinery has no Postgres equivalent -- there is no
  dual-dialect path for the schema layer.
- Store keys (`owner/repo` parsed from the git remote, `src/git.ts:239-248`
  and `src/git.ts:31-40`) are machine-independent: two machines cloning the
  same repo converge on the same store identity.
- Embeddings are deterministic from content (a pinned local BGE model,
  `src/embeddings.ts:218`), so two machines running the same model produce
  identical vectors.
- The tombstone hold (every `remember` checks the delete ledger inside the
  write transaction, `src/db.ts:830-843`) is the invariant that makes
  deliberate deletes stay deleted. Under a remote driver the check and the
  write serialize at the remote, inside one remote transaction -- stronger
  than any local-first scheme, with no client-side merge machinery.
- Supabase specifics from the research record: pgvector is included free
  on all plans; free-tier projects auto-pause after 7 days of inactivity,
  which makes the free tier a poor dependency for intermittent dev-machine
  sync.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Driver pattern per Jeff's sketch: `get_client()` caches, config builds | Milestone 1 lands the seam with sqlite as the only driver, behavior-preserving, gated on the untouched suite. From ThatchDB's perspective nothing changes; the config decides the backend. |
| Driver 2 is Supabase (Postgres), and the two walls are crossed inside the driver, not through the codebase | The async wall: supabase-js is async-only, the call graph is synchronous. The dialect wall: the schema machinery is SQLite-native. Both are driver-2 problems. The recommended crossing is a synchronous facade over an async engine inside the supabase driver (see "The two walls"), so no caller changes. |
| The driver interface rises to the operation level for driver 2 | Raw SQL cannot serve a Postgres driver (no dual-dialect path for `PRAGMA`/`sqlite_master`). The port boundary becomes ThatchDB's method set: each driver implements the operations in its own dialect. The sqlite driver is the extracted current SQL -- mechanical, no behavior change. Milestone 1's raw-SQL client seam remains for the machine-local tables, which are always sqlite. |
| Remote-primary for shared tables; no local replica in v1 | The remote database is the serialization point -- the tombstone check, transactional upserts, the atomic name draw, and the cluster-wide wake budget all keep their exact single-database semantics. A local read cache is a possible later optimization, not v1; Jeff ruled offline fails loudly, and a cache would only soften reads. |
| Offline: shared reads and writes fail loudly; local-only features unaffected | Jeff ruled. Simpler than a replica: no sync cadence, no staleness arithmetic, no offline read cache to keep coherent. The poller already catches store errors per cycle and retries (`src/chat.ts:2782-2786`). |
| Table split: shared tables vs machine-local tables | `runtime_state` rows are pid-scoped (`src/db.ts:537-547`); `repo_paths` caches absolute local paths (`src/db.ts:1607-1629`); `chat_host_pids` maps local process ids to sessions (`src/db.ts:523-529`) and a pid on machine A collides with an unrelated pid on machine B. These stay in local sqlite under every driver. |
| Predictions and behaviors share across machines | The research called sharing them semantically wrong for teams, where predictions model one user and behaviors model one agent. For the same user on two machines, sharing is semantically right: one decision model, one discipline rule set, converging from both laptops. |
| Chat tables share; no chat machinery redesign | The chat tables are already inter-process shared state by design (`src/chat.ts:11-13`); machine-wide to cluster-wide is a store swap. The delivery rules, the wake machinery, and the store's SQL are untouched; a short named list of small catch-site additions is in the cluster mapping. The host-owned delivery rule is preserved: only the machine that hosts a session delivers its mail. |
| Seeding and rollback move knowledge tables only; chat tables are never seeded | `chat_messages` ids are per-database `AUTOINCREMENT` (`src/db.ts:433`) and `chat_wakes` has no primary key (`src/db.ts:455-459`) -- no merge-safe keys across machines, and no need: the remote's chat tables start empty and refill as machines register and talk. |
| Config gains the `{env:VAR}` substitution pattern, opencode's semantics | Thatch's config has no substitution today (`loadConfig` parses the JSON directly, `src/config.ts:94-112`); opencode substitutes `{env:VAR}` and `{file:path}` in the raw config text before parsing, with missing variables substituting empty (`opencode/packages/core/src/config/variable.ts:26-38`). The storage section references credentials by symbol; the values stay in the environment. Substitution runs config-wide at load, matching opencode, so there is one config-loading behavior. |
| Machine label in the roster: approved | A `chat_sessions` column set at registration from a per-machine config name (default: hostname). Shared-table schema churn, accepted by Jeff's ruling. |
| README: Jeff's sentence | "private and local by default, with an option to bring your own storage." |
| Milestones as gates, driver 2 behind its own spike | Milestone 1 needs no spike (pure refactor). Driver 2's spike decides whether the synchronous bridge is real; if it fails, milestone 1 stands alone and the failure evidence goes to Jeff. |

### The two walls (the head-on evaluation Jeff asked for)

**Wall 1 -- async.** supabase-js is async-only; every database call and
every caller in thatch is synchronous. The options:

- (a) Async refactor through the codebase. Every raw-SQL site's caller
  chain -- tool execute functions, the chat poller, the CLI dispatcher,
  one-shot hook processes, the sideband socket protocol -- becomes async.
  This is the research's "hidden dominant cost": the entire codebase, not a
  driver. It also makes every one-shot hook process an async networked
  client. Rejected as the primary path: it spends the whole codebase to
  avoid a bridge that can live inside one driver.
- (b) Synchronous facade over an async engine, inside the supabase driver.
  The driver's methods block while an async client runs across a boundary.
  Zero caller changes; the call graph stays synchronous. The bridge shapes:
  a Bun `worker_threads` worker (risk: thatch already avoids worker_threads
  because of known Bun shutdown crashes -- `src/embeddings.ts:106-108`
  names it), a dedicated connection process per ThatchDB instance, or a
  machine-local connection daemon over a Unix socket (the sideband
  precedent: `src/mcp.ts:165-168` exists so cheap one-shot processes share
  one warm server's expensive resources). The spike picks the shape; the
  crash history biases toward the process/daemon shapes. Recommended.
- (c) Hybrid, per call class. Reads stay local sqlite and replicate
  asynchronously; writes go remote. This is the local-first replication
  design the research evaluated -- it reintroduces the merge machinery
  (last-writer-wins, merge-time tombstone re-checks, counter max-merges)
  that remote-primary exists to avoid. Rejected; noted because it is the
  fallback if the spike kills every bridge shape.

Recommendation: (b). The (a)-vs-(b) choice is not genuinely forked -- (b)
preserves the whole synchronous architecture and confines the cost to the
driver -- but the bridge SHAPE (worker, process, daemon) is the spike's
first output, and if every shape fails, (c) or (a) comes back to Jeff.

**Wall 2 -- dialect.** The migration machinery is SQLite-native
(`PRAGMA table_info`, `sqlite_master`), and the idiom list above has no
Postgres equivalent as-is. There is no dual-dialect path. Therefore the
driver interface for shared tables rises to the operation level:
ThatchDB's method set (memory, tombstone, dedup, prediction, behavior,
chat-store operations) becomes the port boundary. The sqlite driver is the
extracted current SQL -- a mechanical move, no behavior change. The
supabase driver implements each operation in native Postgres: its own
schema (a migration-version table replaces PRAGMA probing), pgvector for
the embedding columns, server-side similarity for search. The one
near-portable statement is the name-counter draw --
`INSERT ... ON CONFLICT ... RETURNING` exists in Postgres too
(`src/chat.ts:1819-1829`) -- but it lands in the supabase driver as native
SQL like everything else.

A note on the SQLite-native remote (libsql/Turso): it was the pre-ruling
direction -- a synchronous client that dodges both walls -- and it remains
a valid future driver precisely because the operation-level interface makes
drivers cheap to add. It is not the ask; it stays in this plan only as
recorded analysis.

## Architecture

### The driver boundary (milestone 1)

Jeff's pattern, concretely: `ThatchDB` holds a lazily-built, cached client.
Every method that touches shared tables obtains it through
`get_client()`, which builds from the resolved config on first use and
returns the same instance afterwards. Absent config, or `driver: "sqlite"`,
builds the `bun:sqlite` handle on `thatch.db` -- today's exact behavior.
Milestone 1's resolution is the constructor storage parameter only:
until Milestone 2 Phase 2 lands `resolveStorage`, the substitution pass,
and the config schema, `get_client()` treats config as absent and always
builds sqlite -- which is exactly the behavior-preserving milestone-1
gate.

The client seam for milestone 1 is the raw-SQL surface the call sites
already use:

```ts
export interface SqlClient {
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

Shape notes that are load-bearing (all verified in the pre-ruling
refinement run):

- The statement-level `run` exists because `runtimeStatePut` and
  `runtimeStateDelete` call `.query(...).run(...)` (`src/db.ts:1478-1483`,
  `src/db.ts:1488`).
- `transaction` returns the callable, not the result: `bun:sqlite`'s
  `Database.transaction(fn)` returns a wrapped function, and five engine
  call sites invoke the returned closure (`src/chat.ts:980`,
  `src/chat.ts:1207`, `src/chat.ts:1349`, `src/scoring-engine.ts:303`,
  `src/scoring-engine.ts:375`), as does ThatchDB's own facade
  (`src/db.ts:1679-1682`).
- Transaction begin-modes must not be "improved": bun's `transaction()` is
  DEFERRED and `remember` depends on that (the busy/snapshot conflict is
  caught as a failure arm, `src/db.ts:831`, `src/db.ts:844-852`), while
  `forgetEntry` deliberately issues raw `BEGIN IMMEDIATE`
  (`src/db.ts:1106`). Raw `exec` passes through untranslated.
- Nested transactions compose via savepoints today
  (`src/scoring-engine.ts:292-295`); the tool layer wraps engine
  transactions inside facade transactions (`src/tool-defs.ts:1095`,
  `src/tool-defs.ts:1290`). Any adapter must reproduce this.
- The call sites use several binding forms: array (`src/db.ts:878`),
  varargs (`src/db.ts:1483`), spread-varargs (`src/chat.ts:1702`), plus
  zero-argument queries.
- The `ThatchDB` constructor's storage parameter is OPTIONAL, defaulting
  to sqlite, so every existing test construction site keeps its call
  shape.

When driver 2 arrives, the shared-table seam rises to the operation level
(the `StoreBackend` interface below); the raw-SQL client seam remains for
the machine-local tables, which are always sqlite -- and the local
schema's own migration machinery routes wholesale to `#local`, including
the collation rebuild's facade-transaction call (`src/db.ts:730`), which
would otherwise throw under a remote driver.

### Shared and machine-local tables

ThatchDB holds two clients after milestone 1:

- `#local`: a `bun:sqlite` database on `thatch.db`, always. Serves the
  machine-local tables.
- `#shared`: the driver. With the default config it is the same
  `bun:sqlite` handle on the same file -- today's exact single-file
  layout, so no default user migrates anything. With `driver: "supabase"`
  it is the supabase driver.

| Routing | Tables | Why |
|---------|--------|-----|
| Shared | `stores`, `entries`, `dedup_pairs`, `memory_tombstones`, `prediction_*`, `behavior_*`, `prediction_dedup_pairs`, `chat_sessions` (gaining the machine-label column), `chat_messages`, `chat_wakes`, `chat_name_counters`, `chat_name_claims`, `chat_leave_tombstones`, `chat_machinery`, `storage_meta` (new: the seed-completion marker's key-value home) | The data a second machine needs to be "the same thatch": memories, the user model, the agent discipline rules, and the chat directory. |
| Machine-local | `runtime_state`, `repo_paths`, `chat_host_pids` | Pid-scoped state, absolute local paths, per-machine process anchoring. |

Routing is per statement, not per method. Two ChatStore methods make that
explicit:

- `continueSession` (`src/chat.ts:1549-1558`) writes `chat_host_pids` at
  `src/chat.ts:1556` alongside shared-table writes; the host-pid statement
  routes local, the rest route shared. No atomicity is lost (the method has
  no wrapping transaction today).
- `findSessionByHostPid` (`src/chat.ts:1527-1537`) joins `chat_host_pids`
  with `chat_sessions` in one statement; under split clients it becomes
  two steps -- the pid row from the local client, the session row from the
  shared client -- keeping the MCP identity anchor resolving against the
  live shared directory.

ThatchDB's own shared-table statements (the `remember`/`forgetEntry` write
paths, recall telemetry, tombstone and dedup methods) and its public
`transaction()` route to `#shared`; the `runtimeState*` and `repoPath*`
methods route to `#local`. In default mode the two clients are one object,
so nothing in the existing suite can catch a misroute -- the routing tests
are the catcher.

`close()` drops both clients as one unit; in default mode they are the
same object and close must not double-close. The lazy-reopen accessors
(`src/db.ts:165-189`) keep their rebuild-on-reopen behavior.

Under milestone 1 (sqlite only) `#open()` keeps today's eager behavior --
schema DDL, migration guards, and the two unconditional writes
(`src/db.ts:446`, `src/db.ts:706`) -- because it is all local and cheap.
Driver 2's open behavior is part of its own section.

### The supabase driver (milestone 2)

- **The StoreBackend interface.** The operation-level port: the shared-table
  method set of ThatchDB and its engines (memory CRUD, search, tombstone
  and dedup operations, prediction and behavior operations, the chat-store
  operations). The sqlite implementation is the extracted current SQL.
  The supabase implementation is native Postgres per operation.
- **The bridge.** The sync facade over the async supabase client, in the
  shape the spike picks. The facade's methods block until the async side
  answers or a bounded timeout expires -- the timeout is mandatory
  because the facade runs inside the opencode server process, where a
  blocked call freezes every session in the host: a paused free-tier
  project (the documented 7-day auto-pause) must fail fast into
  `StorageUnavailable`, not hang the TUI for the wake-up window. The
  timeout defaults at or above the sideband client's 2000ms
  (`src/sideband.ts:179`) -- the in-process bridge path is the slower
  bound, and hook paths that ride the sideband degrade at 2000ms
  regardless. A bridge crash surfaces as a
  typed error, not a hang.
- **Composite operations, not interactive transactions.** supabase-js
  (PostgREST) has no interactive transaction API, so every
  multi-statement shared-table sequence becomes ONE backend operation.
  The complete production inventory -- eleven `transaction()` call sites
  minus the facade definition and the schema-internal migration, plus
  `forgetEntry`'s raw-exec span -- splits into two kinds. The
  method-internal composites port as the implementation detail of their
  single operation: `remember`'s tombstone-check-plus-insert
  (`src/db.ts:831-843`; the check is the exact content-hash match PLUS
  the cosine sweep over the store's tombstone embeddings,
  `src/db.ts:1144-1165` -- a port that implements only the hash arm
  silently weakens the hold, and the driver-contract tests assert a
  near-identical-content hold against both implementations),
  `forgetEntry`'s tombstone-then-deletes via raw `exec("BEGIN IMMEDIATE")`
  (`src/db.ts:1106-1128`, whose lock-first no-stale-read-window guarantee
  the docstring at `src/db.ts:1080-1097` calls load-bearing and the port
  must preserve), `unregister`'s tombstone-then-delete
  (`src/chat.ts:980`), `send`'s batch insert (`src/chat.ts:1207`), the
  broadcast fan-out (`src/chat.ts:1349`), `createEdge`'s
  insert-plus-bump (`src/scoring-engine.ts:303`), and `deleteItem`'s
  bump-plus-delete (`src/scoring-engine.ts:375`). The caller-side
  multi-method wraps become single composite operations in the
  StoreBackend set: prediction_update (`src/tool-defs.ts:1095`),
  behavior codify (`src/tool-defs.ts:1290`), and behavior_feedback
  (`src/tool-defs.ts:1374`), implemented server-side (an RPC or a batched
  statement) on the supabase driver and as today's transactions on the
  sqlite driver. The tool-layer wrap sites are milestone-2 touch points.
  The facade's public `transaction()` survives for the machine-local
  client and the sqlite driver; under the supabase driver it throws with
  a clear "shared-table operations are atomic; use the operation, not a
  wrapper" message -- the inventory above covers every production
  transactional shared-table sequence, so no call site needs the
  interactive form.
- **The schema.** The shared tables in Postgres: `TEXT`/`INTEGER`/`REAL`
  columns as today, ISO `TEXT` for timestamps (preserving the
  string-comparison semantics the code relies on), pgvector columns for
  the embedding BLOBs, and an explicit translation for SQLite's
  case-insensitive name uniqueness -- `chat_sessions.name`'s
  `COLLATE NOCASE` unique constraint (`src/db.ts:411`) and
  `#findByName`'s NOCASE lookup (`src/chat.ts:1763-1768`) become a
  `citext` column or a `UNIQUE` index on `LOWER(name)`, with the lookup
  matching. Schema management is a migration-version table -- no `PRAGMA`
  probing;
  migrations are explicit versioned steps applied by the driver at open,
  guarded so two machines racing a migration is safe (the same
  idempotency hardening the pre-ruling run specified: duplicate work is
  success).
- **Search.** Server-side similarity: the query embedding goes up (384
  floats), pgvector ranks, top-k returns. One round trip per search; the
  brute-force local scan stays the sqlite driver's implementation.
  pgvector is included free on all Supabase plans (research record).
- **Offline.** Shared reads and writes fail loudly (Jeff ruled): the typed
  `StorageUnavailable` error naming the project URL. The write
  classification below governs the failure surfaces. No local replica in
  v1 -- a read cache is a possible later optimization, explicitly not
  this plan.
- **Fail-soft construction.** No remote IO happens in the constructor:
  the migration check and the two unconditional open writes
  (`src/db.ts:446`, `src/db.ts:706`) defer to the first successful
  connection, because every one-shot process constructs ThatchDB
  (`bin/thatch:101`) and an offline machine must still load the plugin
  and run every CLI command. The local sqlite client keeps the full
  schema under a remote driver -- that is what makes the local file the
  frozen snapshot the rollback story depends on.
- **One client per ThatchDB instance, plus the daemon question.** A v2
  serve holds one ThatchDB per location and `thatch mcp` holds two in one
  process (`bin/thatch:101` then `src/mcp.ts:184`); the bridge shape
  decides whether each process holds its own connection or talks to a
  machine-local daemon. The one-shot-process model (CLI, hooks -- they
  construct ThatchDB through the dispatcher at `bin/thatch:101`; the
  sideband spares them the embedding model, not the database) is the
  stress case the spike must answer.

Write classification -- class, failure surface, catch site (carried from
the pre-ruling refinement, mechanisms updated for remote-primary without a
replica):

| Write | Class | Failure surface and catch site |
|-------|-------|-------------------------------|
| `remember`, prediction and behavior updates | Knowledge | Returned error naming the remote, through the tool layer as today -- and the conversion is explicit: the driver maps `StorageUnavailable` onto the same caught-and-returned failure arm `isBusyError` uses (`src/db.ts:844-852`), because a THROWN remember surfaces as a host tool error and the runtime's extraction drain gate is fail-open on unreadable output shapes -- a failed write that drains the buffer is the silent-loss class the `[saved]` gate exists to prevent (`src/db.ts:811-818`) |
| `forget` | Knowledge | Thrown, matching its existing deliberate-throw contract (`src/db.ts:1089-1092`) |
| Chat send, broadcast, explicit and auto registration | Knowledge | In-band `{ok: false, error}` via the facade delegation; the auto-register callers all handle it (`src/runtime.ts:763-793` startup, `:2649` idle, `:2202` prompt path) |
| Unregister | Knowledge | Throws: `unregister` returns a boolean (`src/chat.ts:977-1002`) with no error arm to convert; its runtime callers already catch and log (`src/runtime.ts:2577-2581`, `:2787-2791`), and the tool layer surfaces the throw |
| Leave-tombstone clears, session continuation | Identity | Loud logging at the continuation catches (`src/chat.ts:483-487`, `src/cli/hooks.ts:105-110`); the restore-rejoin clears at `src/runtime.ts:774` and `:2178` have no local catch today and gain one; transient failures self-heal on the next registration event; a persistently offline machine honestly stays out of the directory |
| Wake rows (`ChatStore.recordWake`, `src/chat.ts:1728-1729`) | Loop-control | Must NOT degrade silently: when the write fails while reads still succeed (a transient bridge failure), the poller substitutes a per-recipient, time-windowed in-process prompt count for the DB count (`chatWakeCount`, `src/chat.ts:1734-1738`) -- the id-set alone cannot budget (`src/chat.ts:2921-2930`). The fallback's count is per-process: during the outage window the cluster-wide cap degrades to per-process, a bounded divergence the DB-held budget was built to avoid but which a transient window cannot outgrow. Fully offline there is no loop at all: the pending read fails, no delivery runs, the poller's per-cycle catch retries (`src/chat.ts:2782-2786`) |
| Delivered/read stamps (`markDelivered` `src/chat.ts:1714-1718`; the read stamp at `src/chat.ts:1453`) | Delivery-accounting | Caught at the stamp site: the read path returns rows with the stamp skipped; `markDelivered`'s poller path falls back to `sentIds` (`src/chat.ts:2959-2968`); the Stop-hook caller (`src/cli/commands/hook-commands.ts:336`, command-level catch at `:276-348`) and the bundled regime's caller (`src/flush.ts:213`) gain the same catch, preserving the nudge with the stamp skipped |
| Heartbeats, topic refresh, machinery markers, prune sweeps, recall telemetry (`src/db.ts:1008-1012`, `src/chat.ts:1627-1631`) | Maintenance | Best-effort, caught inside the ThatchDB facade method itself (in `src/db.ts`, not ChatStore -- keeping the cluster mapping's chat-code change list exhaustive), not merely the poller's cycle catch, which aborts the cycle before delivery if a heartbeat throw reaches it; all retry naturally |
| `seedDefaultBehaviors` startup writes | Maintenance | Fail per behavior into the existing catch (`src/seed-behaviors.ts:335-337`), logged and continued |

The seeded-behavior never-downgrade rule carries over: `seedDefaultBehaviors`
deletes and re-seeds on any version skew (`src/seed-behaviors.ts:311-322`);
two machines on different versions would ping-pong. A machine seeds only at
or above what the store holds; the version read is a normal shared read.

Read failures get their own rule, because offline every prompt hits
shared reads: the nudge paths (the plugin's in-process nudge, the hook
tiers' db reads, the sideband server's match and prediction/behavior
lookups behind `src/mcp.ts:424`) degrade to no-nudge with a bounded
warning cadence -- the sideband client already degrades to null on
failure (`src/sideband.ts:180-181`), and the in-process paths adopt the
same posture; the recall tools surface the remote-naming error through
the tool layer, so the agent knows the store is unreachable rather than
empty.

### Storage configuration and lifecycle

New `storage` section in `config.json`, strict-schema as the existing
sections (`src/config.ts:37-41`, `src/config.ts:70-71`):
`{ driver: "sqlite" | "supabase", url, authToken, machineLabel }`, all
optional (absent driver means sqlite). Credentials arrive by symbol:
`"url": "{env:THATCH_SUPABASE_URL}", "authToken": "{env:THATCH_SUPABASE_TOKEN}"`
-- the new substitution pass resolves them at load, and the raw values
never appear in the file. `machineLabel` defaults to the hostname.

The `{env:VAR}` substitution is new machinery in `loadConfig`, semantics
copied from opencode in full (`opencode/packages/core/src/config/variable.ts:26-38`):
substitute in the raw config text before parsing, missing variables
substitute empty, values that break the JSON parse trigger the escaped
retry (`variable.ts:32-37`), and a still-unparseable file falls into the
existing invalid-config warning path (`src/config.ts:102-111`) -- with the
warning computed against the pre-substitution text so a parse error can
never echo a resolved credential. The `{file:path}` pattern rides along
-- copying opencode's substitution in full includes it, and it costs
nothing to keep the two patterns together. Substitution applies on the
read-for-use path only; `config_set` writes from the raw document (see
the five-surfaces list below).
`resolveStorage` validates the substituted credential fields and fails
with a clear "env var unset" message when a field is present but empty --
a forgotten export must not surface as an opaque remote error naming an
empty URL, and the failure is a load-time validation error, distinct
from OFFLINE's connection-time error. The new `THATCH_` variables
register in `ENV_KNOBS` individually (`THATCH_STORAGE_DRIVER` and
friends, plus push's `THATCH_SUPABASE_URL`/`THATCH_SUPABASE_TOKEN`
defaults) -- the drift test is self-enforcing per name; the concrete
credential variables are otherwise user-chosen, not thatch-named.

The section surfaces in five places, four hand-rolled in
`src/tool-defs.ts` today and pinned by no existing test: the config schema
and section list in `src/config.ts`; the `config_get` args enum
(`src/tool-defs.ts:1516`); the `config_get` render chain
(`src/tool-defs.ts:1535-1547`); the `config_set` args schemas
(`src/tool-defs.ts:1567-1621`); and -- the one the substitution makes
load-bearing -- the `config_set` execute body (`src/tool-defs.ts:1686-1727`),
which today loads the file, merges, and writes the whole document back
(`src/config.ts:119-126`). If `config_set` merges against substituted
values, any routine config write (an agent changing
`notifications.voice`) resolves `{env:THATCH_SUPABASE_TOKEN}` to its
literal value and persists the raw token in the file. The rule:
substitution applies on the read-for-use path only; `config_set` merges
against the raw, pre-substitution document (a raw-parse variant of
`loadConfig`) so symbol references round-trip verbatim, and a regression
test asserts that a `config_set` on notifications preserves the storage
section's symbols. `config_set` is read-only for the storage section --
`push` owns the write, the same refusal pattern the environment section
uses (`src/tool-defs.ts:1674-1678`) -- so no tool path can persist a
literal credential; and `push`'s own config write uses the same
raw-read-merge-write path so it cannot clobber unrelated sections. The
token renders masked in `config_get` (new surface;
no masking precedent exists in the codebase).

A `resolveStorage(dbPath?)` helper in `src/config.ts` reads config plus env
overrides (for QA: `THATCH_STORAGE_DRIVER` and friends, registered in
`ENV_KNOBS` whose drift test is self-enforcing, `tests/env-knobs.test.ts:46-60`)
and returns the effective settings. It absorbs the path-resolution sites
(`bin/thatch:20-21`, `src/mcp.ts:179`, `src/runtime.ts:259`,
`src/setup.ts:77-78`), unifying their two disagreeing HOME-fallback forms
onto `homedir()`. `src/index.ts:43` keeps its own resolution (debug log
only).

The forward-compatibility caveat carries over: the config schema is
strict, so an older thatch build ignores the entire config file when
`storage` exists (`src/config.ts:102-111`) -- the older machine reverts to
LOCAL-DEFAULT, loses its prefs, and writes knowledge into the frozen local
file while the other machine writes the remote: silent divergence until
both machines run the same version. The user doc states the same-version
requirement in exactly those terms.

Storage lifecycle states:

| State | Shared reads | Shared writes | How entered |
|-------|--------------|---------------|-------------|
| LOCAL-DEFAULT | local `thatch.db` | local `thatch.db` | No `storage` config (every user today) |
| REMOTE-CONFIGURED | remote (possibly empty) | remote | Config present; the remote is not yet verified seeded |
| SHARED-ACTIVE | remote | remote | The seed marker is known-present -- written by this machine's `push`, or found at the next status/push observation |
| OFFLINE | typed failure, warning surfaced | typed failure naming the remote | Remote unreachable or unauthenticated, from ANY configured state |

Transition precedence: reachability beats configuration -- OFFLINE is
entered by connectivity alone, and left by connectivity or by removing the
storage config, whatever configured state it interrupts. Without the
marker -- empty or partial -- the machine is REMOTE-CONFIGURED (the
footgun: reads may be empty; `status` names the partial case distinctly).
The marker is observed at status and push time only -- nothing at open
probes for it; the two states differ in reporting, not behavior. One
condition sits outside the matrix by design: a config whose credential
symbol resolves empty fails `resolveStorage` validation at load, before
any driver constructs -- the machine never enters the lifecycle (its
shared IO fails with the "env var unset" message, and the nudge paths
degrade exactly as the offline read rule describes -- no nudge, bounded
warning), and the fix is
exporting the variable, not a state transition.

### Seeding and rollback

`thatch storage` namespace in the CLI registry (the
namespace-with-children pattern `bin/thatch:34-45`; the registry is pinned
by no test today, so the namespace work lands with a registry test).

- `thatch storage status [--url --url-env NAME --token-env NAME]` --
  effective driver, url with
  masked token, env overrides when active, the lifecycle state, knowledge
  row counts local vs remote, and warnings (unseeded, partial, offline;
  on the unset-env machine, the load-time "env var unset" validation
  error itself -- status prints the same message the shared IO would).
  URLs are not secrets: `--url` takes a literal for one-off inspections
  (nothing is persisted). The token never takes a literal flag -- only
  `--token-env`, naming the exported variable, so no shell history or
  process listing ever carries the credential. The flags matter after a push dies mid-copy: the machine is still
  LOCAL-DEFAULT (config is written last), so `status` can only see the
  remote it is told about, and reports the machine's state plus the
  remote's seeded-ness.
- `thatch storage push [--url-env NAME --token-env NAME]` -- verify the
  remote is reachable (the connection uses the exported values),
  create the shared schema on it (the verbs run on raw clients; a fresh
  remote needs the tables before the first copy), copy knowledge-table
  rows -- the knowledge set including `stores`, since `entries` carries a
  foreign key to `stores(name)` (`src/db.ts:248`) -- from the local `thatch.db` into the remote, write the
  seed-completion marker (`storage_meta`) as the copy's last step, then
  write the `storage` config -- as symbol references: the flags name env
  VARIABLES (defaulting to `THATCH_SUPABASE_URL` and
  `THATCH_SUPABASE_TOKEN`), and the config stores
  `{env:THATCH_SUPABASE_URL}`-style references, never literal
  credentials. If the variables are not exported, push fails with the
  clear "env var unset" message before any IO. Then it reports "shared
  storage active". The
  order is load-bearing: config flips only after the seed succeeds; a
  push that dies mid-copy is not transactional across tables, so `status`
  warns on a non-empty remote without the marker, and the user doc says
  re-run after a failure. `push` refuses while a storage config is active
  (the local shared tables are then a frozen snapshot; re-pushing it
  resurrects opt-in-era forgets as coexist rows). The refusal message and
  user doc state the escape in full: pull first, then remove the config,
  then push.
- `thatch storage pull` -- copy remote knowledge rows back into the local
  `thatch.db`. Rollback and refresh; requires an active storage config
  (every described pull journey has one; an unconfigured machine that
  wants remote data configures first). The
  permanent-remote-loss mitigation is operational, not a flag: the local
  file is a full snapshot on the origin machine and becomes one on any
  machine after its first `pull`, and a periodic `pull` is the
  documented backup practice (the research's separate `thatch backup`
  recommendation remains the better general answer and stays out of
  scope here).

Merge semantics by row class, unchanged from the pre-ruling run: mutable
rows upsert by primary key, newer `updated_at` winning; append-only rows
insert-if-absent; nothing deletes. A knowledge row whose embedding
dimension does not match the pgvector column (a model switch left
behind) fails the push loudly with the row named -- the sqlite BLOB path
silently skips dimension outliers at search (`src/db.ts:982-987`), but a
fixed-dimension PG column cannot store them, and a loud failure beats a
silent drop at copy time. Pushing into a live remote can create
the coexist state (a live entry beside a same-label tombstone), which has
defined behavior (`clearMemoryTombstones` never touches entries,
`src/db.ts:1180-1193`).

One rollback hazard, documented rather than engineered: an entry forgotten
during the opt-in era is absent from the remote but live in the frozen
local snapshot, so `pull` leaves it live again beside its pulled
tombstone. The hold still guards re-writes; the visible fix is re-forget.
The gotchas entry and user doc name this before the user runs `pull`.
Opt-in-era chat history is not merged back on rollback (accepted loss;
chat is TTL-pruned coordination state).

A fresh machine needs no push: configure url and token, and the first
connection finds the seeded remote.

### The chat cluster mapping

What the cluster gains without chat machinery changes:

- Cross-machine delivery. A message from machine A to a session on machine
  B lands as a row in the shared `chat_messages` (`src/chat.ts:1226-1229`).
  B's poller queries `pendingChatNotifications` for its own hosted set
  (`src/chat.ts:2881-2883`); the hosted set is machine-local, the rows are
  shared, and the recipient-registered check resolves against the shared
  directory (`src/chat.ts:1699`). B's poller wake-prompts through its own
  SDK client. The host-owned delivery rule (`src/chat.ts:14-21`) is intact
  on every machine.
- One roster across machines, now with the machine label:
  `chat_sessions` and heartbeats (`src/chat.ts:1770-1772`) are shared, so
  each machine's `chat_list` shows the cluster; the new label column
  renders which machine a session lives on. Liveness is immediate -- no
  replica lag to reason about; `isStale` (`src/chat.ts:3003-3005`) reads
  the same store the heartbeats write. The OPEN-vs-RECENT split degrades
  honestly: the tab set is a read-only, machine-local refinement consumed
  at render and broadcast time, and omitting it degrades every fresh
  other-machine row to RECENT -- honest, never a false OPEN
  (`src/chat.ts:440-462`, `chatLiveness`; `src/chat.ts:1257-1267` is where
  broadcast consumes it).
- Cluster-wide name uniqueness and wake budget. The name counter draw is
  one atomic statement (`src/chat.ts:1819-1829`) -- atomic on the remote
  too; the wake budget table is shared (`src/chat.ts:1720-1754`), so the
  per-recipient cap counts prompts from every machine.
- Agent broadcasts are cluster-blind, and the plan says so rather than
  fixing it: `broadcast` fans out with an OPEN-tab gate
  (`src/chat.ts:1257-1268`, the gate at `:1371-1373`) and the tab set is
  machine-local by construction (`src/tab-state.ts:7-13`) -- so an agent
  `chat_broadcast` from machine A lands no rows for machine B's opencode
  sessions (they report as "no open tab" skips, honestly but misleadingly
  across machines). Direct sends cross machines with no tab gate
  (`src/chat.ts:1215-1231`), and the user-voiced CLI broadcast reaches
  everyone (`requireOpen: false`, `src/chat.ts:1292-1308`). The
  anti-fleet-wake philosophy of the gate is correct; the user doc names
  the limitation, and the live QA use case covers a cross-machine
  broadcast explicitly so the skip list is exercised, not just direct
  sends.
- All hosts covered: opencode's poller, the bundled plugin regime
  (`computePluginChatWake`, `src/flush.ts:202`, polls delivery reads on
  the mod's clock), and the standalone MCP server all read the same
  shared store -- remote-primary has no freshness machinery to wire.

What changes in chat code -- a short, named list, nothing else: log lines
at the two
continuation-adoption catches (`src/chat.ts:485-487`,
`src/cli/hooks.ts:108-110`) distinguishing storage failure from a failed
transcript walk; a stamp catch inside `ChatStore.read()` so the read path
returns rows with the stamp skipped (`src/chat.ts:1441-1463`); the same
catch around the Stop-hook's and bundled regime's `markDelivered` callers
(`src/cli/commands/hook-commands.ts:336`, `src/flush.ts:213`); catches
around the restore-rejoin tombstone clears (`src/runtime.ts:774`,
`src/runtime.ts:2178`); the poller's budget fallback for transient
wake-write failures (`src/chat.ts:2921-2930`) and a bounded cadence on
its per-cycle offline log (`src/chat.ts:2783` fires every cycle for the
whole outage today); and the machine label -- a `machine` column on
`chat_sessions`, set at registration from the per-machine config name,
rendered in the roster (rows predating the column -- a pulled snapshot or
a seeded remote from before the migration -- render no label rather than
a wrong one), landing as an ALTER-based migration (never an
extension of the collation rebuild's pinned SELECT -- the ordering trap
at `src/db.ts:718-724`).

Verified behaviors to document and test, not change: `pruneStaleAuto`
(`src/chat.ts:1106-1137`) prunes cluster-wide after the auto-row TTL -- a
machine offline past the TTL has its rows reaped everywhere and reclaims
its names through `chat_name_claims`; unread mail to reaped sessions ages
out with the same sweep. The wake nudge is pointer-only
(`src/prompts.ts:1372-1380`). No model-executed protocol steps anywhere in
the cluster machinery -- the poller, the wake budget, the tombstone gates,
and delivery are host code (`src/runtime.ts:618-629`).

### Migration idempotency hardening (sqlite side)

The sqlite migration set keeps its current shape; the hardening from the
pre-ruling run applies the moment a remote can race it (driver 2's
versioned migrations, and any future shared-sqlite driver): one shared
guarded-run helper that the guarded migrations route through
(`src/db.ts:881-890` is the catch-and-classify precedent), treating
"duplicate column name", "no such column" (the raced DROP shape,
`src/db.ts:636-641`), and "already exists" (the raced collation rebuild,
`src/db.ts:725-744`) as idempotent success.

## Blast radius and consumers

- Every raw-SQL call site: `src/db.ts`, `src/chat.ts`,
  `src/scoring-engine.ts`, and `src/prediction.ts` route
  through the client seam (milestone 1) and the operation interface
  (milestone 2, shared tables). Milestone 1 contains exactly one SQL text
  change: `findSessionByHostPid`'s join becomes the two-step resolution,
  because a JOIN cannot span two clients -- it belongs in SQL review. In
  milestone 2 the shared-table SQL moves into the sqlite StoreBackend
  verbatim, and the tool layer's facade-transaction wraps
  (`src/tool-defs.ts:1095`, `:1290`, `:1374`) become single
  composite-operation calls.
- `ThatchDB` consumers: the CLI dispatcher (`bin/thatch:101-103`), the MCP
  server (`src/mcp.ts:184`), the opencode runtime (`src/runtime.ts:275`).
  Construction gains an optional storage parameter; default behavior does
  not change.
- One-shot processes DO open the driver: the dispatcher constructs
  ThatchDB for every subcommand including hooks, and hooks use it directly
  (`src/cli/commands/hook-commands.ts:133`, `:162`, `:168`). The sideband
  spares the embedding model, not the database.
- The config surface: the schema, section list, merge machinery, and the
  new substitution pass in `src/config.ts`; the four hand-rolled
  tool-defs surfaces (the args enum, the render chain, the config_set
  args schemas, and the config_set execute body -- the last being the one
  the substitution makes load-bearing); tool tests including a
  masked-token assertion and a
  substitution test.
- The chat roster, `chat tail`, and every chat tool reader see
  cluster-wide rows plus the machine label. `thatch mcp` opens two
  ThatchDB instances in one process (`bin/thatch:101` then
  `src/mcp.ts:184`) -- the spike exercises the shape.
- The nudge hot path: sqlite keeps the local brute-force scan; supabase
  pays one round trip per search (server-side pgvector).
- The SharedModelPool stays keyed on the `thatch.db` path
  (`src/embeddings.ts:170-203`).
- QA surfaces that open `thatch.db` raw with `bun:sqlite` (among them
  `tests/qa/auto/uc-008`, `uc-058`, `uc-081`, `uc-088`, `uc-089`, `uc-097`,
  `uc-099`, `uc-100`, `uc-102`, `uc-104`, `uc-117`, `uc-122`, `uc-128`,
  and the live `tests/qa/live/opencode/uc-098`) assume the chat tables
  live in that file -- true in default mode. Storage-mode QA variants
  must target the remote; the containerized QA image needs network egress
  and the supabase client before they can.
- The README pitch (`README.md:10-11`) gains Jeff's companion sentence;
  the Privacy section (`README.md:95-101`) gains the opted-in-storage
  exception beside the existing `gh` exception.
- `src/session-db.ts` reads opencode's own database and is unaffected.

## The driver-2 spike and its pass/fail criteria

One working day, timeboxed, after milestone 1 lands. Setup: a throwaway
Supabase project (Jeff's account; the free tier suffices for a spike).

Pass requires every criterion:

1. Bridge shape: at least one sync-over-async bridge works under Bun --
   the measurable properties: the facade blocks for at most the round
   trip or its bounded timeout; the host's event loop resumes immediately
   after the call returns; no cross-call deadlock occurs; errors surface
   as typed errors; shutdown is clean; and a cold or paused remote fails
   fast into `StorageUnavailable` through the timeout rather than
   blocking for the wake-up window. (A blocked facade call does block the
   host's main thread for the call's duration -- that is inherent to a
   synchronous call graph and is the accepted latency cost, bounded by
   the timeout; the spike measures the full per-prompt aggregate, not
   just one call: the three-sequential-reads nudge sequence AND the
   per-prompt chat identity sequence -- the restore-rejoin clear
   (`src/runtime.ts:2178`, a shared-table DELETE) plus the register touch
   (`src/runtime.ts:2189`), roughly four more round trips; the clear can
   be read-gated to skip the DELETE when no tombstone stands, the common
   case -- so the per-prompt cost is known before driver 2 is built.)
   The worker-thread shape must survive the shutdown-crash history
   (`src/embeddings.ts:106-108`); the dedicated-process and socket-daemon
   shapes are the fallbacks -- and the daemon's synchronous socket client
   is new code (the sideband's client is async; only its warm-server
   architecture is the precedent), which the spike's scope reflects. The
   spike names the surviving shape with evidence.
2. One-shot viability: a CLI-style process constructs ThatchDB with the
   supabase driver, performs a read and a write, and exits cleanly --
   with construct-read-write-exit wall clock within a small multiple
   (the spike picks the number, stated in its output) of the sqlite
   path's -- this is the stress case for the
   daemon shape: what happens when no daemon exists yet.
3. supabase-js under Bun: connection, auth, query, transaction support
   (or the batched-statement substitute), error classes distinguishable
   from contention, and the error mapping into the write-class shapes.
4. Schema and migrations: the shared tables create in PG (pgvector
   columns included), the migration-version table applies steps
   idempotently, and two racing clients cannot corrupt.
5. Search round trip: a pgvector similarity query over the entries shape
   returns the same top-k the local cosine scan returns for the same
   query embedding (same model, same pinned version) -- and the embedding
   round-trip preserves the vectors exactly.
6. The name-counter draw (`src/chat.ts:1819-1829`) as native PG SQL stays
   atomic under two concurrent clients.
7. Offline: all shared IO fails loudly and cleanly (typed errors, no
   hangs, no partial local state); the poller's per-cycle catch retries;
   nothing loops.

Fail on any criterion: driver 2 stops, milestone 1 stands alone, and the
failing criterion plus evidence goes to Jeff -- with option (c) (local
sqlite plus async replication) or option (a) (the full async refactor) as
the named fallbacks.

## Phases and gates

- Milestone 1, Phase 1 -- the client seam. `SqlClient` extracted,
  `get_client()` caching, engines and ThatchDB typed against it, no
  behavior change. Gate: the full existing suite passes with no test
  edits.
- Milestone 1, Phase 2 -- local/shared routing. The two clients, the
  partitioned schema init, `ChatStore` taking both, the two-step host-pid
  resolution. Gate: existing suite green (one mechanical test edit: the
  direct `ChatStore` construction in `tests/chat-poller.test.ts:1087`);
  the default-layout test (one file, every table); the routing tests,
  exercisable by passing the storage parameter directly to the
  constructor with `#shared` pointed at a second local file.
- Milestone 2, Phase 0 -- the spike. Gate: all seven criteria.
- Milestone 2, Phase 1 -- the StoreBackend interface. The shared-table
  operations extracted; the sqlite implementation holds the current SQL
  verbatim; and the three tool-layer transaction wraps
  (`src/tool-defs.ts:1095`, `:1290`, `:1374`) convert to single
  composite-operation calls HERE, so no tool path is left calling the
  facade `transaction()` that throws under the supabase driver. Gate:
  existing suite green (mechanical moves only).
- Milestone 2, Phase 2 -- the supabase driver. The bridge, the PG schema
  and migrations, pgvector search, error mapping, offline behavior, the
  machine-label column, the config substitution pass, the storage CLI
  verbs. Gate: driver-contract tests against both StoreBackend
  implementations (the sqlite one network-free); env-gated remote
  integration test (`THATCH_TEST_REMOTE_URL`/`TOKEN`, skipped silently
  without the env); the verb tests against a local mock; the registry
  test; the config tool tests including substitution and the masked
  token; the migration-race tests.
- Milestone 2, Phase 3 -- cluster verification, QA, docs. Gate:
  `mise run qa-auto` green including the new use cases; the live QA use
  case (two config homes against one scratch remote; cross-machine send
  delivers; a memory written on one side recalls on the other; honest
  label: simulated machines); both doc tiers updated; `mise run lint-md`
  clean.

Rollback: every phase lands behind the default config, which never
changes; an opted-in user rolls back with `thatch storage pull` plus
removing the `storage` section. A release shipping any phase is safe for
every default user by construction.

## Testing and QA

- Driver-contract tests: the same behavioral assertions against both
  StoreBackend implementations; the sqlite one runs file-backed and
  network-free.
- Routing and layout tests as the Phase 2 gate names.
- Config tests: section merge semantics in `tests/config.test.ts`; the
  five tool surfaces in the `tests/notify.test.ts:331-523` pattern
  including the masked token and the symbol-preserving `config_set`
  round-trip (a config_set on notifications must leave the storage
  section's `{env:...}` references verbatim); substitution resolution
  (env over file, absent means sqlite, missing vars, the escaped retry,
  the unset-credential message) in `resolveStorage`.
- CLI tests: the registry/namespace test; `storage status/push/pull`
  against a mock remote.
- Migration tests: the version-table idempotency and the two-client race;
  the sqlite guarded-run helper's three race shapes.
- Open-time and offline tests: unreachable-remote construction, the write
  classification table's failure surfaces (in-band chat failures, the
  transient-wake budget fallback, the read path's stamp skip,
  maintenance degradation), the never-downgrade seed rule.
- Remote integration test, env-gated: full schema, search parity, name
  atomicity, offline behaviors.
- QA auto use cases: storage config resolution and default-path
  invariance; offline knowledge-write failure (an unreachable url makes
  `remember` return the clear error and nothing is written).
- QA live use case: the two-machine simulation on one box (two config
  homes against one scratch remote).

## Docs touch points

- `docs/dev/features/database.md` -- the client seam, the operation
  interface, the table split, the two drivers.
- The local-only claims in the feature docs gain the opted-in branch:
  `docs/dev/features/memory-store.md:3` ("a SQLite-backed store"),
  `docs/user/memory.md:4` ("stored in a local SQLite database"),
  `docs/dev/features/prediction-engine.md:27` and
  `docs/dev/features/behavior-engine.md:28` ("Four tables in SQLite") --
  the same inclusion rule the chat docs get below.
- New `docs/dev/features/shared-storage.md` -- driver architecture, the
  bridge, the write classes, the offline contract, seeding and rollback,
  the cluster mapping, the lifecycle states, the machine label.
- New `docs/user/shared-storage.md` -- what sharing does, how to opt in
  with `push`, what stays local, and the limitations: offline shared IO
  fails, the design assumes one user, both machines must run the same
  thatch version and the same embedding model and backend
  (`THATCH_EMBEDDING_BACKEND`), machine labels should be distinct per
  machine, rollback ordering, the resurrection of opt-in-era forgets
  after `pull`, chat history does not merge on rollback, agent broadcasts
  do not reach other machines' opencode sessions (direct sends do),
  free-tier
  auto-pausing, and self-hosting/any-PG as future directions.
- `docs/user/cross-session-chat.md` and
  `docs/dev/features/cross-session-chat.md` -- both state machine-only
  scope today; opted-in users make those sentences false, so both tiers
  gain the shared-store branch and the machine label. The machine label
  also extends `ChatRosterJsonRow` -- its field names are a documented
  stable contract (`src/chat.ts:544-549`, `docs/user/cli.md`), so the
  additive `machine` field and its doc entry are named changes, not
  silent drift.
- `docs/user/cli.md` and `docs/dev/features/cli.md` -- the
  `thatch storage` verbs and the roster's machine label.
- `README.md` -- Jeff's companion sentence after the existing promise
  (`README.md:10-11`), and the Privacy exception (`README.md:95-101`).
- `docs/user/README.md` -- the Privacy bullets (`docs/user/README.md:544-548`)
  gain the opt-in branch; the feature index gains the entry.
- `docs/dev/features/README.md` and `docs/dev/README.md` -- the docs table
  and module map gain the new entries.
- `docs/dev/gotchas.md` -- the unseeded blank-read window, the frozen
  local snapshot, the rollback resurrection, the version-skew
  divergence.
- `docs/dev/mcp-parity.md` -- no parity change: the driver is
  host-agnostic; state it explicitly.

## Intent breadcrumbs

- The client-seam doc comment: why the interface is synchronous-only (the
  whole call graph is synchronous), why `transaction` returns the
  callable, and why the begin-modes must not be "improved".
- The `get_client()` doc comment: the caching and config-resolution
  contract, and why absent config means sqlite (the default path must
  stay byte-identical).
- The StoreBackend doc comment: why the interface is operation-level, not
  raw SQL (the migration machinery is SQLite-native; there is no
  dual-dialect path), and why each driver owns its dialect.
- The bridge doc comment: why the sync facade exists (the async wall),
  which shape survived the spike and why, and how transactions map to
  remote sessions.
- The substitution doc comment: the `{env:VAR}` semantics (missing =
  empty, pre-parse, opencode parity) and why credentials never appear in
  the file.
- The write-classification table is itself the breadcrumb for every
  catch site; each catch carries a one-line why.
- The `#open` comment: the two-client split, why `chat_host_pids` can
  never share, and why the machine-local tables stay sqlite under every
  driver.
- The `storage` config comment: `push` writes the config last, so a
  half-configured machine never reads blank shared stores.

## Dependencies

- One new runtime dependency for milestone 2: supabase-js (async-only;
  the bridge exists because of it). It is the first runtime dependency
  with a network client beyond the already-present ONNX stack.
- `zod` (present) extends for the `storage` section.
- The Supabase project is the user's operational dependency; the default
  install path gains nothing.

## Risks and accepted risks

| Risk | Mitigation |
|------|------------|
| The bridge is the plan's biggest bet: a sync-over-async facade has failure modes (shutdown, starvation, one-shot cost) | The spike's criterion 1-2 exist to kill it early; three candidate shapes; worker_threads carries thatch's own shutdown-crash history (`src/embeddings.ts:106-108`) and is the least favored; a daemon-shaped bridge inherits the version-skew problem (an upgraded one-shot client talking to a stale daemon) and must adopt the MCP server's existing version-file pattern if picked; fallbacks (local-plus-replication, full async refactor) are named and go to Jeff if the spike fails |
| Supabase free tier auto-pauses after 7 days of inactivity | Documented; the user doc points at the paid tier for a two-laptop always-available store; the driver accepts a project URL, so any Postgres-shaped future (self-hosted, Neon) is a driver away once the operation interface exists |
| Hosted dependency class (quota, pausing, support surface) the README today promises never exists | Opt-in only; data leaves the machine only through an explicit `push`; Jeff's companion sentence states the default promise unchanged |
| Offline shared IO fails entirely (Jeff-ruled posture) | Loud typed errors naming the remote; local-only features unaffected; the poller's existing per-cycle catch retries; the write classification keeps every failure surface in-band or logged |
| The dialect port is real work (the operation set in native PG) | Bounded to ThatchDB's method set; the sqlite side is a mechanical extraction; the spike proves the schema and search before the port is attempted at scale |
| A post-forget write on the other machine resurrects deleted content | Cannot happen through the write path: the tombstone ledger is a shared table and `remember` checks it inside the remote write transaction (`src/db.ts:830-843` semantics, serialized at the remote) |
| Migration races between machines | The version-table migrations are idempotent and guarded; the sqlite guarded-run hardening covers its three race shapes; spike criterion 4 |
| Seeded-behavior version ping-pong between machines | The never-downgrade rule; the same-version requirement in the user doc |
| An older thatch build ignores the whole config file once `storage` exists | Documented same-version requirement; the degradation is a warning line, and the divergence consequence is stated in the user doc |
| Clock skew between machines | Timestamps are client-generated ISO strings (`src/chat.ts:49-59`, `src/db.ts:871`) except where an in-SQL `strftime` fills a column the writer omits -- `chat_machinery.created_at` (`src/chat.ts:1044-1046`, default at `src/db.ts:513`) and `prediction_dedup_pairs.checked_at` (`src/prediction.ts:203-208`); neither feeds a skew-sensitive rule. The skew-sensitive rules (push collisions, staleness, the wake hour, the re-nudge cutoff) sit far below NTP-typical skew; the research judged last-writer-wins skew tolerable |
| Rollback loses opt-in-era chat history; `pull` can resurrect opt-in-era forgets | Accepted and documented before the user runs `pull`; the tombstone hold still guards re-writes |
| Embedding-model divergence across machines silently skews scores | Documented same-model and same-backend requirement |
| Default-path regression | Milestone 1's phases are pure refactors gated on the untouched suite; a QA auto use case asserts default invariance after milestone 2 |

## Open questions

1. The bridge shape (worker thread, dedicated process, socket daemon) is
   the spike's output, not a choice made here. If every shape fails, the
   fallback choice -- local-plus-replication vs. the full async refactor --
   goes back to Jeff.
2. Supabase plan posture for Jeff's two laptops: free tier with its
   7-day auto-pause, or paid? The driver works with either; the
   availability expectation is the user's call.
3. Should driver 2 accept any Postgres connection string (self-hosted PG,
   Neon) rather than Supabase projects only? The operation interface makes
   the generalization nearly free; it is a product-posture call, not a
   technical one.

## Out of scope

- A local read cache or replica for the supabase driver (possible later
  optimization; the pre-ruling plan's libsql design documented what it
  would entail).
- The libsql/Turso driver (recorded analysis; a future driver if wanted).
- Team stores, multi-user identity, permissions, row-level security.
- A local write queue (offline shared writes); named as a future
  extension.
- `thatch backup` -- the research's separate, cheaper recommendation; not
  this plan.
