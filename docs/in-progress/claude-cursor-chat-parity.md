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

Manual step, needs a real Cursor session on a machine with Cursor installed.

1. Run `thatch setup --cursor --local` in a test repo.
2. Start a Cursor conversation, check whether the identity line reaches the
   model (ask it "what name did your thatch hook print?").
3. Send the session mail from an opencode session; confirm the model sees
   the pending-mail line at the next prompt.

Outcomes: if `additional_context` works, record that in the memory and in
the user doc. If not, the mitigation from step 1 covers identity, and the
user doc gains a "Cursor shows mail at session start only" note. Record the
result either way; the July 2026 memory flagged this as assumed, never
verified.

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

## Non-goals

- Wake delivery on MCP hosts. Neither Claude Code nor Cursor can start a
  turn from outside; the prompt-time delivery model is the ceiling.
- Codex support. Not a thatch host.
- Network relay or multi-machine chat.
