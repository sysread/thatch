# Shared embedding daemon for the MCP paths (issue #26)

## Synopsis

On Claude Code, every session runs its own `thatch mcp` process, and each
loads its own copy of the ONNX embedding model (~1.6 GB warm RSS; see
Background for provenance). This plan moves the model into one long-lived
daemon per DB path. Each session's MCP server keeps everything
session-scoped (store detection, branch scope, chat identity) and sends raw
embedding requests to the daemon over a Unix socket, falling back to an
in-process model exactly as it works today whenever the daemon is not
reachable. The opencode plugin path is untouched: under opencode's shared
serve process, `SharedModelPool` already gives every session one model for
free.

The design turns on one existing seam: `EmbeddingModel` (src/embeddings.ts)
is already an interface consumed by every tool through `CoreContext.model`
and by `SidebandServer`. The daemon feature adds a second implementation of
that interface -- one that forwards over a socket -- plus the daemon process
that serves it, and a single policy function that decides which
implementation an MCP server uses.

## Reviewer orientation

Start at "The seams" for the new modules and the exact change surface, then
"Model acquisition policy" for the probe/spawn/fallback rules, then "Daemon
lifecycle" for the sqlite lock, spawn race, and idle exit. The state and
transition matrix is the authoritative statement of client and daemon
states; the prose explains them. The correctness hinge of the design is the
model-name handshake ("The handshake"); the riskiest mechanical detail is
the spawn race ("Daemon lifecycle"). The testing section maps every policy
branch to a test that can fail, and names one precondition (a
characterization test). All three user rulings are recorded under
"Rulings". Nothing in this plan is implemented yet.

## Background

Issue #26 (jowi-dev, 2026-11-19) measured 72 concurrent Claude Code
sessions on 0.3.5: ~935 MB physical footprint per `thatch mcp` process,
~42 GB total, swap 98% full.

The 0.4.3 re-measurement discharging the issue's "measure 0.4.x first"
precondition was performed 2026-11-19 by the coordinating session, not yet
recorded anywhere durable: spawn `bun bin/thatch mcp` against a temp
`THATCH_DB_PATH`, drive one `memory_remember` over stdio JSON-RPC to warm
the model, and read RSS via `ps` -- 1623.64 MB (pid 73694, macOS, bun,
wasm default backend). The command sequence is reproducible from this
paragraph; the implementation PR should re-run it and attach raw output to
the issue.

Claude Code has no built-in sharing to lean on: every session spawns its
own stdio MCP servers by design. Upstream, anthropics/claude-code #99831
and #102457 are open; #82952 was closed as a duplicate of #63251
(2026-10-11); and the changelog through 2.1.328 ships no stdio sharing.
The only native sharing mechanism is the HTTP/SSE transport, which shares
the whole server and collapses per-session state (CLAUDE_PROJECT_DIR store
detection, branch scope, chat identity). The issue's NOTES rule that out,
correctly.

Jeff's directives for this plan (2026-11-19, coordination session -- not
recorded in the issue): pay a lot of attention to separation of concerns
and strong testability, and refine until further rounds stop producing
meaningful findings.

## Scope boundaries

- In scope: the MCP paths only -- `runMcpServer` standalone and `bundled`
  (the Claude Code plugin regime); the new `thatch embed-daemon`
  subcommand; the mock-model branch in the embedding factory
  (src/embeddings.ts, `THATCH_MODEL=mock` -- Jeff's ruling 2026-11-19);
  the config file's new `embedDaemon` section (src/config.ts schema,
  ruling 3); and the small registered surfaces the feature touches: the
  CLI registry entry, the `ENV_KNOBS` registry entries, the doctor's new
  report check, and the QA/test harness env defaults. Construction site:
  src/mcp.ts:197.
- Out of scope: the opencode plugin path (src/runtime.ts `SharedModelPool`
  stays exactly as is -- src/runtime.ts does not import src/mcp.ts), the
  sideband (src/sideband.ts: contract, socket, and hook clients
  unchanged), tool definitions (no TOOL_DEFS change, no count assertions
  touched), and the SQLite DB (stays per-process access to the shared
  file -- the issue's open question is answered "embeddings only").
- A CLI one-shot command that embeds (src/cli/commands/memory.ts:149,200)
  could reuse the same resolver for free; that is a deliberate non-goal
  for this change, recorded as a possible follow-up. Note: those one-shots
  construct the default model and ignore `THATCH_MODEL` today; the
  resolver's model-name handshake would surface that pre-existing
  inconsistency if reused there.

## The seams

New modules in `src/embed-daemon/`, each one concern, plus small wiring
changes elsewhere. The complete change surface:

1. `protocol.ts` -- the wire contract, pure code with no I/O: request and
   response types, the newline-delimited JSON codec, and the handshake
   message. Connection lifecycle, stated once here and inherited
   everywhere: a connection is connect, hello, ack, AT MOST ONE embed,
   close -- one embed per connection, matching the sideband's stateless
   shape; hello is the per-connection preamble, not a request on equal
   footing with embed (the doctor's probe is hello-close with no embed).
   The sideband's one-request-per-connection rationale is not recorded in
   git history, so the breadcrumb says "matches the sideband shape" and
   invents no rationale. Vector length is opaque to the protocol (the DB
   discriminates spaces by dimension; `THATCH_MODEL` may select a
   different-dimension model -- no 384 validation in the codec).

   Messages: `{"method":"hello"}` and
   `{"method":"embed","kind":"query"|"passage","text":"..."}`.
   Responses: `{"ok":true,"vector":[...],"model":"...","version":"...",
   "pid":N}` / `{"ok":true,"model":"...","version":"...","pid":N}` for
   hello / `{"ok":false,"error":"..."}`. The pid is consumed by the doctor
   line and the integration tests. Vectors are a few KB of JSON at the
   default 384 dimensions.

2. `client.ts` -- `RemoteEmbeddingModel implements EmbeddingModel`: forwards
   `queryEmbed`/`passageEmbed` to the daemon. The transport (a
   `connect(socketPath)` function) is injected, so tests supply an
   in-memory duplex pair. Every request carries a timeout (default 2 s,
   matching the sideband client's in-family precedent, injectable for
   tests): a wedged-but-live daemon destroys the socket at the timeout and
   the request delegates to local, so neither death nor wedge can hang a
   tool call. `resolveEmbeddingModel(dbPath, modelName, mode)` also lives
   here and returns SYNCHRONOUSLY: it constructs a stateful wrapper
   without probing; the probe and spawn happen lazily on the first embed
   (memoized; see Model acquisition policy). The wrapper's local fallback
   model is constructed lazily only when first needed, so a session
   served by a healthy daemon never imports the ONNX runtime at all --
   supported by the existing dynamic imports in src/embeddings.ts
   (transformers and onnxruntime load inside the pipeline factory and
   `configureBackend`).

3. `supervisor.ts` -- `ensureDaemonRunning(...)`: the spawn-once logic. At
   most one spawn attempt per process, guarded by a module-level promise
   following the `activeChecker` singleton idiom in src/version-check.ts,
   including a `_resetForTesting` hook. All inputs injected for tests: the
   connect probe, the spawn command builder, the wait timeout.

4. `daemon.ts` -- the daemon process body: binds the socket, serves embed
   requests from an injected `EmbeddingModel`, implements the handshake,
   arms the idle-exit timer. Wiring lands as a `Subcommand` in
   `src/cli/commands/misc.ts` (the `mcp` entry is the template) registered
   in the flat `REGISTRY` array in `src/cli/registry.ts`. The dispatcher
   opens the DB before `run()` and closes it after; like `mcp`, the daemon
   subcommand calls `ctx.db.close()` first -- the daemon must not hold a
   second DB handle.

5. `src/mcp.ts` -- the one integration point: line 197
   (`new BgeEmbeddingModel(modelName)`) becomes a synchronous
   `resolveEmbeddingModel(...)` call. The resolver is the only new symbol
   mcp.ts learns. In standalone mode the startup behavior seed
   (`seedDefaultBehaviors`) embeds immediately, so its first embed is the
   de-facto resolution point: the first standalone session warms or spawns
   the daemon at startup, which is exactly the issue's "first session
   starts the daemon." In bundled mode resolution happens on the first
   tool embed.

`SidebandServer` needs no change: it takes an `EmbeddingModel`, and a
remote-backed model satisfies it. Hook processes see the same sideband
behavior with a slightly longer embed hop (sub-millisecond inside one
machine; the sideband's 2 s client timeout dominates).

### Precondition: characterization test before the swap

No existing test boots `runMcpServer` (unit coverage stops at
`compileTools`/`compilePrompts`/teardown; only QA use cases drive a real
server over stdio, and qa-auto fixtures come from committed code only).
A boot-and-dispatch characterization test -- subprocess stdio, daemon knob
off so it exercises the local path -- lands BEFORE the resolver swap, so
the swap's first run is guarded. Refactor-first dependency, not optional.

## Model acquisition policy

`resolveEmbeddingModel` returns a wrapper synchronously; the policy runs
once, lazily, at the first embed (memoized for the process lifetime):

1. If `THATCH_EMBED_DAEMON=off` (registered knob), use the local model.
2. Probe the daemon socket with a hello handshake. A healthy daemon
   serving the same model name returns a `RemoteEmbeddingModel`.
3. No listener (connect fails with ENOENT or ECONNREFUSED):
   `ensureDaemonRunning` spawns the daemon detached (same binary as the
   spawning server -- `process.execPath` + `process.argv[1]`, which is the
   bin script in both modes), waits up to ~2 s for the socket,
   re-handshakes, and returns a `RemoteEmbeddingModel`.
4. Spawn failed, handshake failed, or model-name mismatch: use the local
   in-process `BgeEmbeddingModel` for the process lifetime (locked). A
   mismatch never spawns: the daemon exists but serves a different model
   space, so spawning another cannot help. A stderr note records the
   reason once.

Mid-life daemon death: a failed embed delegates that request to the lazy
local model and a stderr note is emitted on the FIRST such delegation (not
per embed -- no log spam). The next embed probes the socket again, so
recovery when a daemon returns is automatic. Recovery does NOT respawn:
the supervisor runs once per process, so a new daemon arrives only when a
new session resolves or someone runs `thatch embed-daemon` by hand;
sessions alive across an idle exit lazily load local models until then,
bounded by the local model's own 10-minute idle release. A WEDGED daemon
(alive, unresponsive) pays the per-request timeout, not a hang; after 3
consecutive timeouts the wrapper prefers local for a 60 s cool-down
before re-probing, so a wedge costs at most 3 slow embeds per minute
instead of +2 s on every embed. Both counters (timeout count, cool-down
window) are injectable, not env knobs. The step-4 lock applies only to
spawn decisions, never to serving requests.

## The handshake

Every connection starts with hello. The daemon answers with its model
name, package version, and pid. The model name is a hard check: embedding
vectors from different models are incompatible spaces (the DB stores the
model tag per entry and recall discriminates by dimension, not tag), so a
daemon serving a different `THATCH_MODEL` is treated as an UNUSABLE daemon
-- the client locks local for the process lifetime and never spawns.

The daemon is a new member of the long-lived-process version-skew class
that issue #6 and the `detectSkew` machinery (src/version-check.ts) govern.
This plan reuses those conventions rather than adding a parallel one: the
hello version is read from the same package version source, the stderr
warning matches detectSkew's tone, and daemon turnover after an upgrade
happens once traffic pauses (hellos do not keep a daemon alive, so a
daemon whose model no session wants idles out even under churn; a
same-name old daemon that still serves embeds is harmless -- raw embeds
are version-agnostic -- and exits when its traffic pauses). The named
cost of the model-change journey: every session that resolves during the
stale daemon's idle window is `local-locked` for up to
`THATCH_EMBED_DAEMON_IDLE_MS` (default 30 min), because a mismatch never
spawns -- after the window, fresh sessions get the right daemon. The
model-name check guards the upgrade window itself. The daemon does not
write the version file (MCP server startups write it; hook processes read
it for skew detection).

## State and transition matrix

Client-side resolver states (one per MCP server process):

| State | Entered by | Exits to |
|---|---|---|
| `unresolved` | process start (model still lazy) | `remote`, `local-locked` |
| `remote` | probe or spawn+handshake succeeded, model names match | `remote`, or per-embed local delegate on request failure (timeout counts as failure); after 3 consecutive timeouts, prefers local for a 60 s cool-down, then re-probes |
| `local-locked` | spawn failed, handshake failed, model mismatch, or knob off | terminal for the process lifetime |

Precedence rule: a failed embed while in `remote` delegates that one request
to the lazy local model and does NOT change state (the next embed re-probes);
only resolve-time failures lock `local-locked`. `local-locked` never
transitions back to `remote` within a process. A model mismatch at hello
goes directly to `local-locked` WITHOUT a spawn attempt.

Daemon process states:

| State | Entered by | Exits to |
|---|---|---|
| `starting` | spawn by supervisor (or manual `thatch embed-daemon`) | `serving`, `exited-quiet`, `exited-error` |
| `serving` | socket bound, hello answered | `exited-idle` |
| `exited-quiet` | SQLITE_BUSY at `BEGIN EXCLUSIVE` (another daemon holds the lock), or EADDRINUSE at bind | terminal, exit code 0 |
| `exited-error` | unexpected bind or IO failure | terminal, non-zero exit; the next supervisor spawn starts fresh |
| `exited-idle` | `THATCH_EMBED_DAEMON_IDLE_MS` with no EMBED requests (hello never re-arms the timer) | terminal; socket file left stale by design |

Precedence: an in-flight request outranks the idle timer (the timer re-arms
per request); the model's own 10-minute ONNX idle release runs inside
`serving` and does not change daemon state. A stale socket file
(`exited-idle` leftover) is unlinked by the next daemon only under the
lockfile protocol below.

## Daemon lifecycle

- Socket path: `cacheDir(dbPath)/embed.sock` -- the derivation
  (`tmpdir()/thatch-<sha256(dbPath)[:16]>`, src/version-check.ts) is
  re-derived inline rather than exported, matching the sideband's
  existing precedent (src/sideband.ts:15-18 duplicates the hash
  derivation rather than importing it), so src/version-check.ts stays
  untouched. The socket sits in the same hash-named, `thatch-`-prefixed
  tmpdir family as the sideband socket and version file; distinct
  filename, no collision.
- Spawn race and the lock: the lock is SQLite's own (Jeff's question,
  2026-11-19 -- SQLite is multi-process and coordinates via POSIX file
  locks on the db file, so the kernel manages ownership and releases it
  the moment the holder dies). The lock lives in its own tiny database,
  `embed.lock.db` in the same cacheDir as the socket -- deliberately NOT
  a held transaction on thatch.db, which would starve every MCP server,
  hook, and plugin instance of writes. The daemon opens the lock db with
  `busy_timeout = 0` and runs `BEGIN EXCLUSIVE`, holding the transaction
  open for its process lifetime. A second daemon's `BEGIN EXCLUSIVE`
  fails immediately with SQLITE_BUSY and it exits 0 quietly -- there is
  no unlink, no steal, no read-back: a dead holder's locks vanish with
  the process, so there is no stale lock and no recycled-pid residual.
  The holder needs no thatch.db handle at all (the daemon serves raw
  embeds only), so the lock db is its only database. Consequence: the
  losing daemon of a mass-start race exits BEFORE touching the socket,
  so the winner's live socket is never unlinked. CLIENTS NEVER UNLINK
  ANYTHING: the sideband client's unlink-on-ECONNREFUSED convention
  (src/sideband.ts:248-250) is NOT copied into the embed client.
- Bind-before-load invariant: the daemon binds the socket and answers
  hello BEFORE the model loads (the model is lazy inside the daemon, on
  first embed). The supervisor's ~2 s wait therefore succeeds at process
  start speed, and a slow model load can never convert cold starts into
  `local-locked` sessions. Pinned by a unit test.
- Idle exit: the daemon exits after `THATCH_EMBED_DAEMON_IDLE_MS` or the
  config file's `embedDaemon.idleExitMinutes` (default 30 min; precedence
  default < config.json < env, see ruling 3) with no EMBED
  requests. Hello never re-arms the timer -- hellos are free to the
  daemon's lifetime, so a daemon whose model no session wants (the
  `THATCH_MODEL`-change case) idles out even under heavy session churn,
  and upgrade turnover happens once traffic pauses rather than requiring
  a quiet machine. The timer re-arms per embed, and an in-flight request
  is never interrupted. Before exit -- idle or otherwise -- the daemon
  AWAITS `model.dispose()`: ONNX sessions must be explicitly released
  before process exit or Bun's NAPI finalizers panic (oven-sh/bun#34664;
  the same contract the MCP teardown enforces). The model inside the
  daemon keeps `BgeEmbeddingModel`'s existing 10-minute idle release, so
  a daemon past a burst holds runtime baseline only until exit.
- No orphans: the sqlite lock plus idle exit bound the daemon count to
  one per DB path per idle window. The kernel releases a dead holder's
  file locks immediately, so there is no stale-lock recovery path at
  all; a crashed daemon leaves only a stale socket file, which the next
  daemon unlinks under the lock after a failed connect probe.

## Testing strategy

Every policy branch maps to a test that can fail. All tests isolate paths
per the standing rule: temp `THATCH_DB_PATH`/`XDG_*` through the existing
harness helpers, `tests/clean-env.ts` preload as the backstop; no test may
resolve the real user db.

- Precondition (before the resolver swap): the characterization test --
  boot `runMcpServer` as a subprocess, dispatch one tool over stdio with
  the daemon knob off, assert the local path end to end.
- `protocol` unit: codec roundtrip, bad JSON, unknown method, hello vs
  embed shapes, vector-length opacity.
- `client` unit (injected in-memory transport): happy forward; per-embed
  fallback on connect failure; request timeout delegates to local
  (wedged-but-live daemon) and does not hang; self-healing (daemon
  returns mid-life); first-delegation stderr note emitted once; lazy
  local construction (assert the local model's `load()` is never called
  while the daemon serves); model mismatch locks local WITHOUT spawning.
- `supervisor` unit (injected probe/spawn, `_resetForTesting` between
  cases): probe hit skips spawn; one spawn attempt per process; spawn
  failure resolves local; wait-timeout path.
- `daemon` unit (real socket and lock db in a temp `cacheDir`, injected
  model and timers): serve/handshake with pid; idle exit does not fire
  mid-request; hello-only traffic idles out (hello never re-arms);
  `dispose()` awaited on every exit path; bind-before-load (hello
  answered before the model loads); SQLITE_BUSY loser exits 0 without
  unlinking the winner's socket; a dead holder's lock is acquirable
  (kernel release); stale socket unlinked under the lock after a dead
  probe; concurrent timeout storm trips the client cool-down.
- Integration (real processes, temp db, HERMETIC via the mock model --
  see the mock-model bullet below): two MCP servers on one DB resolve to
  one daemon (hello pid); embeds through the daemon return the mock
  model's deterministic vectors (end-to-end vector assertions, offline);
  killing the daemon leaves both servers serving via fallback; a fresh
  server spawns a new daemon.
- Mock model (Jeff's ruling 2026-11-19, option a): `THATCH_MODEL=mock`
  becomes a supported value in the embedding factory
  (src/embeddings.ts) -- a test-only branch returning deterministic
  vectors derived from the exact input text (query-prefix included), no
  network, no ONNX. This retroactively makes the `THATCH_MODEL: "mock"`
  values the QA use cases already set (uc-004, uc-142) real instead of
  aspirational.
- Existing tests upgraded with the mock (Jeff's directive, same ruling):
  sweep tests/ and tests/qa/ for use cases that either set
  `THATCH_MODEL=mock` aspirationally (uc-004, uc-142 -- today they can
  only assert failed-embed paths) or skip embed-path assertions for lack
  of a hermetic model, and extend them to assert the real mock-vector
  paths. The known instances are uc-004 and uc-142; the sweep is the
  deliverable, not a fixed list.
- QA: one new auto use case in `tests/qa/auto/` seeding a temp db and
  asserting the share-and-fallback contract, following the uc-128
  seeded-DB pattern and uc-142's stdio client pattern. Dependencies:
  register the UC in the `tests/qa/auto/index.test.ts` barrel (unregistered
  UCs silently never run); commit before qa-auto (fixtures come from
  `git archive HEAD`); stamp both tmpdir bases or set `TMPDIR` in the QA
  env (the spawned server's env drops TMPDIR while the test process
  resolves the /var/folders base).
- Harness defaults: `tests/clean-env.ts` and the QA runner env FORCE
  `THATCH_EMBED_DAEMON=off` -- the mechanism `THATCH_NO_NOTIFY=1` already
  uses (forced unconditionally, not defaulted-when-unset), so existing QA
  use cases keep testing the local path and never leak detached daemons.
  Only the new use case opts in, via the established set-and-restore
  pattern.

## Acceptance criteria (from the issue, made testable)

- One daemon per DB path: with N sessions on one DB, at most one process
  (the daemon) has the ONNX model loaded for that path; MCP sessions
  without a reachable daemon degrade to one local model each (integration
  test + live measurement). Other model holders (opencode serve, CLI
  one-shots) exist by design outside this plan's scope.
- Small per-session footprint: a daemon-served, idle MCP server stays well
  under 100 MB (no ONNX runtime import at all when the daemon is healthy).
- Unchanged behavior: store detection, branch scope, chat identity --
  exercised by the characterization test and the existing mcp test suites,
  which must pass unchanged.
- Fallback, two forms: at resolve time, an unreachable daemon triggers a
  spawn attempt, and only a failed attempt locks local (with a stderr
  note); at request time, a daemon that dies mid-life delegates embeds to
  the local model (with a one-time stderr note) and self-heals when a
  daemon returns. Recall and remember keep working in every branch.
- Clean lifecycle: no orphaned daemon after the last session exits plus
  the idle window; a stale socket file never blocks a new daemon; a
  daemon that loses the lock race exits without unlinking the winner's
  socket -- proven by unit tests over the lock protocol (SQLITE_BUSY
  exit 0, kernel release on holder death lets the next daemon acquire,
  EADDRINUSE exit 0).

## Observability and knobs

- stderr notes from the resolver (daemon pid, fallback reason, version-skew
  warning) and a one-time note from the client on first per-embed
  delegation; nothing on stdout (transport). The daemon's own stderr
  routes through the existing `createDebugLog` (src/debug.ts) when
  `THATCH_DEBUG` is set -- bind failures, `exited-error` reasons -- and
  is discarded otherwise, so the detached process never holds a terminal
  or a log file open in the steady state.
- `thatch doctor` gains one check named "embed daemon" (distinct from the
  existing opencode-daemon check) with three outcomes, none failing: a
  hello answer reports serving with model, version, and pid; no listener
  and no held lock reports not running (the designed steady state on
  opencode-only machines and after idle exit); the lock db reports held
  (SQLITE_BUSY) but no socket answers, reports blocked -- formation was
  won but the endpoint is not answering. Never a fail verdict. The probe
  is read-only: it must NOT reuse the sideband client's unlink-on-error
  behavior.
- New env knobs, registered in `src/env-knobs.ts` (the drift gate in
  tests/env-knobs.test.ts fails the build for unregistered `THATCH_*`
  literals; its KNOWN GAP means defaults need manual sync):
  `THATCH_EMBED_DAEMON` (`off` disables), `THATCH_EMBED_DAEMON_IDLE_MS`.
  Docs point at the registry rather than restating rows, per the
  codebase's stated convention. The config file section (see ruling 3)
  is the preference layer: precedence is built-in default 30 min, then
  config.json's `embedDaemon.idleExitMinutes`, then the env knob.

## Docs

- `docs/dev/features/multi-host.md` and `docs/dev/features/memory-store.md`:
  the daemon architecture, the resolver policy, the fallback contract.
- `docs/dev/features/doctor.md`: the new "embed daemon" check.
- `docs/dev/features/cli.md`: the new subcommand row in the Subcommands
  table (the dev-tier twin of the user CLI docs).
- `docs/user/doctor.md`: the same check in the user-tier "What it checks"
  list.
- `docs/user/cli.md`: the new subcommand, pointing at the env-knobs
  registry for knobs.
- The config file's `embedDaemon` section wherever config.json's sections
  are user-documented (docs/user/notifications.md and docs/user/README.md
  carry section docs today; the dev-tier twin in
  docs/dev/features/notifications.md covers the config machinery).
- Root README if it enumerates subcommands (grep at implementation time).

## Intent breadcrumbs

The implementation writes these docstrings/comments, one future-reader
question each:

- `protocol.ts`: why the daemon serves raw embeds and not the sideband's
  db-backed match methods (session state stays per session; issue #26's
  open question answered "embeddings only"); why the framing matches the
  sideband shape.
- `client.ts`: why the local fallback is lazy and per-embed re-probing
  exists (a session served by a healthy daemon never imports ONNX; a dead
  daemon never wedges a session); why the client never unlinks socket
  files (the daemon owns the endpoint; a client unlink can kill a live
  winner).
- `supervisor.ts`: why one spawn attempt per process (deterministic
  lifecycle; per-embed spawn attempts would stampede under races),
  following the `activeChecker` idiom.
- `daemon.ts`: why the lock is a held `BEGIN EXCLUSIVE` on a dedicated
  lock db rather than a transaction on thatch.db (holding thatch.db's
  write lock would starve every MCP server, hook, and plugin instance)
  and why the lock's lifecycle needs no stale handling (the kernel
  releases on holder death), why bind precedes model load (cold-start
  latency must never convert sessions to local-locked), and why dispose
  precedes exit (Bun #34664).
- `mcp.ts` resolver call site: why direct construction was replaced,
  pointing at issue #26.
- `embeddings.ts` mock branch: why a mock model name is supported in
  production source (hermetic embed-level tests at every tier; the QA
  use cases set `THATCH_MODEL=mock` already -- without the branch the
  value is aspirational and embeds fail).
- Bundled-mode participation: the plugin regime's founding rule has the
  bundled server skipping machine-shared state (sideband, version file)
  because a second holder would collide or flip-flop. The daemon is
  deliberately different: it has single-owner semantics (the sqlite lock), so
  bundled sessions may participate as clients/spawners. The breadcrumb
  records that reversal and why it is safe.

## Alternatives considered and rejected

- HTTP/SSE MCP transport (the native sharing): shares the whole server,
  collapsing session-scoped state; no lifecycle management. The issue's
  ruling stands.
- Third-party stdio multiplexers (mcp-mux, mcp-stdio-mux, mcp-proxy):
  proven in the wild but multiplex full MCP sessions -- eligibility rules,
  session-id routing, an external dependency -- to share something thatch
  only needs at one narrow seam.
- Primus pattern (the first MCP server doubles as the model holder): no new
  process type, but leader death forces election/steal logic and couples
  one session's lifetime to every session's model availability. The idle
  daemon is strictly simpler.
- Consolidating on the opencode serve process (host embeds for Claude Code
  too): the serve process exists only while opencode runs and is owned by
  the opencode host, so the full supervisor would still be needed -- same
  machinery bolted onto a much larger state surface, with MCP availability
  coupled to a second host's process model.
- Attacking the per-session constant instead (quantized models, backend
  default flip, shorter idle TTL): the scaling law is the problem, not the
  constant; active sessions hold the model regardless. Only a single
  holder changes the scaling.
- Extending the sideband protocol with an embed method instead of a new
  socket: the sideband does not even run on the affected path (bundled
  mode skips it) and has none of the multi-owner lifecycle the daemon
  needs (unconditional unlink-and-rebind); the hard part would be built
  anyway. Recorded as a possible daemon v2 (a future daemon could also own
  the sideband, fixing that collision properly), deliberately not this
  change.
- Moving DB access into the daemon: bigger surface, no need -- SQLite
  handles multi-process access to the shared file.
- flock-style packages (fs-ext's native `flock(2)`, proper-lockfile's
  mkdir + mtime staleness): superseded by ruling -- SQLite's own file
  locking on a dedicated lock db gives kernel-managed ownership and
  release-on-death with zero new dependencies (bun:sqlite is built in),
  which is strictly simpler than a native addon (fs-ext) and avoids
  proper-lockfile's mtime-refresh model, which fits operation-length
  locks, not a lifetime-long ownership lock.

## Known trade-off: embed latency under concurrency

The daemon concentrates all sessions' embeds into one wasm inference loop
(`ort.env.wasm.numThreads = 1` pins single-threaded), replacing N parallel
per-process models with one serialized queue. At the measured ~16-20 ms
per embed (wasm), even a 10-session burst stays under ~200 ms per embed --
well inside the sideband's 2 s timeout and invisible next to a model
completion. The plan accepts this trade-off and records the expectation;
the implementation PR's measurement step includes an N=10 concurrent-embed
timing to replace this estimate with a number.

## Rulings (Jeff, 2026-11-19)

1. Integration-tier hermeticity: **(a) -- mock model seam.** `THATCH_MODEL=mock`
   becomes a supported value in the embedding factory, so the integration
   tier and the QA use case assert real vectors hermetically, and existing
   tests that the mock improves get upgraded (see the testing strategy's
   mock-model bullet for the known instances and the sweep).
2. Bundled-mode participation: **(a) -- full participation.** Bundled
   (plugin-regime) sessions probe, connect, AND spawn the daemon like
   standalone sessions. The founding rule's exclusion reason (socket
   collision) is structurally gone under the single-owner lock, and the
   reversal is recorded in the intent breadcrumbs.
3. Idle exit: **30-minute default kept, and configurable through the user
   config file.** A new `embedDaemon` section in config.json
   (`idleExitMinutes: number`) joins the existing zod-validated sections
   in src/config.ts (strict section, field-level merge, null = unset).
   Precedence: built-in default 30 < config.json < `THATCH_EMBED_DAEMON_IDLE_MS`
   (the env knob stays the per-process escape hatch, explicit env beats
   the preference file). The section is host-agnostic on purpose: one
   daemon serves every stdio client -- Claude Code bundled, Cursor
   standalone, manual runs -- from one DB path, so a host-scoped key
   (e.g. `claude.service`) would mislabel the thing it configures.

## Release sizing

Not decided here. The landing is behavior-preserving with a default-on
optimization; release sizing stays Jeff's call at ship time.
