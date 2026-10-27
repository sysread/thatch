/**
 * The redo command's core: parse a perl-style substitution, apply it to the
 * last real user message, and (on a match) revert the exchange and resubmit
 * the edited text. Docs: docs/dev/features/opencode-plugin.md (the redo
 * command section) and docs/user/commands.md (/s).
 *
 * SDK-free under the same isolation rule as src/index.ts and
 * src/session-tab-shared.ts: zero SDK imports, and every client operation
 * arrives as an injected narrow interface (RedoSessionOps), so the
 * destructive-ordering invariant ("nothing touches the session until the
 * edited text exists and differs") is unit-tested with mocks instead of
 * wired-and-hoped against a live TUI.
 *
 * The name is /s: opencode v2 ships a built-in /redo that CANCELS a staged
 * undo (the inverse of /undo), so this command takes the free slash name.
 * The built-in /redo remains the recovery path for this command's own
 * failures, which every guard toast points at.
 */

/**
 * The message shape the orchestration reads, flattened from the v2 message
 * union (SessionMessageInfo): only user messages carry prompt text, and
 * only synthetic messages are chat-wake turns, so `text` is optional. The
 * wiring maps the SDK union into this; tests build it directly.
 */
export interface RedoMessage {
  id: string;
  type: string;
  text?: string;
  /** Epoch ms - orders the delivered-wake guard against the target. */
  created: number;
}

/** One page of the message.list endpoint, narrowed to RedoMessage. */
export interface RedoMessagePage {
  data: RedoMessage[];
  cursor: { next?: string | null };
}

export interface MessagePageInput {
  limit?: number;
  order?: "desc";
  cursor?: string;
}

/**
 * The client operations the orchestration needs, in the order the flow
 * uses them. The wiring implements these over the plugin's OpenCodeClient
 * (flat surface: client.session.* / client.message.* - no `.api` indirection;
 * that spelling is the built-in TUI's own wrapper).
 */
export interface RedoSessionOps {
  /**
   * Paged walk of message history, newest first, stopping at the first real
   * user message (see walkMessages). NOT the plugin data layer's list: that
   * is a reactive newest-20 window, and a routine agentic turn pushes the
   * target out of it.
   */
  fetchMessages: (sessionID: string) => Promise<RedoMessage[]>;
  /** The session's staged-revert state: revert.messageID, or undefined. */
  stagedRevertMessageID: (sessionID: string) => Promise<string | undefined>;
  /** How many inbox rows are queued for the session (undelivered mail). */
  pendingInboxCount: (sessionID: string) => Promise<number>;
  /** The /undo trio's first two steps: interrupt the running turn, then wait for it to settle. */
  interruptAndWait: (sessionID: string) => Promise<void>;
  /** Stage the revert at a message: the same server-side revert /undo uses. */
  revertStage: (sessionID: string, messageID: string) => Promise<void>;
  /** Submit a new user message to the session. */
  resubmit: (sessionID: string, text: string) => Promise<void>;
}

/** The typed parse result (callers render toasts; nothing throws). */
export type ParsedSubstitution =
  | { ok: true; pattern: string; replacement: string; flags: string }
  | { ok: false; error: string };

/** The typed apply result: the substituted text and whether anything changed. */
export type ApplyResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: string };

/** The typed outcome the wiring renders as a toast. */
export type RedoOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; variant: "info" | "warning" | "error" };

/** A valid delimiter: the perl rule - one punctuation character, not alphanumeric, whitespace, or backslash. */
function isDelimiter(char: string | undefined): boolean {
  if (char === undefined || char.length !== 1) return false;
  if (/[a-zA-Z0-9]/.test(char)) return false;
  if (/\s/.test(char)) return false;
  if (char === "\\") return false;
  return true;
}

const VALID_FLAGS = new Set(["g", "i", "m", "s", "u"]);

/**
 * Parse `<s?>[delim]PAT[delim]REPL[delim]<flags>`.
 *
 * The leading `s` (the perl verb) is optional and fires only when the next
 * character is a valid delimiter, so `s/foo/bar` and `/foo/bar` parse
 * identically and delimiter-first input is unambiguous. Backslash-escaped
 * characters do not close a segment (`/a\|b/c/` splits at the unescaped
 * delimiters); their backslashes stay in the text for the regex engine.
 * Flags are the subset `g i m s u`, deduplicated; an unknown flag is a
 * parse error naming it. No `g` means first match only (the perl default).
 */
export function parseSubstitution(input: string): ParsedSubstitution {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "empty substitution - expected s/PAT/REPL/flags" };
  }
  let rest = trimmed;
  // The s-strip is safe precisely because a delimiter never is "s": the
  // verb can only be present when the next character starts the pattern.
  if (rest[0] === "s" && isDelimiter(rest[1])) rest = rest.slice(1);
  const delim = rest[0];
  if (!isDelimiter(delim)) {
    return {
      ok: false,
      error: `bad delimiter ${JSON.stringify(delim)} - start with any punctuation character (not a letter, digit, whitespace, or backslash), e.g. s/foo/bar/`,
    };
  }
  // Split PAT and REPL on unescaped delimiters; everything after the third
  // delimiter is the flags tail.
  const segments: string[] = [];
  let current = "";
  let i = 1;
  for (; i < rest.length && segments.length < 2; i++) {
    const char = rest[i];
    if (char === "\\" && i + 1 < rest.length) {
      current += rest[i] + rest[i + 1];
      i++;
      continue;
    }
    if (char === delim) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (segments.length < 2) {
    return { ok: false, error: `malformed s/// - expected two ${JSON.stringify(delim)} delimiters (s${delim}PAT${delim}REPL${delim}flags)` };
  }
  const [pattern, replacement] = segments;
  const flagsTail = rest.slice(i);
  const flags: string[] = [];
  for (const flag of flagsTail) {
    if (!VALID_FLAGS.has(flag)) {
      return { ok: false, error: `unknown flag ${JSON.stringify(flag)} - supported flags are g i m s u` };
    }
    if (!flags.includes(flag)) flags.push(flag);
  }
  return { ok: true, pattern, replacement, flags: flags.join("") };
}

/**
 * Translate perl replacement escapes to the JavaScript replace() dialect:
 * `\1`..`\9` become `$1`..`$9` (JS reads those as capture groups), `\n` and
 * `\t` become literal newline/tab, and `$1` passes through natively. Any
 * other backslash pair stays as written.
 */
export function translateReplacement(replacement: string): string {
  let out = "";
  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i];
    if (char !== "\\" || i + 1 >= replacement.length) {
      out += char;
      continue;
    }
    const next = replacement[i + 1];
    if (next >= "1" && next <= "9") {
      out += "$" + next;
      i++;
      continue;
    }
    if (next === "n") {
      out += "\n";
      i++;
      continue;
    }
    if (next === "t") {
      out += "\t";
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Compile the parsed substitution into a RegExp and run it. Unicode mode is
 * appended (deduplicated - a user-supplied `u` must not produce "uu"); on a
 * compile error there, the compile retries WITHOUT `u`, because Unicode
 * mode rejects some identity escapes (like `\:`) that legacy mode accepts.
 * A second failure returns the engine's error text verbatim - nothing is
 * touched. `changed` is the no-match signal: text inequality, so a match
 * that produces identical text aborts the redo exactly like no match.
 */
export function applySubstitution(text: string, parsed: ParsedSubstitution): ApplyResult {
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const replacement = translateReplacement(parsed.replacement);
  const withU = parsed.flags.includes("u") ? parsed.flags : parsed.flags + "u";
  let regex: RegExp;
  try {
    regex = new RegExp(parsed.pattern, withU);
  } catch (unicodeError) {
    try {
      regex = new RegExp(parsed.pattern, parsed.flags);
    } catch {
      return { ok: false, error: (unicodeError as SyntaxError).message };
    }
  }
  const replaced = text.replace(regex, replacement);
  return { ok: true, text: replaced, changed: replaced !== text };
}

/** The built-in's exact target filter, over the flattened union: a user message with prompt text. */
function isRealUserMessage(message: RedoMessage): boolean {
  return message.type === "user" && !!message.text?.trim();
}

/**
 * Paged walk of the message.list endpoint in desc order, stopping as soon
 * as a page contains a real user message (the target and everything newer
 * than it - the delivered-wake guard's range - is now in hand) or history
 * exhausts. The hard page cap is a runaway-cursor guard, not a semantic
 * limit: a well-behaved server terminates the walk at the target or the
 * oldest message long before it.
 */
export async function walkMessages(page: (input: MessagePageInput) => Promise<RedoMessagePage>, pageSize = 100): Promise<RedoMessage[]> {
  const messages: RedoMessage[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const result = await page({ limit: pageSize, order: "desc", cursor });
    messages.push(...result.data);
    if (messages.some(isRealUserMessage)) return messages;
    const next = result.cursor.next;
    if (!next) return messages;
    cursor = next;
  }
  return messages;
}

/** Guard verdicts for the state matrix rows, surfaced for tests. */
export type RedoGuard =
  | { ok: true }
  | { ok: false; message: string; variant: "info" | "warning" | "error" };

/**
 * The three pre-revert guards, in matrix order. Every abort happens BEFORE
 * the revert - nothing is touched until the edited text exists and differs.
 */
export async function checkGuards(ops: RedoSessionOps, sessionID: string, messages: RedoMessage[], target: RedoMessage): Promise<RedoGuard> {
  // Staged-undo guard: after a built-in /undo the undone messages stay in
  // the store and would look like a valid target; a resubmit now would
  // commit the staged revert and delete everything from it. The built-in
  // /redo cancels the staged state instead.
  const staged = await ops.stagedRevertMessageID(sessionID);
  if (staged !== undefined) {
    return { ok: false, variant: "warning", message: "an undo is staged - cancel it with the built-in /redo first" };
  }
  // Pending-inbox guard: the resubmit commits the staged revert, which
  // deletes queued inbox rows - chat mail delivered in the gap would be
  // stamped delivered and silently lost.
  const pending = await ops.pendingInboxCount(sessionID);
  if (pending > 0) {
    return {
      ok: false,
      variant: "warning",
      message: `${pending} queued message${pending === 1 ? "" : "s"} pending - a redo would delete them; clear the queue first (or use /undo)`,
    };
  }
  // Delivered-wake guard: a chat wake that already ran sits in the range
  // the revert would delete, and its mail is stamped delivered - silent
  // loss on the success path. The built-in /undo has the same hole
  // (inherited); this command can be stricter one findLast away.
  const wake = messages.find((message) => message.type === "synthetic" && message.created > target.created);
  if (wake !== undefined) {
    return {
      ok: false,
      variant: "warning",
      message: "a chat wake landed in the range - use /undo instead (a redo here would lose its mail)",
    };
  }
  return { ok: true };
}

/**
 * The orchestration: parse, fetch, pick the target, guard, apply, gate,
 * revert, resubmit. Guards always gate the apply; the no-match check always
 * gates the revert. The session's non-pristine outcomes are a plain revert
 * (a failed /undo equivalent) or a staged revert (recoverable with the
 * built-in /redo or any typed message) - never a half-applied state.
 */
export async function redoLastMessage(ops: RedoSessionOps, sessionID: string, input: string): Promise<RedoOutcome> {
  const parsed = parseSubstitution(input);
  if (!parsed.ok) {
    return { ok: false, variant: "error", message: parsed.error };
  }
  const messages = await ops.fetchMessages(sessionID);
  // Desc order (newest first), so the LAST real user message is the first
  // match - the same message /undo targets.
  const target = messages.find(isRealUserMessage);
  if (!target) {
    return { ok: false, variant: "error", message: "nothing to redo - no prior message found" };
  }
  const guard = await checkGuards(ops, sessionID, messages, target);
  if (!guard.ok) {
    return { ok: false, variant: guard.variant, message: guard.message };
  }
  const applied = applySubstitution(target.text ?? "", parsed);
  if (!applied.ok) {
    return { ok: false, variant: "error", message: applied.error };
  }
  if (!applied.changed) {
    return { ok: false, variant: "warning", message: "no match - nothing done" };
  }
  await ops.interruptAndWait(sessionID);
  await ops.revertStage(sessionID, target.id);
  try {
    await ops.resubmit(sessionID, applied.text);
  } catch (error) {
    return {
      ok: false,
      variant: "error",
      message: `substituted text staged but not submitted: ${error instanceof Error ? error.message : String(error)} - recover with the built-in /redo or type any message`,
    };
  }
  return { ok: true, message: "reverted and resubmitted with the substitution applied" };
}
