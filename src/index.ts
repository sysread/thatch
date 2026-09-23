// Dual-shape plugin entry: opencode v1 (1.18.x) and v2 (2.x) load this same
// module but read different keys. The v1 loader (readV1Plugin) reads
// `default.server`; the v2 validator decodes `default` as `{ id, setup }`
// and strips excess keys. A merged default export carrying all three loads
// under either host, so no runtime version detection is needed and a single
// shim file serves both.
//
// ISOLATION RULE: this module's RUNTIME import graph must stay SDK-free
// (type-only imports are fine - they erase). Each adapter imports its host's
// SDK (@opencode-ai/plugin vs @opencode/plugin), and the SDKs resolve only
// under their own host's install, so both adapters are reached exclusively
// through dynamic import below. The same rule applies to src/runtime.ts: it
// is reachable from both adapters, so it too must never runtime-import an
// SDK. The pure helpers re-exported here live in SDK-free modules for the
// same reason.

import type { Plugin } from "@opencode-ai/plugin";
import type { Plugin as V2Plugin } from "@opencode/plugin";

// Pure, SDK-free helpers - tests, the CLI, and QA use cases import these.
export {
  osProcessArgs,
  startupSessionId,
  startupSessionIdFromArgv,
  continuesLastSessionFromArgv,
  continuesLastSessionId,
} from "./os-args";
export { hygieneReport } from "./hygiene";

// Named v1 export, preserved for the shim and tests. Lazy wrapper: never
// evaluate the v1 adapter (and its SDK import) under a v2 host.
export const server: Plugin = async (input, options) => (await import("./opencode/v1")).server(input, options);

export default {
  id: "jeffober-thatch",
  setup: async (context: unknown) => {
    const mod = await import("./opencode/v2");
    return mod.setup(context as V2Plugin.Context);
  },
  // The same lazy wrapper as the named export above: v1 hosts invoke it via
  // default.server, tests and shims via the named export.
  server,
};
