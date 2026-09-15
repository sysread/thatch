# Claude Code and Cursor Chat Parity

## Synopsis

The cross-session chat feature shipped with MCP host support for Claude Code
and Cursor, but neither host was ever tested against it. This plan closes the
gaps found in the September 2026 audit. The goal: a Claude Code or Cursor user
gets a consistent chat feature, even where it is more limited or more manual
than opencode.

The audit (2026-09-15, main @ 41d3938) verified by running the real paths:

| Mechanism                        | Claude Code              | Cursor                     |
| -------------------------------- | ------------------------ | -------------------------- |
| MCP chat tools (all 7)           | works                    | works                      |
| Hook identity anchor             | works (UserPromptSubmit) | works (beforeSubmitPrompt) |
| Mail delivery at prompt time     | works                    | unverified output contract |
| Manual fallbacks (CLI, register) | works                    | works                      |

## Background

Chat identity on MCP hosts works like this. The flush-tools hook reads the
host session id from stdin (Claude Code sends `session_id`, Cursor sends
`conversation_id`), hashes it into a stable `mcp_<12 hex>` id, and
ensure-registers it. Every prompt, the hook prints "you are NAME (mailbox)".
The model then passes `as: NAME` on chat tools. This was tested end to end
and works on both hosts.

Five gaps came out of the audit:

1. Identity first appears at the first prompt, not at session start. The
   `reminder` command reads no stdin, although both hosts send an id there.
2. Cursor's `beforeSubmitPrompt` output contract is undocumented. We emit
   `{ additional_context }`, which is documented for `sessionStart` but not
   for `beforeSubmitPrompt`. If Cursor drops it, Cursor models never see
   their identity at prompt time.
3. Identity spoofing: on MCP hosts, `resolveChatIdentity` trusts the
   caller's `as`. Any conversation can claim another session's name and read
   its mail. opencode is immune (host-injected identity).
4. Nothing is written down for Claude Code / Cursor users: not the flow, not
   the cloud-agent limits, not the manual fallbacks.
5. Small doc drift: a name pruned after a week idle comes back under a new
   name; the code comment on `reminder` claims SessionStart passes no stdin,
   which is wrong for both hosts.

## Steps

Work proceeds top to bottom. Each step is independently shippable.

### Step 1: session-start identity (reminder reads stdin)

Read the hook stdin JSON in the `reminder` command and pass the id to
`chatHookLine`, same as flush-tools does. Accept both `session_id` and
`conversation_id`. Stdout shape stays as-is: plain text for Claude Code,
`{ additional_context }` with `--json` for Cursor.

Effect: identity plus mailbox status prints at session start on both hosts.
This also shrinks gap 2: even if Cursor's `beforeSubmitPrompt` drops the
context, the Cursor model still learns its name once per session.

Files: `bin/thatch` (reminder case, chatHookLine is already there). Fix the
wrong "SessionStart does not read stdin" comment in the same commit.

Verification: pipe a fake stdin payload into `thatch reminder` and confirm
the identity line and a stable `mcp_` id across runs. Extend the auto QA
use case that covers hook output if one exists.

### Step 2: live Cursor test of beforeSubmitPrompt output

DONE 2026-09-15, live Cursor session in this repo. Results:

- `beforeSubmitPrompt` DOES deliver `additional_context`. The model quoted
  the flush-tools hook line verbatim, unread count included. The July 2026
  memory flagged this as assumed; it is now verified.
- Identity is stable: one name at session start, same name at every later
  prompt (`mervyn-of-the-pumpkin-patch-00002`). No drift.
- Round trip verified in both directions: opencode sent mail that the
  Cursor model saw at its next prompt (hook line reported the unread
  count, model called `chat_read`), and the Cursor model replied via
  `chat_send`, which arrived in opencode as a wake with the framed inbox.
- One artifact: `sessionStart` can mint throwaway identities before the
  real conversation anchors (two single-registration rows, one with
  project `unknown`, from workspace-restore contexts). They go idle
  immediately and prune out after a week. Roster noise, not a bug.
- Jeff launches Cursor from the Dock. A minimal GUI environment kills
  `#!/usr/bin/env bun` (verified with `env -i`: "No such file or
  directory"), yet these hooks fire and complete. Cursor's hook runner
  evidently resolves more than the bare LaunchServices PATH on this
  machine. Portability footnote: a user whose GUI environment lacks the
  bun install dir on PATH gets silently dead hooks; the fix shape would
  be a wrapper script that sets PATH before exec. Not needed here.


### Step 3: user docs for Claude Code and Cursor

Rewrite the opening of `docs/user/cross-session-chat.md`, which currently
reads "lets your opencode sessions talk to each other". Add a section for
non-opencode hosts covering:

- the identity flow (hook prints your name every prompt; the model passes
  `as` on chat tools)
- delivery model (no wake; mail appears at the next prompt; check
  `chat_status`)
- manual fallbacks (`chat_register` self-bootstrap when no hook is
  installed; `thatch chat list` and `thatch chat tail` work everywhere)
- cloud-agent limits (Cursor cloud agents run no client-side hooks: no
  identity anchor, no mail lines; MCP tools still work)
- name churn (a conversation idle past the prune window comes back under a
  fresh name; mail to the old name is swept)

### Step 4: spoofing decision (blocked on Jeff)

Design call, not a bug fix. Options, cheapest first:

- **Do nothing.** Threat model is one user's machine; every session already
  runs as the same OS user. Document the limit in the security model section
  of the user doc.
- **Hook-delivered secret.** The hook generates a per-session token, stores
  it keyed by the hashed session id, and prints it with the name. Chat tools
  require `as` plus the matching token. Cost: a new required argument on
  every chat tool for MCP hosts, and the token still transits the same
  model context an attacker would read. Closes casual spoofing, not a
  determined one.
- **Do not adopt anything stronger.** The hook channel and the tool calls
  share one context; there is no channel a local attacker cannot read.

Recommendation: option 1 now, revisit if a real multi-tenant use appears.

### Step 5: close out

- Run `mise run check` (typecheck, tests, markdownlint).
- Fold anything learned in step 2 into the audit memory.
- Graduate this doc: once the steps land, the durable parts live in
  `docs/user/cross-session-chat.md` and the dev feature docs. Delete this
  file and note the move, per the plans graduation convention.

## Step 4.5: post-turn mail delivery (Cursor stop hook)

IMPLEMENTED 2026-09-15 (`thatch chat-notify`, wired into `setup --cursor`
with `loop_limit: 3`, uc-105 pins the contract). Live Cursor test pending:
after re-running setup and restarting Cursor, send mail while a Cursor
turn runs and confirm the follow-up arrives at turn end without a new
user prompt.

The gap: mail arriving during or after a turn has no delivery vector in
Cursor. The hook line only runs at prompts (beforeSubmitPrompt) and session
start. opencode's poller wakes idle sessions; Cursor has no analog today.
Mail that lands after the last prompt waits for the user's next keystroke.

Research against current Cursor hook docs (2026-09-15), delivery-capable
events assessed:

| Event               | Can deliver? | Verdict                                        |
| ------------------- | ------------ | ---------------------------------------------- |
| `stop`              | yes          | **the fix** - see below                        |
| `postToolUse`       | `additional_context` mid-turn | too noisy, N fires per turn   |
| `subagentStop`      | `followup_message` | wrong scope (Task sub-agents)           |
| `preCompact`        | `user_message` shown at compaction only | marginal          |
| `afterAgentResponse` / `afterAgentThought` | no output fields   | observational only |
| `sessionEnd`        | fire-and-forget | cleanup use only                            |

The `stop` hook contract (verified):

- Input: common schema plus `status` (`completed` | `aborted` | `error`)
  and `loop_count` (how many follow-ups this hook already triggered,
  starting at 0). `conversation_id` is documented "stable across many
  turns", so `mcpSessionID(conversation_id)` resolves the same chat row
  the other hooks anchor.
- Output: `{ "followup_message": "..." }` - non-empty means Cursor
  auto-submits it as the next user message. A real wake.
- Built-in loop safety: `loop_limit` per script, default 5; natural
  termination because once the model reads its mail the unread count
  drops to 0 and the hook emits `{}`.
- Runs in cloud agents, but their VMs lack the local thatch.db, so the
  mailbox check is empty there. Exception: self-hosted pool workers run
  on the user's machine, where it would work.

Design for `thatch chat-notify`:

1. New CLI subcommand: reads the hook stdin (`conversation_id`), looks up
   unread mail for `mcpSessionID(id)`, prints `{ followup_message }` when
   unread > 0, `{}` otherwise. Plain text body never included - the
   notification is a pointer, bodies flow only through the framed
   `chat_read`.
2. The follow-up text reuses the opencode wake shape
   (`chatNotificationNudge`): sender names + count + the load-bearing
   system-notification framing. The follow-up arrives as a user message,
   so the "not user input, do not auto-reply, stop and wait" wording is
   mandatory (same lesson as the tier-0 extraction nudge).
3. `thatch setup --cursor` writes the hook: `{ "command": "<bin>
   chat-notify", "loop_limit": 3 }`. `replaceCursorThatchHooks` already
   does idempotent per-event replacement.
4. Claude Code's Stop hook has a different contract
   (`decision: "block"` + `reason` forces continuation - invasive) and
   `additionalContext` without block only lands in the transcript for the
   next turn, which UserPromptSubmit already covers. Skip Claude Code for
   v1; revisit if the prompt-time model proves annoying in practice.



- Wake delivery on MCP hosts. Neither Claude Code nor Cursor can start a
  turn from outside; the prompt-time delivery model is the ceiling.
- Codex support. Not a thatch host.
- Network relay or multi-machine chat.
