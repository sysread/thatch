import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../src/index";

let hooks: Awaited<ReturnType<typeof server>>;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-plugin-test-"));
  process.env.THATCH_DB_PATH = join(dbDir, "test.db");
  // Redirect skill installation away from the real ~/.config.
  process.env.XDG_CONFIG_HOME = join(dbDir, "config");
  const mockClient = {
    session: {
      prompt: async () => {},
    },
  };
  hooks = await server({ client: mockClient, worktree: "/tmp/thatch-test-worktree" } as any);
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
    const names = Object.keys(hooks.tool);
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

  test("has event hook", () => {
    expect(typeof hooks.event).toBe("function");
  });

  test("system transform appends to system array", async () => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({}, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("Thatch provides persistent memory");
  });

  test("chat.message prepends nudge when extraction is empty", async () => {
    const output: any = { parts: [{ type: "text", text: "hello" }] };
    await hooks["chat.message"]!({}, output);
    expect(output.parts.length).toBe(1); // no nudge, buffer empty
  });

  test("compaction hook appends to context array", async () => {
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!({}, output);
    expect(output.context.length).toBe(1);
    expect(output.context[0]).toContain("thatch_memory_recall");
  });

  test("each tool has description and execute", () => {
    for (const [name, t] of Object.entries(hooks.tool)) {
      expect(t.description, `${name} missing description`).toBeTruthy();
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute, `${name} missing execute`).toBe("function");
    }
  });

  test("each tool has args schema", () => {
    for (const [name, t] of Object.entries(hooks.tool)) {
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
  });
});
