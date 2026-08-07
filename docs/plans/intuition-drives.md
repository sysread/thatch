# Intuition Drives

## Synopsis

A pre-response deliberation layer that runs on the first message of a new
opencode session: perception classifies the prompt, parallel drive sub-agents
react from their motivational lenses, and a synthesis pass distills them into a
directive injected into the main agent's context. opencode-only; requires
parallel sub-agent dispatch via Task.

## Background

Fnord runs as a CLI escript where every user invocation carries significant
intent because it requires a full command-line invocation. Its coordinator runs
an "intuition" step before responding: a perception pass classifies the prompt,
ten parallel "drives" (curiosity, skepticism, optimization, modularity,
convention, laziness, empathy, standing, pragmatism, stewardship) each react
from their lens, and a synthesis pass distills them into a directive injected
into the conscious agent's context.

In opencode's chat TUI, user messages have far less friction. Running the full
intuition pipeline on every message would burn tokens on "ok" and "yes." This
feature is gated to the first message of a new session only.

## Session detection

This feature depends on knowing "is this the first message of a new session."
The opencode plugin hook surface provides this:

- `session.created` fires ONLY when a brand-new session object is constructed
  (fresh creation or fork). It does NOT fire when a user resumes or continues an
  existing conversation (`--continue`/`--session` without `--fork` reuses the
  existing session ID).
- `chat.message` fires on every incoming user message but carries no turn
  number or first-message flag in its input or output.

Detection mechanism:
1. Track `session.created` events for top-level sessions (no `parentID`) in a
   `Set<string>`.
2. First `chat.message` for a session ID in that set = first message. Remove
   from set, trigger the feature.
3. Continued/resumed conversations never fire `session.created`, so they are
   never in the set. Second messages also don't trigger (already removed).

Edge cases:
- `--fork` fires `session.created` (correct: a fork is a new conversation).
- Plugin not running when the session was created (e.g., `--continue` of a
  session from a prior run): no `session.created`, no trigger (correct: it is a
  continued conversation, not new).
- Child sessions (sub-agents) fire `session.created` with a `parentID` —
  filtered out by the `parentID` check.

## What it does

On the first message of a new session, before the main agent responds, a
deliberation layer runs:

1. **Perception** — classify the prompt (interface, codebase, correction,
   continuation, meta, ambiguous) and produce a short first-person interpretation.
2. **Drive reactions** — parallel sub-agents, each arguing from a specific
   motivational lens. Drives are the same as fnord's: curiosity, skepticism,
   optimization, modularity, convention, laziness, empathy, standing, pragmatism,
   stewardship.
3. **Synthesis** — distill the drive reactions into a single directive injected
   into the main agent's context.

## Why port it

No existing skill does pre-response deliberation. The drives carry real
personality and map to Jeff's stance (stewardship = "correctness over comfort";
skepticism = "no reassurance without verification"). The parallel sub-agent
dispatch is natural for opencode's Task tool.

## Constraints

- **opencode-only.** Requires parallel sub-agent dispatch via Task. Claude Code
  agents running skills cannot spawn sub-agents.
- **First-message-only.** Gated by the session-detection mechanism above.
  Running on every message would burn tokens on trivial follow-ups.
- **Prompt injection, not a tool.** The synthesis output is injected as a
  synthetic text part into the first `chat.message`, like the recall nudge. The
  main agent sees it as context, not as a tool result.
- **No pre-response hook exists.** The synthesis must complete inside the
  `chat.message` hook (before the LLM loop runs) or be injected as a system
  message via `experimental.chat.system.transform`. The hook fires before the
  message is persisted and before the LLM loop starts, so a synchronous
  sub-agent dispatch inside `chat.message` would block the turn. The
  `experimental.chat.system.transform` hook is a better injection point because
  it runs on every turn and can append to the system prompt — but it does not
  have access to the user's message text. A hybrid: compute the synthesis in
  `chat.message` (which has the prompt text), cache it in a per-session map, and
  inject it in `experimental.chat.system.transform` on the same turn.

## Open questions

1. **Latency.** Ten parallel sub-agent calls add latency to the first turn. Is
   the value worth it? Options: reduce to 3-4 drives, run drives with a fast
   model, or make it opt-in.
2. **Injection point.** The `chat.message` hook fires before the LLM loop but
   injecting a synthetic part there adds it to the user message, not the system
   prompt. `experimental.chat.system.transform` can append to the system prompt
   but fires on every turn and lacks the user message text. The hybrid
   (compute-in-chat.message, inject-in-system.transform) requires a per-session
   cache with one-turn TTL.
3. **Drive selection.** Fnord runs all 10 drives. A smaller set (stewardship,
   skepticism, pragmatism, empathy) might capture 80% of the value at 40% of the
   cost.

## Decisions

| Decision | Rationale |
|----------|-----------|
| opencode-only | Requires parallel sub-agent dispatch via Task |
| First-message-only | Chat TUI has low message friction; running on every message wastes tokens |
| Detection via session.created + chat.message | session.created fires only on new sessions; chat.message provides the first-message trigger |
| Parallel drives via Task sub-agents | Matches fnord's architecture; drives are independent and parallelizable |
| Injection via system.transform with chat.message cache | chat.message has the prompt text; system.transform can append to the system prompt; hybrid avoids blocking the turn |

## Architecture

```
session.created (top-level, no parentID)
  → add sessionID to newSessions Set

chat.message (first message for sessionID in newSessions)
  → remove from newSessions
  → perception + parallel drives + synthesis → cache in Map<sessionID, directive>

experimental.chat.system.transform
  → if directive cached: append directive, then clear cache (one-shot)

session.deleted
  → delete from directive cache, newSessions set
```

## Dependencies

### Runtime

- Fast model for perception and drive reactions (parallel sub-agents)
- Task tool for parallel drive dispatch (opencode sub-agent support)

### Built-in

- Plugin hooks: `event` (session.created, session.deleted),
  `chat.message`, `experimental.chat.system.transform`
- In-process `Map` for per-session caching (directive, newSessions set)
