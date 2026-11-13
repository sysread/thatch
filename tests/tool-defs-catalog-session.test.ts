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
    // 42 shared + session_tab_open (main) + the four plugin-regime tools.
    expect(TOOL_DEFS.length).toBe(47);
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
      "plugin_stage",
      "plugin_lifecycle",
      "plugin_chat_wake",
      "plugin_watch_poll",
      "prediction_query",
      "prediction_update",
      "prediction_list",
      "prediction_delete",
      "prediction_mark_checked",
      "prediction_find_duplicates",
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
      "session_tab_open",
      "session_tab_close",
    ]);
  });

  test("only the session, watch, and session-tab tools are opencode-only", () => {
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
      "session_tab",
      "session_tab_open",
      "session_tab_close",
    ]);
  });

  test("the opencode prompt lists every tool, session-tab tools included", () => {
    // The Tools section is what enumerates the surface (skill-list lines
    // elsewhere can mention tool names - slice the section for precision).
    const toolsSection = (prompt: string) =>
      prompt.slice(prompt.indexOf("Tools:"), prompt.indexOf("## Stores"));
    const prompt = systemPrompt("test/repo");
    for (const def of TOOL_DEFS) {
      // bundledOnly tools are never opencode prompt surface - they belong
      // to the plugin regime's bundled server only; everything else
      // (session-tab tools, the archaeology trio included) is listed.
      if (def.bundledOnly) {
        expect(toolsSection(prompt)).not.toContain(`thatch_${def.name}`);
      } else {
        expect(toolsSection(prompt)).toContain(`thatch_${def.name}`);
      }
    }
  });

  test("MCP prompts list shared tools but not opencode-only ones", () => {
    const prompt = claudeInstructions();
    for (const def of TOOL_DEFS) {
      if (def.opencodeOnly || def.bundledOnly) {
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

  test("an omitted session_id resolves to the invoking session's host context", async () => {
    providerCalls.length = 0;
    const out = await def.execute({}, payloadCtx(), { sessionID: "ses_current", agent: "build" });
    expect(out).toBe("payload-json");
    expect(providerCalls).toEqual(["ses_current"]);
  });

  test("an explicit session_id that resolves a payload is used as-is (unlinked sub-agent naming its target)", async () => {
    providerCalls.length = 0;
    const out = await def.execute({ session_id: "ses_parent" }, payloadCtx(), { sessionID: "ses_current", agent: "build" });
    expect(out).toBe("payload-json");
    expect(providerCalls).toEqual(["ses_parent"]);
  });

  test("a session_id that resolves nothing falls back to the calling session's host context", async () => {
    // The 2026-11-13 corrupted-id shape: the model copied the parent's id
    // wrong by one character. The corrupted id reads as an empty queue, and
    // the model cannot catch its own misread - so the tool retries with the
    // host-owned resolution before reporting an empty result.
    providerCalls.length = 0;
    const corruptCtx = (): CoreContext => ({
      ...ctx,
      extractionPayloadProvider: (sessionID: string) => {
        providerCalls.push(sessionID);
        return sessionID === "ses_current" ? "payload-json" : null;
      },
    });
    const out = await def.execute({ session_id: "ses_e52rd7be" }, corruptCtx(), { sessionID: "ses_current", agent: "build" });
    expect(out).toBe("payload-json");
    expect(providerCalls).toEqual(["ses_e52rd7be", "ses_current"]);
  });

  test("a wired resolver retargets a linked caller before the host context", async () => {
    // The bundled server shape: the resolver's key (the raw host session
    // id) differs from the dispatcher's hash-based host context, so the
    // resolver must take priority.
    providerCalls.length = 0;
    const resolverCtx = (): CoreContext => ({
      ...ctx,
      extractionPayloadProvider: (sessionID: string) => {
        providerCalls.push(sessionID);
        return "payload-json";
      },
      extractionTargetResolver: () => ({ sessionID: "ses_linked_parent", retargeted: true }),
    });
    const out = await def.execute({}, resolverCtx(), { sessionID: "mcp_hashcontext", agent: "build" });
    expect(out).toBe("payload-json");
    expect(providerCalls).toEqual(["ses_linked_parent"]);
  });

  test("an empty result after a retarget names the parent link", async () => {
    const emptyCtx = (): CoreContext => ({
      ...ctx,
      extractionPayloadProvider: () => null,
      extractionTargetResolver: () => ({ sessionID: "ses_linked_parent", retargeted: true }),
    });
    const out = await def.execute({}, emptyCtx(), { sessionID: "ses_child", agent: "general" });
    expect(out).toContain("parent session your session is linked to");
    expect(out).toContain("empty or already drained");
    expect(out).toContain("extraction_done");
  });

  test("an empty result with no host resolution explains the id is the only key", async () => {
    // Standalone MCP (Cursor, the hooks fallback): no session context, so
    // a param that finds nothing gets the honest hint instead of a silent
    // "empty queue" that masquerades as a purged session.
    const emptyCtx = (): CoreContext => ({ ...ctx, extractionPayloadProvider: () => null });
    const out = await def.execute({ session_id: "ses_gone" }, emptyCtx(), undefined);
    expect(out).toContain('session_id "ses_gone"');
    expect(out).toContain("character by character");
    expect(out).toContain("no session context");
  });

  test("an omitted session_id without host context returns the pass-the-parent-id rule", async () => {
    // MCP hosts have no session concept, so there is nothing to fall back
    // to. The message must tell the model what to do, not just fail.
    const out = await def.execute({}, payloadCtx(), undefined);
    expect(out).toContain("session_id is required");
    expect(out).toContain("parent");
  });
});

describe("extraction_done session_id", () => {
  const drains: string[] = [];
  const drainCtx = (): CoreContext => ({
    ...ctx,
    drainExtractionQueue: (sessionID: string) => {
      drains.push(sessionID);
    },
  });
  const def = TOOL_DEFS.find((t) => t.name === "extraction_done")!;

  test("a bare ack drains the host-resolved session when a resolver is wired", async () => {
    drains.length = 0;
    const resolverCtx = (): CoreContext => ({
      ...drainCtx(),
      extractionTargetResolver: () => ({ sessionID: "raw-host-session", retargeted: false }),
    });
    const out = await def.execute({}, resolverCtx(), { sessionID: "mcp_hashcontext", agent: "build" });
    expect(out).toBe("[acknowledged]");
    expect(drains).toEqual(["raw-host-session"]);
  });

  test("an explicit session_id takes priority over the resolution (the standalone drain signal)", async () => {
    drains.length = 0;
    const resolverCtx = (): CoreContext => ({
      ...drainCtx(),
      extractionTargetResolver: () => ({ sessionID: "raw-host-session", retargeted: false }),
    });
    const out = await def.execute({ session_id: "ses_named" }, resolverCtx(), { sessionID: "mcp_hashcontext", agent: "build" });
    expect(out).toBe("[acknowledged]");
    expect(drains).toEqual(["ses_named"]);
  });

  test("a bare ack without a resolver or host context drains nothing (the Cursor parent ack)", async () => {
    // The accept-before-fetch guard: on the standalone path a parent acks
    // bare right after dispatching its extractor, and that ack must NOT
    // delete the queue before the sub-agent fetches. Only the parameter's
    // presence drains there.
    drains.length = 0;
    const out = await def.execute({}, drainCtx(), undefined);
    expect(out).toBe("[acknowledged]");
    expect(drains).toEqual([]);
  });
});
