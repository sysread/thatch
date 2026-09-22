import { tool } from "@opencode-ai/plugin";
import type { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";
import { TOOL_DEFS, type CoreContext, type HostToolContext } from "./tool-defs";
import type { WatcherRegistry } from "./watchers";

/** Extensions a host adapter passes into the shared CoreContext. */
export interface CoreContextExtensions {
  extractionPayloadProvider?: CoreContext["extractionPayloadProvider"];
  drainExtractionQueue?: CoreContext["drainExtractionQueue"];
  watcherRegistry?: WatcherRegistry;
  projectDir?: string;
}

/**
 * Builds the host-agnostic CoreContext both adapters share: the opencode
 * plugin path and the MCP server construct this once per plugin/MCP init
 * and reuse it for every tool call. Lives apart from the v1 `tool()` wrapper
 * so the v2 adapter can register TOOL_DEFS through the v2 ToolEditor without
 * pulling the v1 SDK into its import graph.
 */
export function buildCoreContext(
  db: ThatchDB,
  model: EmbeddingModel,
  defaultStore: string,
  extensions?: CoreContextExtensions,
): CoreContext {
  return {
    db,
    model,
    defaultStore,
    extractionPayloadProvider: extensions?.extractionPayloadProvider,
    drainExtractionQueue: extensions?.drainExtractionQueue,
    watchers: extensions?.watcherRegistry,
    projectDir: extensions?.projectDir,
  };
}

/**
 * Trim opencode's per-call ToolContext to the host-agnostic fields the
 * shared definitions know about. Both adapters do this same two-field trim;
 * tests and MCP paths pass no host context.
 */
export function trimHostContext(
  hostContext: { sessionID: string; agent: string } | undefined,
): HostToolContext | undefined {
  return hostContext ? { sessionID: hostContext.sessionID, agent: hostContext.agent } : undefined;
}

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
