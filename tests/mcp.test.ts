import { describe, test, expect } from "bun:test";
import { compileTools, compilePrompts } from "../src/mcp";
import { TOOL_DEFS } from "../src/tool-defs";
import { actionDefs, claudeCommandDefs, opencodeCommandDefs } from "../src/commands";

describe("MCP compileTools", () => {
  test("exposes every shared tool under its bare name", () => {
    const tools = compileTools();
    for (const def of TOOL_DEFS.filter((d) => !d.opencodeOnly)) {
      expect(tools.has(def.name), `missing ${def.name}`).toBe(true);
    }
  });

  test("filters out opencode-only tools", () => {
    const tools = compileTools();
    for (const def of TOOL_DEFS.filter((d) => d.opencodeOnly)) {
      expect(tools.has(def.name), `${def.name} must not be exposed over MCP`).toBe(false);
    }
  });

  test("exposes 28 shared tools", () => {
    expect(compileTools().size).toBe(28);
  });
});

describe("MCP compilePrompts", () => {
  test("exposes the shared actions, spelled with MCP tool names", () => {
    const prompts = compilePrompts();
    const expected = actionDefs((n) => `mcp__thatch__${n}`).filter((a) => !a.opencodeOnly);
    expect([...prompts.keys()].sort()).toEqual(expected.map((a) => a.name).sort());
    for (const action of expected) {
      const prompt = prompts.get(action.name)!;
      expect(prompt.body).toBe(action.body);
    }
    // Tool-name spelling follows the host: the defrag prompt (which names
    // memory tools) must use the MCP spelling. The hygiene prompt drives
    // the thatch CLI and names no tools, so it is exempt.
    expect(prompts.get("defrag")!.body).toMatch(/mcp__thatch__/);
    expect(prompts.get("defrag")!.body).not.toContain("thatch_find_duplicates");
  });

  test("prompts match Claude Code's command set one-to-one (parity guard)", () => {
    const promptNames = [...compilePrompts().keys()].sort();
    const claudeNames = claudeCommandDefs().map((d) => d.name).sort();
    expect(promptNames).toEqual(claudeNames);
    // And opencode is strictly a superset: shared actions + wrap-ups + extract.
    const opencodeNames = opencodeCommandDefs().map((d) => d.name).sort();
    expect(opencodeNames).toEqual([...promptNames, "compact", "exit", "extract"].sort());
  });
});
