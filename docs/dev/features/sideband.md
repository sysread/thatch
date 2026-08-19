# Sideband IPC (MCP Hosts)

A Unix domain socket server that lets one-shot hook processes borrow the MCP server's warm embedding model. Without this, each hook invocation would load the ~34 MB model from scratch, adding 300-700 ms to every prompt.

## What it does

- Unix domain socket at a deterministic path derived from the DB path
- Three request methods: match (recall), predictions, behaviors
- One embedding round-trip per request (all three methods share the model)
- 2-second timeout, null on failure (callers skip the nudge gracefully)
- Stale socket cleanup on connection error

## How it works

### The problem it solves

Claude Code and Cursor spawn a fresh process for each hook invocation (`thatch flush-tools`, `thatch reminder`). These processes need the embedding model to embed the user's prompt for the recall/prediction/behavior nudges. Loading the ~34 MB model on every prompt would add unacceptable latency.

The MCP server is long-lived (kept alive by the host's stdio connection) and has the model warm in memory. The sideband socket lets hook processes ask the warm server to do the embedding work.

### Socket path

The path is derived from a SHA-256 hash of the DB path (first 16 hex chars), under os.tmpdir():

```text
$TMPDIR/thatch-<sha256(dbPath)[0:16]>.sock
```

Both the MCP server and hook processes compute the same path independently (from `THATCH_DB_PATH` or the default under `XDG_CONFIG_HOME`). No out-of-band coordination needed.

Changing `THATCH_DB_PATH` moves the socket. A stale socket from a crash is cleaned up on ECONNREFUSED/ENOENT.

### Protocol

Newline-delimited JSON. One request per connection, one response.

Request:

```json
{"method":"match|predictions|behaviors","text":"...","stores":[...],"threshold":N,"limit":N}
```

Response (success):

```json
{"ok":true,"matches":[...]}
```

```json
{"ok":true,"predictions":[...]}
```

```json
{"ok":true,"behaviors":[...]}
```

Response (failure):

```json
{"ok":false,"error":"..."}
```

### Three methods

1. **match** -- embeds text, runs `db.search` across stores, returns matches with score >= threshold as `{label, score, store}`
2. **predictions** -- embeds text, calls `db.scorePredictionNudge`, returns scored prediction nudge items
3. **behaviors** -- embeds text, calls `db.scoreBehaviorNudge`, returns scored behavior nudge items

### Client helpers

- `sidebandMatch(text, stores, threshold, limit)` -- returns matches or null on failure
- `sidebandPredictions(text, stores, threshold, limit)` -- returns predictions or null
- `sidebandBehaviors(text, stores, threshold, limit)` -- returns behaviors or null

All three return null on any failure (server not running, stale socket, timeout, parse error). Callers must treat null as "skip the nudge, fall back gracefully."

### Graceful degradation

If the socket isn't available (MCP server not running, old version, stale socket, >2s timeout), `sidebandMatch` returns null and `flush-tools` falls back to the static write nudge. The recall/prediction/behavior nudge is best-effort -- its absence never blocks the agent's workflow.

### Server lifecycle

- Opened at MCP server startup (`src/mcp.ts`). Failure is non-fatal (only the prompt-aware recall/prediction/behavior nudge degrades).
- Closed + socket file removed on shutdown (stdin close).

## Interactions with other features

- Nudge pipeline ([nudge-pipeline.md](nudge-pipeline.md)): MCP hosts use the sideband socket for all three nudge tiers (recall, prediction, behavior)
- Multi-host ([multi-host.md](multi-host.md)): only MCP hosts (Claude Code, Cursor) use the sideband; opencode has the model in-process
- Prediction engine ([prediction-engine.md](prediction-engine.md)): predictions method
- Behavior engine ([behavior-engine.md](behavior-engine.md)): behaviors method
- Memory store ([memory-store.md](memory-store.md)): match method uses `db.search`

## Source files

- `src/sideband.ts` -- SidebandServer (server side) + sidebandMatch/sidebandPredictions/sidebandBehaviors (client helpers)

## Key invariants

- Socket path = SHA-256 of DB path. Both sides compute it independently.
- Sideband failure never blocks. All client helpers return null on failure.
- One embedding per request (all three methods share the model).
- 2-second timeout default.
- Stale socket cleanup on ECONNREFUSED/ENOENT.
