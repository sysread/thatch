import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @huggingface/transformers so BgeEmbeddingModel can embed without
// downloading a model. Produces the same hash-based vectors as
// MockEmbeddingModel, stripping the QUERY_PREFIX so query and passage
// embeddings for the same text produce identical vectors.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async (text: string, _opts: any) => {
    const clean = text.startsWith(QUERY_PREFIX) ? text.slice(QUERY_PREFIX.length) : text;
    let h = 0;
    for (let i = 0; i < clean.length; i++) {
      h = ((h << 5) - h) + clean.charCodeAt(i);
      h |= 0;
    }
    h ^= 0x9e3779b9;
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      h |= 0;
      vec[i] = h / 0x80000000;
    }
    return { data: vec };
  },
}));

import { server } from "../src/index";
import {
  sessionStartReminder,
  recallNudge,
  claudeRecallNudge,
  claudeSessionStartReminder,
  claudeWriteNudge,
  claudeExtractionNudge,
  type NudgeMatch,
} from "../src/prompts";

let hooks: Awaited<ReturnType<typeof server>>;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-plugin-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
  // RECALL_THRESHOLD is a module-level constant (0.55 default), read when
  // index.ts is first imported. Setting the env var here can't change it,
  // but 0.55 works: the hash-based mock scores ~1.0 for identical texts and
  // near-orthogonal for different texts.
  const mockClient = {
    session: {
      prompt: async () => {},
    },
  };
  hooks = await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree" } as any);

  // Store a memory so the recall nudge has something to match. Using the
  // server's own tools ensures the embedding comes from the same (mocked)
  // BgeEmbeddingModel that chat.message will use for the query. The tool
  // embeds "# {label}\n\n{content}" — the recall nudge test prompt must
  // match that full text for the hash-based mock to produce identical vectors.
  await hooks.tool!.thatch_memory_remember.execute({
    label: "test-coverage",
    content: "test coverage metrics and gaps",
    store: "global",
  } as any, {} as any);
});

afterAll(() => {
  hooks.dispose?.();
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.THATCH_DB_PATH;
  delete process.env.XDG_CONFIG_HOME;
});

describe("plugin entry", () => {
  test("exports a server function", () => {
    expect(typeof server).toBe("function");
  });

  test("returns hooks with all expected tools", () => {
    expect(hooks.tool).toBeDefined();
    const names = Object.keys(hooks.tool!);
    expect(names.sort()).toEqual([
      "thatch_dedup_mark_checked",
      "thatch_find_duplicates",
      "thatch_memory_forget",
      "thatch_memory_list",
      "thatch_memory_recall",
      "thatch_memory_remember",
      "thatch_memory_show",
      "thatch_store_list",
    ]);
  });

  test("has system transform hook", () => {
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
  });

  test("has chat.message hook", () => {
    expect(typeof hooks["chat.message"]).toBe("function");
  });

  test("has compaction hook", () => {
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });

  test("has compaction autocontinue hook", () => {
    expect(typeof hooks["experimental.compaction.autocontinue"]).toBe("function");
  });

  test("has event hook", () => {
    expect(typeof hooks.event).toBe("function");
  });

  test("system transform appends to system array", async () => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as any, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("Thatch provides persistent memory");
  });

  test("chat.message prepends nudge when extraction is empty", async () => {
    const output: any = { parts: [{ type: "text", text: "hello" }] };
    await hooks["chat.message"]!({} as any, output);
    expect(output.parts.length).toBe(1); // no nudge, buffer empty
  });

  test("compaction hook appends context and marks session as compacting", async () => {
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_compact_1" } as any, output);
    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("Thatch persistent memory");
    expect(output.context[0]).not.toContain("thatch_memory_recall");
  });

  test("each tool has description and execute", () => {
    for (const [name, t] of Object.entries(hooks.tool!)) {
      expect(t.description, `${name} missing description`).toBeTruthy();
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute, `${name} missing execute`).toBe("function");
    }
  });

  test("each tool has args schema", () => {
    for (const [name, t] of Object.entries(hooks.tool!)) {
      expect(t.args, `${name} missing args`).toBeDefined();
    }
  });

  test("dispose hook is defined", () => {
    expect(typeof hooks.dispose).toBe("function");
  });

  test("has tool.execute.after hook", () => {
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  });

  test("buffered tool interactions surface as a payload nudge, scoped per session", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_a", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "README.md", metadata: {} },
    );

    // A different session sees no nudge.
    const otherOutput: any = { message: { id: "msg_0" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_b" } as any, otherOutput);
    expect(otherOutput.parts.length).toBe(0);

    // The originating session gets the nudge with the actual payload.
    const output: any = { message: { id: "msg_1" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a", messageID: "msg_1" } as any, output);
    expect(output.parts.length).toBe(1);
    expect(output.parts[0].type).toBe("text");
    expect(output.parts[0].sessionID).toBe("ses_a");
    expect(output.parts[0].text).toContain("thatch-fact-extractor");
    expect(output.parts[0].text).toContain('"tool":"bash"');

    // The buffer was flushed — no repeat nudge.
    const output2: any = { message: { id: "msg_2" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_a" } as any, output2);
    expect(output2.parts.length).toBe(0);
  });

  test("thatch's own tools are not buffered for extraction", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "thatch_memory_remember", sessionID: "ses_c", callID: "c2", args: {} },
      { title: "save", output: "[saved]", metadata: {} },
    );
    const output: any = { message: { id: "msg_3" }, parts: [] };
    await hooks["chat.message"]!({ sessionID: "ses_c" } as any, output);
    expect(output.parts.length).toBe(0);
  });

  test("installs skill files under the redirected config home", async () => {
    const { readFileSync } = await import("node:fs");
    const skillPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-fact-extractor", "SKILL.md",
    );
    expect(readFileSync(skillPath, "utf8")).toContain("thatch-fact-extractor");

    const primerPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-project-primer", "SKILL.md",
    );
    expect(readFileSync(primerPath, "utf8")).toContain("thatch-project-primer");

    // opencode installs both shared and opencode-only skills
    const reviewPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-review-pedantic", "SKILL.md",
    );
    expect(readFileSync(reviewPath, "utf8")).toContain("thatch-review-pedantic");

    const coordinatorPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-code-review", "SKILL.md",
    );
    expect(readFileSync(coordinatorPath, "utf8")).toContain("thatch-code-review");
  });

  test("event handler calls client.session.prompt on session.created", async () => {
    let promptCalled = false;
    let promptArgs: any = null;

    const mockClient = {
      session: {
        prompt: async (args: any) => {
          promptCalled = true;
          promptArgs = args;
        },
      },
    };

    const testHooks = await server({ client: mockClient, worktree: "/tmp/test" } as any);

    await testHooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "test-session-123" } },
      },
    } as any);

    expect(promptCalled).toBe(true);
    expect(promptArgs.path.id).toBe("test-session-123");
    expect(promptArgs.body.noReply).toBe(true);
    expect(promptArgs.body.parts[0].type).toBe("text");
    expect(promptArgs.body.parts[0].text).toContain("thatch");

    testHooks.dispose?.();
  });

  test("event handler ignores non-session.created events", async () => {
    let promptCalled = false;

    const mockClient = {
      session: {
        prompt: async () => {
          promptCalled = true;
        },
      },
    };

    const testHooks = await server({ client: mockClient, worktree: "/tmp/test" } as any);

    await testHooks.event!({
      event: {
        type: "session.updated",
        properties: {},
      },
    } as any);

    expect(promptCalled).toBe(false);

    testHooks.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// sessionStartReminder
// ---------------------------------------------------------------------------

describe("sessionStartReminder", () => {
  test("includes store name and recall instructions", () => {
    const reminder = sessionStartReminder("test-owner/test-repo");

    expect(reminder).toContain("[thatch]");
    expect(reminder).toContain("test-owner/test-repo");
    expect(reminder).toContain("thatch_memory_recall");
    expect(reminder).toContain("user preferences and personality");
    expect(reminder).toContain("project architecture and conventions");
    expect(reminder).toContain("thatch_store_list");
    expect(reminder).toContain("thatch_memory_list");
  });
});

// ---------------------------------------------------------------------------
// recallNudge / claudeRecallNudge
// ---------------------------------------------------------------------------

describe("recallNudge (opencode)", () => {
  test("single match uses singular form", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = recallNudge(matches);
    expect(nudge).toContain("1 memory relates to this prompt");
    expect(nudge).toContain('"Architecture"');
    expect(nudge).toContain("thatch_memory_recall");
  });

  test("multiple matches use plural and show up to 2 labels", () => {
    const matches: NudgeMatch[] = [
      { label: "Architecture", score: 0.8 },
      { label: "Module map", score: 0.7 },
      { label: "Conventions", score: 0.65 },
    ];
    const nudge = recallNudge(matches);
    expect(nudge).toContain("3 memories relate to this prompt");
    expect(nudge).toContain('"Architecture"');
    expect(nudge).toContain('"Module map"');
    expect(nudge).toContain("etc.");
    expect(nudge).not.toContain('"Conventions"');
  });
});

describe("claudeRecallNudge (Claude Code / Cursor)", () => {
  test("uses bare tool name without thatch_ prefix", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = claudeRecallNudge(matches);
    expect(nudge).toContain("memory_recall");
    expect(nudge).not.toContain("thatch_memory_recall");
  });
});

// ---------------------------------------------------------------------------
// claudeSessionStartReminder / claudeWriteNudge / claudeExtractionNudge
// ---------------------------------------------------------------------------

describe("claudeSessionStartReminder", () => {
  test("includes repo name and bare tool names (no thatch_ prefix)", () => {
    const reminder = claudeSessionStartReminder("owner/repo");
    expect(reminder).toContain("[thatch]");
    expect(reminder).toContain("owner/repo");
    expect(reminder).toContain("store_list");
    expect(reminder).toContain("memory_list");
    expect(reminder).toContain("memory_recall");
    expect(reminder).not.toContain("thatch_store_list");
    expect(reminder).not.toContain("thatch_memory_list");
    expect(reminder).not.toContain("thatch_memory_recall");
  });

  test("without hygiene returns just the base text", () => {
    const reminder = claudeSessionStartReminder("owner/repo");
    expect(reminder).not.toContain("[thatch hygiene]");
  });

  test("with null hygiene returns just the base text", () => {
    const reminder = claudeSessionStartReminder("owner/repo", null);
    expect(reminder).not.toContain("[thatch hygiene]");
  });

  test("with hygiene appends the hygiene block with bare tool names", () => {
    const reminder = claudeSessionStartReminder("owner/repo", "Store x: 2 duplicate-candidate pairs");
    expect(reminder).toContain("[thatch hygiene]");
    expect(reminder).toContain("Store x: 2 duplicate-candidate pairs");
    expect(reminder).toContain("find_duplicates");
    expect(reminder).toContain("memory_show");
    expect(reminder).not.toContain("thatch_find_duplicates");
    expect(reminder).not.toContain("thatch_memory_show");
  });
});

describe("claudeWriteNudge", () => {
  test("returns the after-responding check prompt", () => {
    const nudge = claudeWriteNudge();
    expect(nudge).toContain("[thatch]");
    expect(nudge).toContain("After responding");
    expect(nudge).toContain("save to thatch");
  });
});

describe("claudeExtractionNudge", () => {
  test("singular form for one interaction", () => {
    const nudge = claudeExtractionNudge(1, '{"tool":"bash"}');
    expect(nudge).toContain("1 recent tool interaction queued");
    expect(nudge).not.toContain("interactions queued");
    expect(nudge).toContain("thatch-fact-extractor");
    expect(nudge).toContain("mcp__thatch__memory_remember");
    expect(nudge).toContain('{"tool":"bash"}');
  });

  test("plural form for multiple interactions", () => {
    const nudge = claudeExtractionNudge(3, '{"tool":"bash"}');
    expect(nudge).toContain("3 recent tool interactions queued");
    expect(nudge).toContain("thatch-fact-extractor");
  });
});

// ---------------------------------------------------------------------------
// Recall nudge (prompt-aware, via chat.message hook)
// ---------------------------------------------------------------------------

describe("recall nudge via chat.message", () => {
  test("surfaces a recall nudge when prompt matches a stored memory", async () => {
    // The tool embeds "# {label}\n\n{content}", so the prompt must match
    // that full text for the hash-based mock to produce a matching vector.
    const output: any = {
      message: { id: "msg_recall_1" },
      parts: [{ type: "text", text: "# test-coverage\n\ntest coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_recall", messageID: "msg_recall_1" } as any, output);
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].type).toBe("text");
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("test-coverage");
    expect(output.parts[1].text).toContain("thatch_memory_recall");
  });

  test("no nudge when prompt does not match any memory", async () => {
    const output: any = {
      message: { id: "msg_recall_2" },
      parts: [{ type: "text", text: "completely unrelated cooking recipe ideas" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_no_match", messageID: "msg_recall_2" } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("no nudge for short prompts even if content would match", async () => {
    const output: any = {
      message: { id: "msg_recall_3" },
      parts: [{ type: "text", text: "ok" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_short", messageID: "msg_recall_3" } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("extraction nudge takes priority over recall nudge", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_priority", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "file.txt", metadata: {} },
    );

    const output: any = {
      message: { id: "msg_priority" },
      parts: [{ type: "text", text: "test coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_priority", messageID: "msg_priority" } as any, output);
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("thatch-fact-extractor");
    expect(output.parts[1].text).not.toContain("test-coverage");
  });
});

// ---------------------------------------------------------------------------
// Compaction guard — chat.message nudges suppressed during compaction
// ---------------------------------------------------------------------------

describe("compaction guard for chat.message", () => {
  test("chat.message skips nudges while session is compacting", async () => {
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard" } as any,
      { context: [] as string[] },
    );

    const output: any = {
      message: { id: "msg_guard_1" },
      parts: [{ type: "text", text: "# test-coverage\n\ntest coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard", messageID: "msg_guard_1" } as any, output);
    expect(output.parts.length).toBe(1);
  });

  test("autocontinue clears the flag and nudges resume", async () => {
    await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_guard" } as any, { enabled: true } as any);

    const output: any = {
      message: { id: "msg_guard_2" },
      parts: [{ type: "text", text: "# test-coverage\n\ntest coverage metrics and gaps" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard", messageID: "msg_guard_2" } as any, output);
    expect(output.parts.length).toBe(2);
    expect(output.parts[1].synthetic).toBe(true);
    expect(output.parts[1].text).toContain("test-coverage");
  });

  test("extraction nudge is also suppressed during compaction", async () => {
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_guard_ext", callID: "c1", args: { command: "ls" } },
      { title: "list files", output: "file.txt", metadata: {} },
    );

    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_guard_ext" } as any,
      { context: [] as string[] },
    );

    const output: any = {
      message: { id: "msg_guard_ext" },
      parts: [{ type: "text", text: "anything" }],
    };
    await hooks["chat.message"]!({ sessionID: "ses_guard_ext", messageID: "msg_guard_ext" } as any, output);
    expect(output.parts.length).toBe(1);

    // Clean up so the buffer doesn't leak into other tests.
    await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_guard_ext" } as any, { enabled: true } as any);
  });
});
