import { describe, test, expect } from "bun:test";
import { compileTools } from "../src/mcp";
import { TOOL_DEFS } from "../src/tool-defs";

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

  test("exposes 18 shared tools", () => {
    expect(compileTools().size).toBe(18);
  });
});
