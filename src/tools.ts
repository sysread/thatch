import { tool } from "@opencode-ai/plugin";
import type { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";
import { TOOL_DEFS, type CoreContext, type HostToolContext } from "./tool-defs";

/**
 * Builds the opencode tool map from shared tool definitions. Each definition
 * in TOOL_DEFS is wrapped in opencode's `tool()` with a `thatch_` prefix
 * on the name - opencode uses the object key as the tool name, so the prefix
 * lives here, not in the shared definitions.
 */
export function createTools(
  db: ThatchDB,
  model: EmbeddingModel,
  defaultStore: string,
  extensions?: {
    extractionPayloadProvider?: CoreContext["extractionPayloadProvider"];
    drainExtractionQueue?: CoreContext["drainExtractionQueue"];
  },
): Record<string, ReturnType<typeof tool>> {
  const ctx: CoreContext = {
    db,
    model,
    defaultStore,
    extractionPayloadProvider: extensions?.extractionPayloadProvider,
    drainExtractionQueue: extensions?.drainExtractionQueue,
  };

  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const def of TOOL_DEFS) {
    tools[`thatch_${def.name}`] = tool({
      description: def.description,
      args: def.args,
      async execute(args, hostContext) {
        // Trim opencode's ToolContext to the host-agnostic fields the shared
        // definitions know about. Tests and MCP paths pass no host context.
        const host: HostToolContext | undefined = hostContext
          ? { sessionID: hostContext.sessionID, agent: hostContext.agent }
          : undefined;
        return def.execute(args as Record<string, unknown>, ctx, host);
      },
    });
  }
  return tools;
}
