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

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// One-per-process unhandledRejection logger, opt-in via THATCH_DEBUG. The
// host logs these bare ("unhandled rejection" + message, no stack), which is
// exactly wrong for diagnosing which async continuation in the plugin
// escaped its error handling - the dispose-race class in particular escapes
// through several surfaces (pollers, hooks, delayed finalizers). Writes to
// the debug log beside the database (same file createDebugLog uses), tagged
// so a grep on "[rejection:" pulls the story out.
//
// Registered at module scope because rejections can fire before or after
// setup runs, and once per process because v2 re-evaluates this module on
// every plugin reload (a bare process.on would pile up listeners). The key
// is a Symbol.for so the guard survives module re-evaluation in the same
// thread; worker threads have their own globalThis and process, and one
// logger per thread is correct anyway. Registering the listener marks the
// rejections "handled" - suppressing the host's default crash-on-unhandled -
// so the handler also echoes the detail to console.error to keep the
// failure visible while diagnosing.
const rejectionLoggerKey = Symbol.for("thatch.unhandledRejectionLogger");
if (process.env.THATCH_DEBUG && !(globalThis as any)[rejectionLoggerKey]) {
  const home = process.env.HOME ?? "/tmp";
  const configHome = process.env.XDG_CONFIG_HOME ?? `${home}/.config`;
  const dbPath = process.env.THATCH_DB_PATH ?? `${configHome}/thatch/thatch.db`;
  // A file: URI db path has no meaningful sibling debug.log (appendFileSync
  // cannot open "file:.../debug.log"); skip logging rather than silently
  // drop every rejection into the catch below.
  (globalThis as any)[rejectionLoggerKey] = !dbPath.startsWith("file:");
  if ((globalThis as any)[rejectionLoggerKey]) {
    const file = join(dirname(dbPath), "debug.log");
    process.on("unhandledRejection", (reason) => {
      const detail =
        reason instanceof Error
          ? `${reason.message}\n${reason.stack ?? "(no stack)"}`
          : String(reason);
      console.error(`[thatch] unhandled rejection: ${detail.split("\n")[0]}`);
      try {
        appendFileSync(file, `${new Date().toISOString()} [rejection:unhandled] ${detail}\n`);
      } catch {
        // Diagnostics must not break the host (same contract as debug.log).
      }
    });
  }
}

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
