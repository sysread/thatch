# External chat connectors

**Status: PROPOSED - explicitly unscheduled.** Co-written 2026-10-30 with Jeff's nak session over cross-session chat; this file is the THATCH half and the shared contract. The NAK half lives in the nak repo at `docs/dev/in-progress/connector-chat-plan.md` (nak main, commits 5973e131 + 91503945), cross-referenced both ways. Nak is the first candidate driver and is deliberately never named in the contract.

## Ruling context

Jeff's hard requirement: the thatch side must be fully generic - "bridge an external message system into thatch chat as a participant." Most thatch users have never heard of nak; the interface stands on its own.

## The contract (shared, normative)

A **connector** is a configured driver process that represents an external message system as a chat participant. Thatch's contract with a driver is three operations and one invariant:

1. **Register** - the connector's participant identity is created from EXPLICIT CONFIG (thatch config's connectors list). A driver cannot mint participants by existing; a random script cannot become a participant. Identity mechanics reuse the chat directory's existing machinery: a stable synthetic session ID (`conn_<hash>` form, the `mcp_<hash>` precedent - the underscore keeps it outside NAME_CHARSET so it can never shadow a real session ID), a roster name under the never-reused-name rules, tombstones on removal.
2. **Sync** - the driver's one primitive: `thatch connector sync <name>`. One round trip per beat: returns the participant's undelivered mail (JSON), accepts inbound bodies (JSON), stamps delivered. Atomic per beat. No LLM, no host session involved.
3. **Liveness by beat** - the roster row's `host_kind` gains a third value, `connector` (alongside `opencode` = poller-driven, `mcp` = turn-driven): `last_seen` is the driver's last sync beat; STALE after ~3 missed beats. Mail to a stale participant is durable and waits (the mailbox is the point).
4. **Wake: none** (poll-only by design). A connector has no host process to prompt. The beat budget sets end-to-end latency - a driver wanting snappy replies beats faster; thatch does nothing special.

Wire format: the sync JSON shapes are pinned (test fixtures as the executable spec), and multi-part bodies CARRY their split markers so an external system reassembles deterministically (chat bodies auto-split at 2000 chars - the markers must survive the wire).

Trust: local-user trust - the driver runs as the user on the machine, the same level every `bin/thatch` subcommand already has. No network surface is added. Injection hygiene is the existing three layers, unchanged: chat_read's untrusted frame, the echo filter, the anti-loop wake wording. External content is untrusted content - already the house model.

## Thatch side (this repo)

- `src/chat.ts`: the `connector` host kind (liveness semantics + roster/STALE rendering); the sync handler (atomic: deliver-out + accept-in + stamp).
- `bin/thatch`: `connector sync <name>` (+ `connector list` if the roster rendering needs a friend).
- Config: the connectors list (names + optional display metadata) in thatch config.
- Tests: a QA uc for the sync round trip (the seed-db pattern); roster STALE rendering; wire-format reassembly.
- Deferred (deliberately, documented): push delivery via the sideband socket (the local-IPC precedent exists); a blocking `connector wait` long-poll.

## Nak side (cross-reference: nak repo, `docs/dev/in-progress/connector-chat-plan.md`, nak main 5973e131)

- **Driver**: a Mac-resident process (launchd, or an opencode plugin - notably the same host as the earlier resident-worker idea: one resident bridge, two duties), bridging the sync subcommand to nak's connector ingest route.
- **Ingest route**: `POST /connector/ingest`, authenticated by a per-connector secret held in nak's app_config (project-global service config, written only by setup tooling; no service key in the driver; RLS untouched; b-strict owner stamping).
- **Proxy table**: message history for the connector thread, owner-scoped.
- **Headless connector turn**: nak already runs server-side agents without a browser (its reflection/wiki fleet); the same machinery fires the owner's chat model over the proxied history when mail arrives (or on a sweep) and writes the reply back to the table - the driver's next beat carries it out. Nak-the-assistant genuinely replies.
- **Exclusions**: connector threads are excluded from reflection / samskara / wiki / bias eligibility - the contamination class nak's tabled-personas feature already mapped.

## Open questions

- Driver as launchd vs opencode plugin (one resident bridge, two duties - the worker-idea overlap).
- Push evolution via the sideband socket; the blocking `connector wait` long-poll.
- Whether connector participants appear in `broadcast` recipients (leaning yes - they are roster rows - but the beat cost is paid by the driver's sync, not a wake).
