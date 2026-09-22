import type { Plugin } from "@opencode-ai/plugin";
import { capabilitiesFromClient } from "../capabilities";
import { createRuntime } from "../runtime";
import { createTools } from "../tools";

// The opencode v1 adapter (opencode 1.x, plugin API @opencode-ai/plugin
// 1.x). Thin by design: builds HostCapabilities from the PluginInput client
// and delegates to the shared runtime. Loaded only by v1 hosts - the dual
// entry (src/index.ts) lazy-imports this module so the v1 SDK's runtime
// import never evaluates under a v2 host.

export const server: Plugin = async ({ client, worktree, directory }) => {
  const runtime = await createRuntime({
    capabilities: capabilitiesFromClient(client),
    directory,
    worktree,
  });

  return {
    tool: createTools(runtime.coreContext),

    "experimental.chat.system.transform": async (_input, output) => {
      await runtime.onSystemTransform(output);
    },

    "experimental.session.compacting": async (input, output) => {
      await runtime.onSessionCompacting(input, output);
    },

    "experimental.compaction.autocontinue": async (input) => {
      await runtime.onCompactionAutocontinue(input);
    },

    "tool.execute.after": async (input, output) => {
      await runtime.onToolExecuteAfter(input, output);
    },

    "command.execute.before": async (input) => {
      await runtime.onCommandExecuteBefore(input);
    },

    "chat.message": async (input, output) => {
      await runtime.onChatMessage(input, output);
    },

    event: async ({ event }) => {
      await runtime.onEvent(event);
    },

    dispose: async () => {
      await runtime.dispose();
    },
  };
};
