import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { TOOL_DEFS } from "../../../src/tool-defs";

/**
 * UC-059: Tool prefixing.
 *
 * Automatable: yes — tool name inspection is a structural check. The MCP
 * server exposes bare names from TOOL_DEFS. The thatch_ prefix is added
 * by opencode's plugin system. The mcp__thatch__ prefix is added by
 * Claude Code and Cursor's MCP client. This test verifies the bare names
 * in TOOL_DEFS and that the naming convention is consistent.
 */

const useCase: UseCase = {
  name: "UC-059-tool-prefixing",
  preconditions: [
    "- Thatch installed and on PATH for at least two hosts",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. Inspect the tool names in TOOL_DEFS (the single source of truth).",
    "2. Verify all names are bare (no prefix).",
    "3. Verify the MCP server's tools/list would expose the non-opencodeOnly bare names.",
  ].join("\n"),
  expected: [
    "- TOOL_DEFS exposes bare names: memory_remember, memory_recall, store_list, prediction_query, behavior_codify, etc.",
    "- The MCP server's tools/list handler maps t.def.name from TOOL_DEFS, skipping opencodeOnly defs (get_session_info, session_search, session_get), so it exposes the shared bare names.",
    "- opencode adds the thatch_ prefix via its plugin system. Claude Code and Cursor add the mcp__thatch__ prefix via their MCP client. The prefix is applied by the host, not by thatch.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    // Verify all tool names are bare (no thatch_ or mcp__ prefix).
    for (const def of TOOL_DEFS) {
      if (def.name.startsWith("thatch_") || def.name.startsWith("mcp__")) {
        console.log(`  FAIL: tool name "${def.name}" should be bare (no prefix)`);
        return "FAIL";
      }
    }

    // Verify the expected bare names are present.
    const names = TOOL_DEFS.map((t) => t.name);
    const expected = [
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
      "behavior_codify",
      "behavior_feedback",
      "behavior_list",
      "behavior_delete",
      "get_session_info",
      "session_search",
      "session_get",
    ];

    for (const name of expected) {
      if (!names.includes(name)) {
        console.log(`  FAIL: expected tool "${name}" not found in TOOL_DEFS`);
        return "FAIL";
      }
    }

    if (TOOL_DEFS.length !== expected.length) {
      console.log(`  FAIL: expected ${expected.length} tools, got ${TOOL_DEFS.length}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
