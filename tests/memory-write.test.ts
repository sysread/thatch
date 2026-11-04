// The `thatch remember` CLI subcommand's input parsing (src/memory-write.ts)
// and its wiring into the memory_remember tool's execute() - the contract the
// dispatcher in bin/thatch implements.
import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { TOOL_DEFS, MEMORY_SAVED_MARKER } from "../src/tool-defs";
import { parseRememberInput, type RememberParse } from "../src/memory-write";
import { setupToolDefsHarness, ctx, db, defaultStore } from "./mocks/tool-defs-harness";

setupToolDefsHarness();

/** Feeds text through a pipe the way a shell would: write, end, then read. */
function piped(text: string): PassThrough {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

function ok(parsed: RememberParse): RememberRequest_ {
  if (!parsed.ok) throw new Error(`expected ok, got error: ${parsed.error}`);
  return parsed.request;
}
type RememberRequest_ = Extract<RememberParse, { ok: true }>["request"];

describe("parseRememberInput flags", () => {
  test("positional words join into the content without quoting", async () => {
    const request = ok(await parseRememberInput(["merge", "hook", "notes"], null));
    expect(request.content).toBe("merge hook notes");
  });

  test("value flags parse in space form", async () => {
    const request = ok(await parseRememberInput(
      ["body", "--label", "L", "--store", "S", "--branch", "B", "--confidence", "7"], null,
    ));
    expect(request.content).toBe("body");
    expect(request.label).toBe("L");
    expect(request.store).toBe("S");
    expect(request.branch).toBe("B");
    expect(request.confidence).toBe(7);
  });

  test("value flags parse in = form", async () => {
    const request = ok(await parseRememberInput(
      ["body", "--label=L", "--store=S", "--branch=B", "--confidence=3"], null,
    ));
    expect(request.label).toBe("L");
    expect(request.store).toBe("S");
    expect(request.branch).toBe("B");
    expect(request.confidence).toBe(3);
  });

  test("--overwrite is a boolean flag", async () => {
    const request = ok(await parseRememberInput(["body", "--overwrite"], null));
    expect(request.overwrite).toBe(true);
  });

  test("without --overwrite the key is absent, matching the tool's optional", async () => {
    const request = ok(await parseRememberInput(["body"], null));
    expect(request.overwrite).toBeUndefined();
  });

  test("a bare -- puts later tokens in the content", async () => {
    const request = ok(await parseRememberInput(["--", "--leading", "dashes"], null));
    expect(request.content).toBe("--leading dashes");
  });

  test("unknown flags die loudly", async () => {
    const parsed = await parseRememberInput(["body", "--prjoect", "x"], null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("unknown flag");
  });

  test("a value flag with no value dies loudly", async () => {
    const parsed = await parseRememberInput(["body", "--label"], null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--label expects a value");
  });

  test("confidence rejects non-integers and out-of-range values", async () => {
    for (const bad of ["high", "7.5", "0", "11"]) {
      const parsed = await parseRememberInput(["body", "--confidence", bad], null);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("--confidence expects an integer 1-10");
    }
  });
});

describe("parseRememberInput content sources", () => {
  test("stdin is read to EOF when no positional content is given", async () => {
    const request = ok(await parseRememberInput(["--label", "L"], piped("piped body\n")));
    expect(request.content).toBe("piped body");
    expect(request.label).toBe("L");
  });

  test("a positional wins over stdin, which is never read", async () => {
    // The stream is never ended on purpose: if the parser read it, the
    // promise would hang and the test would time out.
    const stream = new PassThrough();
    const request = ok(await parseRememberInput(["positional"], stream));
    expect(request.content).toBe("positional");
  });

  test("a terminal (no pipe) with no positional content errors with both shapes", async () => {
    const parsed = await parseRememberInput([], null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("no content provided");
      expect(parsed.error).toContain("stdin");
    }
  });

  test("an empty pipe errors the same as a terminal", async () => {
    const parsed = await parseRememberInput([], piped("   \n"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("no content provided");
  });

  test("a long piped body survives intact (the old ~1400-char failure class)", async () => {
    // The tool path used to fail client-side somewhere past ~1400
    // characters; the CLI must carry arbitrarily long stdin bodies.
    const body = `# Long memory\n\n${"word ".repeat(2000).trim()}`;
    const request = ok(await parseRememberInput([], piped(body)));
    expect(request.content).toBe(body);
  });
});

describe("remember wiring into memory_remember.execute", () => {
  test("a parsed request saves through the tool and reports the marker", async () => {
    const request = ok(await parseRememberInput(
      ["wired body", "--label", "Cli wiring", "--branch", "feature-x", "--confidence", "7"], null,
    ));
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ ...request }, ctx);
    expect(result.startsWith(MEMORY_SAVED_MARKER)).toBe(true);
    expect(result).toContain(`${defaultStore} :: Cli wiring`);
    const entry = db.showEntry(defaultStore, "Cli wiring");
    expect(entry?.branch).toBe("feature-x");
    expect(entry?.confidence).toBe(7);
  });

  test("no --store falls back to the CLI's default store via the tool's resolveStore", async () => {
    const request = ok(await parseRememberInput(["store fallback body"], null));
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ ...request, store: undefined }, ctx);
    expect(result).toContain(`[saved] ${defaultStore} ::`);
  });

  test("overwrite without branch preserves an existing branch scope (the tool gotcha, unchanged)", async () => {
    // The CLI must not silently differ from the tool: overwriting a
    // branch-scoped memory WITHOUT --branch keeps the old scope, and the
    // save reports success either way. Scripted callers verify with
    // `thatch show` after an intended scope change.
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    await def.execute({ content: "scoped body", label: "Scoped", branch: "topic-branch" }, ctx);
    const again = await def.execute({ content: "rewritten body", label: "Scoped", overwrite: true }, ctx);
    expect(again.startsWith(MEMORY_SAVED_MARKER)).toBe(true);
    expect(db.showEntry(defaultStore, "Scoped")?.branch).toBe("topic-branch");
  });

  test("a duplicate label without overwrite returns the tool's failure, not a throw", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    await def.execute({ content: "first", label: "Dup" }, ctx);
    const result = await def.execute({ content: "second", label: "Dup" }, ctx);
    // The dispatcher's exit-code rule: anything not starting with the
    // save marker goes to stderr and exits 1.
    expect(result.startsWith(MEMORY_SAVED_MARKER)).toBe(false);
    expect(result).toContain("already exists");
  });
});
