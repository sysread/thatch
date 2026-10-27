import { describe, test, expect } from "bun:test";
import {
  parseSubstitution,
  translateReplacement,
  applySubstitution,
  walkMessages,
  checkGuards,
  redoLastMessage,
  type RedoMessage,
  type MessagePageInput,
  type RedoSessionOps,
} from "../src/redo-shared";

// The redo command's SDK-free core (docs/plans/redo-command.md): the
// substitution parser, the apply engine, and the orchestration's
// destructive-ordering invariant with mocked deps. No SDK imports here -
// the whole suite runs on bun:test alone.

function msg(id: string, type: string, created: number, text?: string): RedoMessage {
  return { id, type, created, text };
}

function makeOps(): RedoSessionOps & {
  calls: string[];
  messages: RedoMessage[];
  state: { staged: string | undefined; pending: number; resubmitError: Error | undefined };
} {
  const calls: string[] = [];
  const messages: RedoMessage[] = [];
  // Mutable test state: guards read it, and resubmitError simulates the
  // prompt endpoint rejecting after a successful stage. Overrides never
  // replace the recorders, so ordering assertions stay exact.
  const state = { staged: undefined as string | undefined, pending: 0, resubmitError: undefined as Error | undefined };
  return {
    calls,
    messages,
    state,
    fetchMessages: async () => {
      calls.push("fetch");
      return messages;
    },
    stagedRevertMessageID: async () => {
      calls.push("staged");
      return state.staged;
    },
    pendingInboxCount: async () => {
      calls.push("pending");
      return state.pending;
    },
    interruptAndWait: async (sessionID) => {
      calls.push(`interrupt:${sessionID}`);
    },
    revertStage: async (_sessionID, messageID) => {
      calls.push(`revert:${messageID}`);
    },
    resubmit: async (_sessionID, text) => {
      if (state.resubmitError) throw state.resubmitError;
      calls.push(`submit:${text}`);
    },
  };
}

describe("parseSubstitution delimiters", () => {
  test("splits on the default slash delimiter", () => {
    expect(parseSubstitution("/foo/bar/")).toEqual({ ok: true, pattern: "foo", replacement: "bar", flags: "" });
    expect(parseSubstitution("/foo/bar/gi")).toEqual({ ok: true, pattern: "foo", replacement: "bar", flags: "gi" });
  });

  test("the leading s verb is optional and both spellings parse identically", () => {
    expect(parseSubstitution("s/foo/bar/")).toEqual(parseSubstitution("/foo/bar/"));
    expect(parseSubstitution("s|foo|bar|g")).toEqual(parseSubstitution("|foo|bar|g"));
  });

  test("the s-strip only fires before a valid delimiter (s as regex text survives)", () => {
    // "s" as the full pattern: the s-strip cannot have fired (the character
    // after the first delimiter is not a delimiter), so "s" is regex text.
    expect(parseSubstitution("/s//")).toEqual({ ok: true, pattern: "s", replacement: "", flags: "" });
  });

  test("alternate delimiters | , #", () => {
    expect(parseSubstitution("|foo|bar|")).toEqual({ ok: true, pattern: "foo", replacement: "bar", flags: "" });
    expect(parseSubstitution(",foo,bar,")).toEqual({ ok: true, pattern: "foo", replacement: "bar", flags: "" });
    expect(parseSubstitution("#foo#bar#g")).toEqual({ ok: true, pattern: "foo", replacement: "bar", flags: "g" });
  });

  test("escaped delimiters do not close a segment and keep their backslash", () => {
    expect(parseSubstitution("/a\\|b/c/")).toEqual({ ok: true, pattern: "a\\|b", replacement: "c", flags: "" });
    expect(parseSubstitution("|a\\|b|c|")).toEqual({ ok: true, pattern: "a\\|b", replacement: "c", flags: "" });
    // The escaped delimiter lands in the pattern and reads as a literal.
    const applied = applySubstitution("a|b", parseSubstitution("/a\\|b/X/"));
    expect(applied).toEqual({ ok: true, text: "X", changed: true });
  });

  test("rejects invalid delimiters and incomplete input", () => {
    expect(parseSubstitution("").ok).toBe(false);
    expect(parseSubstitution("  ").ok).toBe(false);
    expect(parseSubstitution("xfoo/bar/").ok).toBe(false); // letters cannot delimit
    expect(parseSubstitution("\\ foo\\ bar\\ ").ok).toBe(false); // backslash cannot delimit
    expect(parseSubstitution(" foobar ").ok).toBe(false); // whitespace cannot delimit
    expect(parseSubstitution("s").ok).toBe(false); // the verb alone has no delimiter
    expect(parseSubstitution("/foo").ok).toBe(false); // one delimiter short
    expect(parseSubstitution("/foo/bar").ok).toBe(false); // missing trailing delimiter
  });
});

describe("parseSubstitution flags", () => {
  test("an unknown flag is a parse error naming it", () => {
    const result = parseSubstitution("/a/b/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"x"');
    const space = parseSubstitution("/a/b/ee");
    expect(space.ok).toBe(false);
  });

  test("duplicate flags deduplicate", () => {
    expect(parseSubstitution("/a/b/ggg")).toEqual({ ok: true, pattern: "a", replacement: "b", flags: "g" });
    expect(parseSubstitution("/a/b/gig")).toEqual({ ok: true, pattern: "a", replacement: "b", flags: "gi" });
  });

  test("all supported flags parse", () => {
    expect(parseSubstitution("/a/b/gimsu")?.ok).toBe(true);
  });
});

describe("translateReplacement", () => {
  test("\\1..\\9 become $1..$9", () => {
    expect(translateReplacement("\\1")).toBe("$1");
    expect(translateReplacement("a\\2b")).toBe("a$2b");
  });

  test("\\n and \\t become literal newline and tab", () => {
    expect(translateReplacement("\\n")).toBe("\n");
    expect(translateReplacement("\\t")).toBe("\t");
    expect(translateReplacement("x\\ny")).toBe("x\ny");
  });

  test("other backslash pairs pass through and $1 is native", () => {
    expect(translateReplacement("\\d")).toBe("\\d");
    expect(translateReplacement("$1")).toBe("$1");
  });
});

describe("applySubstitution", () => {
  test("replaces the first match without g", () => {
    const parsed = parseSubstitution("/foo/bar/");
    const result = applySubstitution("foo foo", parsed);
    expect(result).toEqual({ ok: true, text: "bar foo", changed: true });
  });

  test("g replaces every match", () => {
    const parsed = parseSubstitution("/foo/bar/g");
    const result = applySubstitution("foo foo", parsed);
    expect(result).toEqual({ ok: true, text: "bar bar", changed: true });
  });

  test("\\1 groups and \\n literals work end to end", () => {
    const result = applySubstitution("hello world", parseSubstitution("/(\\w+) (\\w+)/\\2 \\1/"));
    expect(result).toEqual({ ok: true, text: "world hello", changed: true });
    const nl = applySubstitution("a,b", parseSubstitution("/,/\\n/"));
    expect(nl).toEqual({ ok: true, text: "a\nb", changed: true });
  });

  test("lookarounds, non-greedy, and \\p{...} with u work", () => {
    expect(applySubstitution("foobar", parseSubstitution("/(?<=foo)bar/baz/"))).toEqual({
      ok: true,
      text: "foobaz",
      changed: true,
    });
    expect(applySubstitution("aaa", parseSubstitution("/a+?/b/"))).toEqual({ ok: true, text: "baa", changed: true });
    expect(applySubstitution("caf\u00e9", parseSubstitution("/\\p{Letter}+/X/u"))).toEqual({
      ok: true,
      text: "X",
      changed: true,
    });
  });

  test("a pattern that only compiles without u falls back (identity escapes)", () => {
    // \- is an identity escape Unicode mode rejects; legacy mode accepts it.
    const result = applySubstitution("a-b", parseSubstitution("/\\-/X/"));
    expect(result).toEqual({ ok: true, text: "aXb", changed: true });
  });

  test("a pattern that never compiles returns the engine error", () => {
    const result = applySubstitution("abc", parseSubstitution("/a(/X/"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("regular expression");
  });

  test("no match and unchanged text report changed: false", () => {
    expect(applySubstitution("abc", parseSubstitution("/xyz/q/"))).toEqual({ ok: true, text: "abc", changed: false });
    // A zero-width or identity rewrite is also "nothing changed".
    expect(applySubstitution("abc", parseSubstitution("/x/x/"))).toEqual({ ok: true, text: "abc", changed: false });
  });

  test("i and m flags reach the engine", () => {
    expect(applySubstitution("FOO", parseSubstitution("/foo/bar/i"))).toEqual({
      ok: true,
      text: "bar",
      changed: true,
    });
    expect(applySubstitution("a\nb", parseSubstitution("/^b/c/m"))).toEqual({ ok: true, text: "a\nc", changed: true });
  });
});

describe("walkMessages", () => {
  function paged(pages: RedoMessage[][]): { calls: MessagePageInput[]; page: (input: MessagePageInput) => Promise<{ data: RedoMessage[]; cursor: { next?: string | null } }> } {
    const calls: MessagePageInput[] = [];
    return {
      calls,
      page: async (input) => {
        calls.push(input);
        const index = calls.length - 1;
        return { data: pages[index] ?? [], cursor: { next: index + 1 < pages.length ? `c${index + 1}` : null } };
      },
    };
  }

  test("stops at the page containing the first real user message", async () => {
    const { calls, page } = paged([
      [msg("a1", "assistant", 3)],
      [msg("a0", "user", 1, "hello")],
      [msg("a-1", "user", 0, "older")],
    ]);
    const messages = await walkMessages(page);
    expect(messages.map((m) => m.id)).toEqual(["a1", "a0"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ limit: 100, order: "desc", cursor: undefined });
    expect(calls[1]).toEqual({ limit: 100, order: "desc", cursor: "c1" });
  });

  test("exhausts history (cursor next null) before giving up", async () => {
    const { calls, page } = paged([[msg("a1", "assistant", 3)], [msg("a0", "assistant", 2)]]);
    const messages = await walkMessages(page);
    expect(messages.map((m) => m.id)).toEqual(["a1", "a0"]);
    expect(calls).toHaveLength(2);
  });

  test("assistant-only and synthetic turns do not satisfy the stop condition", async () => {
    const { calls, page } = paged([[msg("s1", "synthetic", 5, "wake")], [msg("u1", "user", 1, "real")]]);
    const messages = await walkMessages(page);
    expect(messages.map((m) => m.id)).toEqual(["s1", "u1"]);
    expect(calls).toHaveLength(2);
  });
});

describe("checkGuards", () => {
  const target = msg("u1", "user", 1, "hello");
  const messages = [msg("a1", "assistant", 2), target];

  test("staged undo aborts first, pointing at the built-in /redo", async () => {
    const ops = makeOps();
    ops.state.staged = "m9";
    const guard = await checkGuards(ops, "s", messages, target);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.message).toContain("/redo");
  });

  test("pending inbox aborts with the queued count", async () => {
    const ops = makeOps();
    ops.state.pending = 2;
    const guard = await checkGuards(ops, "s", messages, target);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.message).toContain("2");
  });

  test("a synthetic wake newer than the target aborts", async () => {
    const withWake = [msg("s1", "synthetic", 5, "wake"), ...messages];
    const guard = await checkGuards(makeOps(), "s", withWake, target);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.message).toContain("/undo");
  });

  test("a synthetic wake OLDER than the target does not abort", async () => {
    const withOldWake = [target, msg("s0", "synthetic", 0, "wake")];
    const guard = await checkGuards(makeOps(), "s", withOldWake, target);
    expect(guard.ok).toBe(true);
  });

  test("a clean session passes all three", async () => {
    const guard = await checkGuards(makeOps(), "s", messages, target);
    expect(guard.ok).toBe(true);
  });
});

describe("redoLastMessage ordering (mocked deps)", () => {
  test("no-match aborts before any session touch", async () => {
    const ops = makeOps();
    ops.messages.push(msg("u1", "user", 1, "hello world"));
    const outcome = await redoLastMessage(ops, "s1", "/zzz/qqq/");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("no match");
    expect(ops.calls).toEqual(["fetch", "staged", "pending"]); // no interrupt, no revert, no submit
  });

  test("guards abort before the apply and any session touch", async () => {
    const ops = makeOps();
    ops.state.staged = "m9";
    ops.messages.push(msg("u1", "user", 1, "hello world"));
    const outcome = await redoLastMessage(ops, "s1", "/hello/goodbye/");
    expect(outcome.ok).toBe(false);
    expect(ops.calls).toEqual(["fetch", "staged"]);
  });

  test("parse errors return before any fetch", async () => {
    const ops = makeOps();
    const outcome = await redoLastMessage(ops, "s1", "not a substitution");
    expect(outcome.ok).toBe(false);
    expect(ops.calls).toEqual([]);
  });

  test("a match reverts the LAST user message and resubmits the substituted text", async () => {
    const ops = makeOps();
    // Desc order: u2 is newest, so it is the target - not u1.
    ops.messages.push(msg("u2", "user", 5, "second"), msg("u1", "user", 1, "first"));
    const outcome = await redoLastMessage(ops, "s1", "/second/SECOND/");
    expect(outcome.ok).toBe(true);
    expect(ops.calls).toEqual(["fetch", "staged", "pending", "interrupt:s1", "revert:u2", "submit:SECOND"]);
  });

  test("a resubmit failure reports the staged state instead of hiding it", async () => {
    const ops = makeOps();
    ops.state.resubmitError = new Error("boom");
    ops.messages.push(msg("u1", "user", 1, "hello"));
    const outcome = await redoLastMessage(ops, "s1", "/hello/hi/");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("boom");
    expect(ops.calls).toEqual(["fetch", "staged", "pending", "interrupt:s1", "revert:u1"]);
  });

  test("no prior user message aborts with nothing touched", async () => {
    const ops = makeOps();
    ops.messages.push(msg("a1", "assistant", 1));
    const outcome = await redoLastMessage(ops, "s1", "/a/b/");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("nothing to redo");
    expect(ops.calls).toEqual(["fetch"]);
  });

  test("whitespace-only text is not a target (the built-in's exact filter)", async () => {
    const ops = makeOps();
    ops.messages.push(msg("u1", "user", 1, "   "));
    const outcome = await redoLastMessage(ops, "s1", "/a/b/");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("nothing to redo");
    expect(ops.calls).toEqual(["fetch"]);
  });
});
