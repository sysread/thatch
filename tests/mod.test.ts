import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { registerMod, readStageText } from "../src/claude-plugin/mod";
import { installModsHarness } from "./mocks/mods-harness";

// The plugin mod's decision logic, pure against the mods-$ double
// (tests/mocks/mods-harness.ts). The harness encodes the QA pins' assumed
// shapes in one place; if a pin fails on the real app, the fix lands
// there and here.

describe("plugin mod: prompt.compose is NOT registered", () => {
  test("instructions never ride compose (the guard passes over user mods' compose hooks)", async () => {
    // The guard (cc-plugin-sec-default, loaded on Team/Enterprise logins +
    // managed settings) passes over a user's mod's prompt.compose hooks -
    // instructions delivered there vanish on exactly the machines where a
    // corporate security plugin sits. Delivery is the CLAUDE.md static
    // block (ensured by setup + the bundled server); a compose regression
    // would double-deliver on open machines.
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, {
      instructions: "I",
      serverKey: "thatch", stageTool: "plugin_stage",
      lifecycleTool: "plugin_lifecycle",
      chatWakeTool: "plugin_chat_wake",
      watchPollTool: "plugin_watch_poll",
    });
    expect(harness.registrations.some((r) => r.event === "prompt.compose")).toBe(false);
  });
});

describe("plugin mod: prompt.submit", () => {
  const options = { instructions: "I", serverKey: "thatch", stageTool: "plugin_stage", lifecycleTool: "plugin_lifecycle", chatWakeTool: "plugin_chat_wake", watchPollTool: "plugin_watch_poll" };

  test("injects the stage text as context, tagged with the session id and prompt", async () => {
    const harness = installModsHarness({ instructions: "I", stageResponse: { text: "[thatch] nudge text" } });
    registerMod(harness.register, options);
    const out = await harness.runPromptSubmit({ text: "fix the parser" });
    expect(harness.stageCalls).toEqual([{ prompt: "fix the parser", sessionId: harness.sessionId }]);
    expect(out.context).toEqual(["[thatch] nudge text"]);
  });

  test("injects nothing when the stage returns empty text", async () => {
    const harness = installModsHarness({ instructions: "I", stageResponse: "" });
    registerMod(harness.register, options);
    const out = await harness.runPromptSubmit({ text: "hello" });
    expect(out.context).toBeUndefined();
  });

  test("fails open: a stage error proceeds without thatch context", async () => {
    const harness = installModsHarness({ instructions: "I", stageError: new Error("server down") });
    registerMod(harness.register, options);
    const out = await harness.runPromptSubmit({ text: "fix the parser" });
    expect(out.context).toBeUndefined();
    expect(out.text).toBe("fix the parser");
  });

  test("preserves context an earlier hook appended", async () => {
    const harness = installModsHarness({ instructions: "I", stageResponse: { text: "nudge" } });
    registerMod(harness.register, options);
    // Simulate an earlier mod in the chain by pre-seeding context.
    const out = await harness.runPromptSubmit({ text: "hi", context: ["earlier"] });
    expect(out.context).toEqual(["earlier", "nudge"]);
  });
});

describe("readStageText: the response envelope is a QA pin", () => {
  test("bare string", () => {
    expect(readStageText("nudge")).toBe("nudge");
  });
  test("{ text } envelope", () => {
    expect(readStageText({ text: "nudge" })).toBe("nudge");
  });
  test("{ result } envelope", () => {
    expect(readStageText({ result: "nudge" })).toBe("nudge");
  });
  test("MCP content-block array", () => {
    expect(readStageText([{ type: "text", text: "nudge" }])).toBe("nudge");
  });
  test("null and junk degrade to empty", () => {
    expect(readStageText(null)).toBe("");
    expect(readStageText({ other: 1 })).toBe("");
  });
});

test("the mod's import graph is Node-free (the mods runtime gives hooks no Node APIs)", () => {
  // Walks the mod's LOCAL import graph and refuses any node: specifier.
  // The generated plugin's bundle uses the browser target (a second net:
  // a node: import fails the setup build), but this probe keeps the
  // SOURCE honest where CI can see it.
  const walk = (file: string, seen: Set<string> = new Set()): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1]!;
      expect(spec.startsWith("node:"), `${file} imports ${spec} - the mod must stay Node-free`).toBe(false);
      if (spec.startsWith(".")) walk(join(dirname(file), spec) + ".ts", seen);
    }
  };
  walk("src/claude-plugin/mod.ts");
});

describe("plugin mod: lifecycle forwarding (Step B)", () => {
const options = {
    instructions: "I",
    serverKey: "thatch", stageTool: "plugin_stage",
    lifecycleTool: "plugin_lifecycle",
    chatWakeTool: "plugin_chat_wake",
    watchPollTool: "plugin_watch_poll",
  };

  test("turn.start forwards busy for MAIN-conversation turns only", async () => {
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, options);
    await harness.run("turn.start", { agentId: undefined });
    expect(harness.lifecycleCalls.map((c) => c.event)).toEqual(["busy"]);
    await harness.run("turn.start", { agentId: "agent-1" });
    expect(harness.lifecycleCalls.length).toBe(1); // subagent turn: no forward
  });

  test("tool.call forwards realwork (main only); greenlight tools route to greenlight", async () => {
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, options);
    await harness.run("tool.call", { tool: "Bash", agentId: undefined });
    expect(harness.lifecycleCalls.at(-1)?.event).toBe("realwork");
    await harness.run("tool.call", { tool: "Bash", agentId: "agent-1" });
    // Subagent calls BUFFER now (is_main=false) - but never mark work.
    expect(harness.lifecycleCalls.length).toBe(2);
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "realwork", is_main: false });
    // The greenlight tool: matched handler answers with the server's text.
    harness.setLifecycleResponse({ text: "[not armed] The compact wrap-up was never armed." });
    const res = await harness.run("tool.call", { tool: "mcp__thatch__compact" });
    expect((res as { result: string }).result).toContain("not armed");
    expect(harness.lifecycleCalls.at(-1)?.event).toBe("greenlight");
  });

  test("turn.complete forwards the abort flag; a greenlit wrapup fires the host action", async () => {
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, options);
    await harness.run("turn.complete", { agentId: undefined, isAborted: true });
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "complete", is_aborted: true });
    // Arm + greenlight via the routed handlers, then complete: compact fires.
    // The lifecycle responses are scripted per call (arm ack, greenlight
    // ack, the complete resolution naming the action).
    await harness.run("command.run", { command: "thatch_compact" });
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "arm", kind: "compact" });
    harness.setLifecycleResponse({ text: "[greenlit] fires at turn end." });
    await harness.run("tool.call", { tool: "mcp__thatch__compact" });
    harness.setLifecycleResponse({ text: "", wrapup: "compact" });
    await harness.run("turn.complete", { agentId: undefined, isAborted: false });
    expect(harness.compacted).toBe(1);
    // Exit degrades to the user notification (no host close API).
    harness.setLifecycleResponse({ text: "[greenlit] fires at turn end." });
    await harness.run("tool.call", { tool: "mcp__thatch__exit" });
    harness.setLifecycleResponse({ text: "", wrapup: "exit" });
    await harness.run("turn.complete", { agentId: undefined, isAborted: false });
    expect(harness.notified.at(-1)).toContain("safe to close");
  });

  test("session.start registers the wrap-up commands and tools", async () => {
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, options);
    await harness.run("session.start", {});
    expect(harness.registeredCommands.sort()).toEqual(["thatch_compact", "thatch_exit"]);
    expect(harness.registeredTools.sort()).toEqual(["compact", "exit"]);
  });

  test("classic.PermissionRequest forwards the pause ask; Denied resolves it", async () => {
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, options);
    await harness.run("classic.PermissionRequest", { tool_use_id: "toolu_1" });
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "ask", kind: "permission", request_id: "toolu_1" });
    await harness.run("classic.PermissionDenied", { tool_use_id: "toolu_1" });
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "resolved", request_id: "toolu_1" });
  });
});

describe("plugin mod: chat wake (Step C)", () => {
  const options = {
    instructions: "I",
    serverKey: "thatch", stageTool: "plugin_stage",
    lifecycleTool: "plugin_lifecycle",
    chatWakeTool: "plugin_chat_wake",
    watchPollTool: "plugin_watch_poll",
  };

  test("session.start schedules the poll cadence and registers the wrap-up surface", async () => {
    const harness = installModsHarness({ instructions: "I" });
    registerMod(harness.register, options);
    await harness.run("session.start", {});
    expect(harness.clockTicks.length).toBe(1);
    expect(harness.registeredCommands.sort()).toEqual(["thatch_compact", "thatch_exit"]);
  });

  test("a poll hit submits the wake text as a turn and marks wake provenance", async () => {
    const harness = installModsHarness({ instructions: "I", stageResponse: "" });
    registerMod(harness.register, options);
    await harness.run("session.start", {});
    harness.setStageResponse("nudge-for-the-prompt-hook");
    harness.setChatWakeResponse("[thatch] chat: unread message for you");
    await harness.clockTicks[0]!();
    expect(harness.submittedPrompts).toEqual(["[thatch] chat: unread message for you"]);
    // The wake turn begins: turn.start forwards busy with the wake
    // provenance (the machine classifies the round synthetic).
    await harness.run("turn.start", { agentId: undefined });
    expect(harness.lifecycleCalls.find((c) => c.event === "busy")?.wake).toBe(true);
  });

  test("a refused submission is held and retried from turn.complete", async () => {
    const harness = installModsHarness({ instructions: "I", stageResponse: "" });
    registerMod(harness.register, options);
    await harness.run("session.start", {});
    harness.heldRefusal = true;
    harness.setChatWakeResponse("wake nudge");
    await harness.clockTicks[0]!();
    expect(harness.submittedPrompts).toEqual([]); // refused - held, not lost
    // The user's next input un-holds the session; the turn.end retry lands.
    harness.heldRefusal = false;
    await harness.run("turn.complete", { agentId: undefined, isAborted: false });
    expect(harness.submittedPrompts).toEqual(["wake nudge"]); // retried
  });

  test("a quiet poll submits nothing", async () => {
    const harness = installModsHarness({ instructions: "I", stageResponse: "" });
    registerMod(harness.register, options);
    await harness.run("session.start", {});
    await harness.clockTicks[0]!(); // lifecycle default: { text: "" }
    expect(harness.submittedPrompts).toEqual([]);
  });
});

describe("THE WIRE: mod forwards through the REAL plugin_lifecycle schema", () => {
  // The round-2/3 reviews' root cause: both test suites entered at their
  // own side of the mod->tool seam (camelCase both sides) while the tool's
  // zod schema reads snake_case - deepPassthrough rode the junk silently.
  // This test drives the mod's ACTUAL forward payload through the REAL
  // ToolDef's execute (schema validation + field mapping) into a
  // lifecycle spy, so the seam's naming contract is asserted end to end.
  const options = {
    instructions: "I",
    serverKey: "thatch", stageTool: "plugin_stage",
    lifecycleTool: "plugin_lifecycle",
    chatWakeTool: "plugin_chat_wake",
    watchPollTool: "plugin_watch_poll",
  };

  test("abort + realwork survive the schema into the lifecycle verdicts", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "wire-"));
    process.env.THATCH_QUEUE_DIR = dir;
    try {
      const captured: Record<string, unknown>[] = [];
      const harness = installModsHarness({ instructions: "I", stageResponse: "" });
      registerMod(harness.register, options);

      // The REAL def: schema + execute - the wire under test. The
      // harness's api.mcp.call is PATCHED so the mod's lifecycle forwards
      // route through the def's ZOD SCHEMA (the boundary's naming
      // authority) into a spy ctx - the crossing both suites skipped.
      const { TOOL_DEFS } = await import("../src/tool-defs");
      const def = TOOL_DEFS.find((t) => t.name === "plugin_lifecycle")!;
      const harnessCall = harness.api.mcp.call.bind(harness.api.mcp);
      harness.api.mcp.call = async (server: string, tool: string, args?: Record<string, unknown>) => {
        if (tool !== "plugin_lifecycle") return harnessCall(server, tool, args);
        return def.execute((args ?? {}) as never, { pluginLifecycle: async (event: Record<string, unknown>) => { captured.push(event); return { text: "ok" }; } } as never);
      };

      // The mod's forwards, with the mod's ACTUAL spellings.
      await harness.run("tool.call", { tool: "Bash", agentId: "agent-9", command: "ls", }); // subagent
      await harness.run("tool.call", { tool: "Bash", agentId: undefined, command: "git status" });
      await harness.run("turn.complete", { agentId: undefined, isAborted: true });

      // The subagent call buffered (is_main=false), with the tool's OWN
      // args + result text - NOT the empty/undefined the pre-fix wire
      // produced.
      const realwork = captured.filter((c) => c.event === "realwork");
      expect(realwork.length).toBe(2);
      expect(realwork[0]).toMatchObject({ tool: "Bash", isMain: false, args: { command: "ls" } });
      expect(realwork[1]).toMatchObject({ tool: "Bash", isMain: true, args: { command: "git status" } });
      // The abort survived the schema: the lifecycle's complete got it.
      expect(captured.find((c) => c.event === "complete")).toMatchObject({ isAborted: true });
    } finally {
      delete process.env.THATCH_QUEUE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the generated shim's option object typechecks against ThatchModOptions", async () => {
    // The r1 blocker's class: the shim is a generated STRING outside the
    // type system - its option object was silently missing two of three
    // coordinates. Parse the shim out of the setup source and typecheck
    // its options against the mod's REAL option type.
    const setupSrc = readFileSync(join(__dirname, "../src/setup.ts"), "utf8");
    const shimMatch = setupSrc.match(/export function register\(on\) \{[\s\S]*?return thatchRegister\(on, (\{[\s\S]*?\})\);/);
    expect(shimMatch).not.toBeNull();
    // Parse-free: each required ThatchModOptions key must appear in the
    // shim's option object (the shim is a generated string - parse it by
    // key presence, then verify the key exists in the mod's option type).
    const shimOptions = shimMatch![1]!;
    const modSrc = readFileSync(join(__dirname, "../src/claude-plugin/mod.ts"), "utf8");
    for (const key of ["instructions", "stageTool", "lifecycleTool", "chatWakeTool", "watchPollTool"]) {
      expect(shimOptions, `the generated shim is missing ThatchModOptions.${key}`).toContain(`${key}:`);
      expect(modSrc, `ThatchModOptions.${key} must exist in the mod's option type`).toContain(`${key}:`);
    }
    // The shim's IMPORTED NAME must be a real mod.ts export (the F1
    // blocker's class: `import { register }` linked nothing - registerMod
    // is the export - and the whole regime delivered nothing). Asserts
    // the import's source name against mod.ts's export list.
    const importMatch = setupSrc.match(/import \{ (\w+)(?: as \w+)? \} from "\.\/mod\.js"/);
    expect(importMatch, "the shim does not import from ./mod.js").not.toBeNull();
    expect(modSrc, `mod.ts must export ${importMatch![1]} (the shim imports it)`).toMatch(new RegExp(`export (function|const) ${importMatch![1]}\\b`));
  });
});

describe("THE WIRE: all four crossings through the REAL tool defs", () => {
  const options = {
    instructions: "I",
    serverKey: "thatch", stageTool: "plugin_stage",
    lifecycleTool: "plugin_lifecycle",
    chatWakeTool: "plugin_chat_wake",
    watchPollTool: "plugin_watch_poll",
  };

  /** Routes the harness's mcp.call for ONE tool through the tool's REAL
   *  def execute (schema validation + field mapping) into a spy ctx - the
   *  F3 pattern: no crossing may be tested with the harness's own
   *  re-encoded naming. */
  const wire = async (toolName: string, spyCtx: Record<string, unknown>) => {
    const { TOOL_DEFS } = await import("../src/tool-defs");
    const def = TOOL_DEFS.find((t) => t.name === toolName)!;
    const harness = installModsHarness({ instructions: "I", stageResponse: "" });
    const orig = harness.api.mcp.call.bind(harness.api.mcp);
    harness.api.mcp.call = async (server: string, tool: string, args?: Record<string, unknown>) => {
      if (tool !== toolName) return orig(server, tool, args);
      return def.execute((args ?? {}) as never, spyCtx as never);
    };
    registerMod(harness.register, options);
    return harness;
  };

  test("plugin_stage: the mod's prompt/session/transcript arrive through the schema", async () => {
    const calls: { prompt: string; sessionID: string; transcriptPath?: string }[] = [];
    const harness = await wire("plugin_stage", {
      pluginStage: async (prompt: string, sessionID: string, transcriptPath?: string) => {
        calls.push({ prompt, sessionID, transcriptPath });
        return "";
      },
    });
    await harness.runPromptSubmit({ text: "the user prompt", transcript_path: "/t/x.jsonl" });
    expect(calls).toEqual([{ prompt: "the user prompt", sessionID: harness.sessionId, transcriptPath: "/t/x.jsonl" }]);
  });

  test("plugin_chat_wake + plugin_watch_poll: the mod's session id arrives; their text submits", async () => {
    const wakeCalls: string[] = [];
    const pollCalls: string[] = [];
    const harness = installModsHarness({ instructions: "I", stageResponse: "" });
    // Route BOTH poll tools through their real defs (the F3 pattern: no
    // crossing tested with the harness's own naming).
    const { TOOL_DEFS } = await import("../src/tool-defs");
    const wakeDef = TOOL_DEFS.find((t) => t.name === "plugin_chat_wake")!;
    const pollDef = TOOL_DEFS.find((t) => t.name === "plugin_watch_poll")!;
    const orig = harness.api.mcp.call.bind(harness.api.mcp);
    harness.api.mcp.call = async (server: string, tool: string, args?: Record<string, unknown>) => {
      if (tool === "plugin_chat_wake") {
        return wakeDef.execute((args ?? {}) as never, {
          pluginChatWake: (sid: string) => {
            wakeCalls.push(sid);
            return "";
          },
        } as never);
      }
      if (tool === "plugin_watch_poll") {
        return pollDef.execute((args ?? {}) as never, {
          watchers: {
            consumePending: (sid: string) => {
              pollCalls.push(sid);
              return [];
            },
          },
        } as never);
      }
      return orig(server, tool, args);
    };
    registerMod(harness.register, options);
    // One beat, two polls - both session ids arrive schema-validated.
    await harness.run("session.start", {});
    await harness.clockTicks[0]!();
    expect(wakeCalls).toEqual([harness.sessionId]);
    expect(pollCalls).toEqual([harness.sessionId]);
    expect(harness.submittedPrompts).toEqual([]);
  });

  test("F7: the lifecycle execute forwards EVERY schema field (no silent drops)", async () => {
    // Reflects def.args against the execute() mapping: each schema key
    // must land in the captured event under its mapped name. A future
    // field addition that forgets the mapping fails here instead of
    // passing silently through deepPassthrough.
    const { TOOL_DEFS } = await import("../src/tool-defs");
    const def = TOOL_DEFS.find((t) => t.name === "plugin_lifecycle")!;
    // The FULL-arg payload (every field present, all distinct values).
    const full = {
      event: "realwork",
      session_id: "S",
      tool: "T",
      error: "E",
      is_aborted: true,
      is_main: true,
      wake: true,
      kind: "compact",
      request_id: "R",
      tool_input: { ti: 1 },
      tool_response: "TR",
    };
    // Capture via the real execute.
    const captured: Record<string, unknown>[] = [];
    await ((def as { execute: (a: unknown, c: unknown) => Promise<string> }).execute)(full, {
      pluginLifecycle: async (event: Record<string, unknown>) => {
        captured.push(event);
        return { text: "" };
      },
    } as never);
    {
      const ev = captured[0]!;
      // Every schema key maps to the event under the boundary contract:
      // snake_case in, the documented camelCase (or same-name) field out.
      const expected: Record<string, unknown> = {
        event: full.event,
        sessionID: full.session_id,
        tool: full.tool,
        error: full.error,
        isAborted: full.is_aborted,
        isMain: full.is_main,
        wake: full.wake,
        kind: full.kind,
        requestID: full.request_id,
        args: full.tool_input,
        result: full.tool_response,
      };
      for (const [k, v] of Object.entries(expected)) {
        expect(ev[k], `schema field ${k} must forward to the lifecycle event`).toEqual(v);
      }
      // And nothing unexplained rides along.
      expect(Object.keys(ev).sort()).toEqual(Object.keys(expected).sort());
    }
  });
});

test("F2: the plugin-regime instructions variant teaches watch+wake as available", async () => {
  // The regime renders a VARIANT: the hooks wording teaches the watch
  // tools and wake delivery as opencode-only, while the plugin regime
  // serves exactly those features - teaching absence would hide them.
  // (Whitespace collapsed: the template wraps lines.)
  const { claudeInstructions } = await import("../src/prompts");
  const hooks = claudeInstructions();
  const plugin = claudeInstructions("plugin").replace(/\s+/g, " ");
  // The hooks variant keeps the absence claims (the fallback regime).
  expect(hooks).toContain("wake-up delivery is opencode-only");
  expect(hooks).toContain("watch_create");
  // The plugin variant flips BOTH claims and keeps the never-serves trio.
  expect(plugin).toContain("plugin regime polls and delivers");
  expect(plugin).toContain("Chat wake-up delivery also works");
  expect(plugin).not.toContain("wake-up delivery is opencode-only");
  expect(plugin).toContain("session_search"); // the trio stays absent-teached
  expect(plugin).not.toContain("watch_create, watch_branch_create, watch_command_create, watch_list, watch_cancel, exit"); // not in the absent list
  // THE SPELLING PIN, exhaustive: the plugin variant renders ZERO
  // standalone spellings (mcp__thatch__* tools do not exist in a plugin
  // session - the host namespaces the bundled server
  // mcp__plugin_thatch_thatch__*), and the standalone spelling appears in
  // the rendered tool list, prediction-duplicate paragraph, and extraction
  // contract alike. One missed paragraph was Jeff's try-3 finding.
  expect(plugin).not.toContain("mcp__thatch__");
  expect((plugin.match(/mcp__plugin_thatch_thatch__/g) ?? []).length).toBeGreaterThanOrEqual(32);
});

test("the fail-open surfaces are LOUD: a stage failure logs the reason", async () => {
  // The mixed-source install's other half: the bare catch made the regime
  // silently dark. A stage failure must leave a line in the log sink.
  const harness = installModsHarness({ instructions: "I", stageError: new Error("server down") });
  registerMod(harness.register, {
    instructions: "I",
    serverKey: "thatch", stageTool: "plugin_stage",
    lifecycleTool: "plugin_lifecycle",
    chatWakeTool: "plugin_chat_wake",
    watchPollTool: "plugin_watch_poll",
  });
  const out = await harness.runPromptSubmit({ text: "fix the parser" });
  expect(out.context).toBeUndefined(); // fail-open: the prompt proceeds
  expect(harness.logged.some((l) => l.includes("stage call failed") && l.includes("server down"))).toBe(true);
});

test("THE CALL-SHAPE PIN: the harness + mod match the HOST's own d.ts when it is installed", async () => {
  // The round-2 blocker's root: the mock + the mod shared a wrong
  // $.mcp.call understanding (one object; positional in truth). The
  // host ships its type definitions INSIDE the generated plugin tree
  // (<pluginRoot>/.claude-plugin/types/claude-code/index.d.ts) - when
  // present (a real QA install), the shapes are pinned against it; in
  // CI (no install) the test skips - the harness's structural assertions
  // carry the contract there.
  const dts = join(process.env.HOME ?? "", ".claude", "thatch-plugin", ".claude-plugin", "types", "claude-code", "index.d.ts");
  if (!existsSync(dts)) return;
  const src = readFileSync(dts, "utf8");
  // call is POSITIONAL with (server, tool, args?).
  expect(src).toMatch(/call:\s*\(server:\s*string,\s*tool:\s*string,\s*args\?:\s*Record<string,\s*unknown>\)\s*=>\s*Promise<McpToolResult>/);
  // connect takes the MANIFEST KEY and resolves the routable name.
  expect(src).toMatch(/connect:\s*\(server:\s*string\)\s*=>\s*Promise<McpConnectResult>/);
  expect(src).toContain("`plugin:<plugin>:<server>`");
  // The harness encodes the same shape: its call takes (server, tool, args)
  // positionally and refuses the wrong server name.
  const harnessSrc = readFileSync(join(__dirname, "mocks", "mods-harness.ts"), "utf8");
  expect(harnessSrc).toContain("call: async (server: string, tool: string, args?: Record<string, unknown>)");
  expect(harnessSrc).toContain('PLUGIN_SERVER_NAME = "plugin:thatch:thatch"');
  // And the mod routes through connect + positional call only - no
  // object-form mcp.call survives anywhere in the mod source.
  const modSrc = readFileSync(join(__dirname, "../src/claude-plugin/mod.ts"), "utf8");
  expect(modSrc).not.toMatch(/\$\.mcp\.call\(\s*\{/);
  expect(modSrc).toContain("await $.mcp.connect(options.serverKey)");
});
