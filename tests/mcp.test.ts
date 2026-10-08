import { describe, test, expect } from "bun:test";
import { compileTools, compilePrompts, createMcpTeardown } from "../src/mcp";
import { TOOL_DEFS } from "../src/tool-defs";
import { actionDefs, claudeCommandDefs, opencodeCommandDefs } from "../src/commands";

describe("MCP teardown", () => {
  const makeDeps = () => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        sideband: { stop: () => void calls.push("sideband.stop") },
        model: { dispose: async () => void calls.push("model.dispose") },
        db: { close: () => void calls.push("db.close") },
        dbPath: "/tmp/fake-thatch.db",
        stopVersionChecker: () => void calls.push("stopVersionChecker"),
        removeVersionFile: (dbPath: string) => void calls.push(`removeVersionFile(${dbPath})`),
      },
    };
  };

  test("runs every step once, in the safe order, even when called twice", async () => {
    const { deps, calls } = makeDeps();
    const teardown = createMcpTeardown(deps);
    await teardown("SIGINT");
    await teardown("stdin-end"); // second call is a no-op
    expect(calls).toEqual([
      "sideband.stop",
      "stopVersionChecker",
      "removeVersionFile(/tmp/fake-thatch.db)",
      "model.dispose",
      "db.close",
    ]);
  });

  test("a model-disposal failure still closes the db", async () => {
    const { deps, calls } = makeDeps();
    deps.model.dispose = async () => {
      calls.push("model.dispose");
      throw new Error("ORT session stuck");
    };
    const teardown = createMcpTeardown(deps);
    await teardown("SIGTERM");
    expect(calls[calls.length - 1]).toBe("db.close");
  });

  test("the db close runs last even when the sideband itself throws", async () => {
    const { deps, calls } = makeDeps();
    deps.sideband.stop = () => {
      calls.push("sideband.stop");
      throw new Error("socket already unlinked");
    };
    const teardown = createMcpTeardown(deps);
    await teardown("SIGHUP");
    expect(calls).toContain("db.close");
    expect(calls[calls.length - 1]).toBe("db.close");
  });
});

describe("MCP compileTools", () => {
  test("exposes every shared tool under its bare name", () => {
    const tools = compileTools();
    for (const def of TOOL_DEFS.filter((d) => !d.opencodeOnly && !d.v2Only)) {
      expect(tools.has(def.name), `missing ${def.name}`).toBe(true);
    }
  });

  test("filters out opencode-only tools", () => {
    const tools = compileTools();
    for (const def of TOOL_DEFS.filter((d) => d.opencodeOnly || d.v2Only)) {
      expect(tools.has(def.name), `${def.name} must not be exposed over MCP`).toBe(false);
    }
  });

  test("exposes 29 shared tools (session_tab is v2-opencode-only)", () => {
    expect(compileTools().size).toBe(29);
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
    // And opencode is strictly a superset: shared actions + wrap-ups + the
    // opencode-only actions.
    const opencodeNames = opencodeCommandDefs().map((d) => d.name).sort();
    expect(opencodeNames).toEqual([...promptNames, "compact", "exit", "extract", "whois"].sort());
  });
});
