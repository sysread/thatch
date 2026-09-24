import { tool } from "@opencode-ai/plugin";
import { TOOL_DEFS, trimHostContext, type CoreContext } from "./tool-defs";

// V1-ONLY module: this file imports the opencode v1 SDK at runtime, so
// nothing shared may import from it. The host-agnostic pieces
// (buildCoreContext, trimHostContext, CoreContext, TOOL_DEFS) live in
// tool-defs.ts precisely so the v2 adapter and the MCP server can use them
// without evaluating the v1 SDK - the v2 plugin install skips optional
// peers, and a missing SDK import here would kill the whole plugin load.

/**
 * Builds the v1 opencode tool map from shared tool definitions. Each
 * definition in TOOL_DEFS is wrapped in opencode's `tool()` with a
 * `thatch_` prefix on the name - opencode uses the object key as the tool
 * name, so the prefix lives here, not in the shared definitions. Takes the
 * shared CoreContext (buildCoreContext) rather than raw deps, so both host
 * adapters feed the same context construction.
 */
export function createTools(coreContext: CoreContext): Record<string, ReturnType<typeof tool>> {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const def of TOOL_DEFS) {
    tools[`thatch_${def.name}`] = tool({
      description: def.description,
      args: def.args,
      async execute(args, hostContext) {
        return def.execute(args as Record<string, unknown>, coreContext, trimHostContext(hostContext));
      },
    });
  }
  return tools;
}
