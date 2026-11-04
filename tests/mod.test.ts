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
    registerMod(harness.register, { instructions: "THATCH INSTRUCTIONS BLOCK", stageTool: { server: "thatch", tool: "plugin_stage" } });
    const out = await harness.runPromptCompose({ sections: ["existing section"] });
    expect(out.sections).toEqual(["existing section", "THATCH INSTRUCTIONS BLOCK"]);
  });
});

describe("plugin mod: prompt.submit", () => {
  const options = { instructions: "I", stageTool: { server: "thatch", tool: "plugin_stage" } };

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
