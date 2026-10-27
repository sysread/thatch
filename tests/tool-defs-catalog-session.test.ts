// The TOOL_DEFS catalog (count, name list, prompt surface, schema shape),
// the cross-tool schema/description contracts, and the host-context-aware
// tools (get_session_info, get_extraction_payload).
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { TOOL_DEFS, type CoreContext } from "../src/tool-defs";
import { systemPrompt, claudeInstructions } from "../src/prompts";
import { setupToolDefsHarness, ctx } from "./mocks/tool-defs-harness";

setupToolDefsHarness();

describe("TOOL_DEFS", () => {
  test("exports the full tool catalog", () => {
    expect(TOOL_DEFS.length).toBe(41);
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toEqual([
      "memory_remember",
      "memory_recall",
      "memory_list",
      "memory_show",
      "memory_forget",
      "store_list",
      "find_duplicates",
      "dedup_mark_checked",
      "extraction_done",
      "get_extraction_payload",
      "prediction_query",
      "prediction_update",
      "prediction_list",
      "prediction_delete",
      "prediction_mark_checked",
      "behavior_codify",
      "behavior_feedback",
      "behavior_list",
      "behavior_delete",
      "config_get",
      "config_set",
      "notify_user",
      "get_session_info",
      "exit",
      "compact",
      "session_search",
      "session_get",
      "watch_create",
      "watch_branch_create",
      "watch_command_create",
      "watch_list",
      "watch_cancel",
      "chat_register",
      "chat_list",
      "chat_send",
      "chat_read",
      "chat_unregister",
      "chat_broadcast",
      "chat_status",
      "session_tab",
      "session_tab_close",
    ]);
  });

  test("only the session, watch, and chat tools are opencode-only", () => {
    const opencodeOnly = TOOL_DEFS.filter((t) => t.opencodeOnly).map((t) => t.name);
    expect(opencodeOnly).toEqual([
      "get_session_info",
      "exit",
      "compact",
      "session_search",
      "session_get",
      "watch_create",
      "watch_branch_create",
      "watch_command_create",
      "watch_list",
      "watch_cancel",
    ]);
  });

  test("opencode prompt lists every tool; the v2-only one only when v2Tools is set", () => {
    // The Tools section is what enumerates the surface (skill-list lines
    // elsewhere can mention tool names - slice the section for precision).
    const toolsSection = (prompt: string) =>
      prompt.slice(prompt.indexOf("Tools:"), prompt.indexOf("## Stores"));
    // The v1 runtime renders the base prompt: session_tab must NOT be listed
    // there (the tool does not exist on v1 - a prompt listing a nonexistent
    // tool is the first-call-mistake class).
    const base = systemPrompt("test/repo");
    for (const def of TOOL_DEFS) {
      if (def.v2Only) {
        expect(toolsSection(base)).not.toContain(`thatch_${def.name}`);
      } else {
        expect(toolsSection(base)).toContain(`thatch_${def.name}`);
      }
    }
    // The v2 adapter sets v2Tools: the full list appears.
    const v2 = systemPrompt("test/repo", true, true);
    for (const def of TOOL_DEFS) {
      expect(toolsSection(v2)).toContain(`thatch_${def.name}`);
    }
  });

  test("MCP prompts list shared tools but not opencode-only or v2-only ones", () => {
    const prompt = claudeInstructions();
    for (const def of TOOL_DEFS) {
      if (def.opencodeOnly || def.v2Only) {
        expect(prompt).not.toContain(`mcp__thatch__${def.name}`);
      } else {
        expect(prompt).toContain(`mcp__thatch__${def.name}`);
      }
    }
  });

  test("each tool has name, description, args, and execute", () => {
    for (const def of TOOL_DEFS) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(10);
      expect(typeof def.args).toBe("object");
      expect(typeof def.execute).toBe("function");
    }
  });

  test("zod schemas convert to valid JSON Schema via z.toJSONSchema()", () => {
    for (const def of TOOL_DEFS) {
      const schema = z.object(def.args);
      const json = z.toJSONSchema(schema) as any;
      expect(json.type).toBe("object");
      expect(json.properties).toBeDefined();
    }
  });
});

describe("tool-defs validation", () => {
  test("memory_remember label is optional (derived from content when omitted)", () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({ content: "test" })).not.toThrow();
  });

  test("memory_remember content is schema-optional with execute-level guidance", () => {
    // Optionality is the only signal that survives the v2 JSON Schema hop:
    // required keys die at host validation, so a misnamed/missing content
    // key could never reach the runtime teaching message. The empty parse
    // is the stripped-misnamed-key shape execute must teach on.
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({ label: "test" })).not.toThrow();
    expect(() => schema.parse({})).not.toThrow();
  });

  test("memory_show and memory_forget label is schema-optional", () => {
    for (const name of ["memory_show", "memory_forget"]) {
      const def = TOOL_DEFS.find((t) => t.name === name)!;
      expect(() => z.object(def.args).parse({})).not.toThrow();
    }
  });

  test("prediction_update and behavior_codify descriptions state the required-arg contract", () => {
    // The DB audit (Sept 2026) found the models drop the discriminator
    // params (signal, situation) unless the contract is spelled out.
    const update = TOOL_DEFS.find((t) => t.name === "prediction_update")!;
    expect(update.description).toContain("ALL FOUR");
    expect(update.description).toContain("create, confirm, disconfirm, soft");
    const codify = TOOL_DEFS.find((t) => t.name === "behavior_codify")!;
    expect(codify.description).toContain("ALL THREE");
  });

  test("confidence must be 1-10", () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({ label: "t", content: "c", confidence: 0 })).toThrow();
    expect(() => schema.parse({ label: "t", content: "c", confidence: 11 })).toThrow();
    expect(() => schema.parse({ label: "t", content: "c", confidence: 5 })).not.toThrow();
  });

  test("store_list accepts empty args", () => {
    const def = TOOL_DEFS.find((t) => t.name === "store_list")!;
    const schema = z.object(def.args);
    expect(() => schema.parse({})).not.toThrow();
  });
});

describe("get_session_info", () => {
  const findTool = () => TOOL_DEFS.find((t) => t.name === "get_session_info")!;

  test("reports session identity when the host supplies a context", async () => {
    const result = await findTool().execute({}, ctx, { sessionID: "ses_test_123", agent: "build" });
    expect(result).toContain("sessionID: ses_test_123");
    expect(result).toContain("agent: build");
  });

  test("explains unavailability when no host context exists (MCP path)", async () => {
    const result = await findTool().execute({}, ctx);
    expect(result).toContain("unavailable");
    expect(result).not.toContain("sessionID: undefined");
  });

  test("takes no arguments", () => {
    const schema = z.object(findTool().args);
    expect(() => schema.parse({})).not.toThrow();
  });
});

describe("get_extraction_payload session_id", () => {
  // ctx is rebuilt per test in beforeEach, so the payload provider must be
  // attached inside each test rather than captured at module load.
  const providerCalls: string[] = [];
  const payloadCtx = (): CoreContext => ({
    ...ctx,
    extractionPayloadProvider: (sessionID: string) => {
      providerCalls.push(sessionID);
      return "payload-json";
    },
  });
  const def = TOOL_DEFS.find((t) => t.name === "get_extraction_payload")!;

  test("an omitted session_id falls back to the invoking session's host context", async () => {
    providerCalls.length = 0;
    const out = await def.execute({}, payloadCtx(), { sessionID: "ses_current", agent: "build" });
    expect(out).toBe("payload-json");
    expect(providerCalls).toEqual(["ses_current"]);
  });

  test("an explicit session_id wins over the host context (sub-agent drains the parent's queue)", async () => {
    providerCalls.length = 0;
    const out = await def.execute({ session_id: "ses_parent" }, payloadCtx(), { sessionID: "ses_current", agent: "build" });
    expect(out).toBe("payload-json");
    expect(providerCalls).toEqual(["ses_parent"]);
  });

  test("an omitted session_id without host context returns the pass-the-parent-id rule", async () => {
    // MCP hosts have no session concept, so there is nothing to fall back
    // to. The message must tell the model what to do, not just fail.
    const out = await def.execute({}, payloadCtx(), undefined);
    expect(out).toContain("session_id is required");
    expect(out).toContain("parent");
  });
});
