import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { registerMod, readStageText } from "../src/claude-plugin/mod";
import { installModsHarness } from "./mocks/mods-harness";

// The plugin mod's decision logic, pure against the mods-$ double
// (tests/mocks/mods-harness.ts). The harness encodes the QA pins' assumed
// shapes in one place; if a pin fails on the real app, the fix lands
// there and here.

describe("plugin mod: prompt.compose", () => {
  test("injects the instructions as a new section, preserving existing ones", async () => {
    const harness = installModsHarness({ instructions: "THATCH INSTRUCTIONS BLOCK" });
    registerMod(harness.register, { instructions: "THATCH INSTRUCTIONS BLOCK", stageTool: { server: "thatch", tool: "plugin_stage" }, lifecycleTool: { server: "thatch", tool: "plugin_lifecycle" }, chatWakeTool: { server: "thatch", tool: "plugin_chat_wake" }, watchPollTool: { server: "thatch", tool: "plugin_watch_poll" } });
    const out = await harness.runPromptCompose({ sections: ["existing section"] });
    expect(out.sections).toEqual(["existing section", "THATCH INSTRUCTIONS BLOCK"]);
  });
});

describe("plugin mod: prompt.submit", () => {
  const options = { instructions: "I", stageTool: { server: "thatch", tool: "plugin_stage" }, lifecycleTool: { server: "thatch", tool: "plugin_lifecycle" }, chatWakeTool: { server: "thatch", tool: "plugin_chat_wake" }, watchPollTool: { server: "thatch", tool: "plugin_watch_poll" } };

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
    stageTool: { server: "thatch", tool: "plugin_stage" },
    lifecycleTool: { server: "thatch", tool: "plugin_lifecycle" },
    chatWakeTool: { server: "thatch", tool: "plugin_chat_wake" },
    watchPollTool: { server: "thatch", tool: "plugin_watch_poll" },
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
    expect(harness.lifecycleCalls.length).toBe(1); // subagent call: no forward
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
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "complete", isAborted: true });
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
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "ask", kind: "permission", requestID: "toolu_1" });
    await harness.run("classic.PermissionDenied", { tool_use_id: "toolu_1" });
    expect(harness.lifecycleCalls.at(-1)).toMatchObject({ event: "resolved", requestID: "toolu_1" });
  });
});

describe("plugin mod: chat wake (Step C)", () => {
  const options = {
    instructions: "I",
    stageTool: { server: "thatch", tool: "plugin_stage" },
    lifecycleTool: { server: "thatch", tool: "plugin_lifecycle" },
    chatWakeTool: { server: "thatch", tool: "plugin_chat_wake" },
    watchPollTool: { server: "thatch", tool: "plugin_watch_poll" },
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
