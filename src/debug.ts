import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Opt-in diagnostic logging for questions a live harness cannot otherwise
// answer ("what did the plugin actually see at init?"). Lines go to
// debug.log beside the database, never to the host's stdout or stderr:
// the plugin runs inside opencode's TUI process, where console output is
// invisible or garbles the screen, and test sandboxes point the database at
// a tmp dir so their debug output never reaches the quality gate.
//
// Off unless THATCH_DEBUG is set. THATCH_DEBUG=1 (or "all" / "*") logs every
// tag. Otherwise it is a comma-separated list of tag filters: a filter
// matches a tag when it equals the whole tag ("chat:startup") or the
// feature part before the colon ("chat" matches every chat:* tag).
//
// Tags are `feature:aspect`, rendered in square brackets, so a grep on
// "[chat:" pulls one feature's story out of a shared file.

export type DebugLog = (tag: string, msg: string) => void;

// Decide, from a THATCH_DEBUG value, whether a tag is enabled. Exported for
// tests; callers use createDebugLog.
export function debugEnabled(spec: string | undefined, tag: string): boolean {
  if (!spec) return false;
  const s = spec.trim();
  if (s === "1" || s === "all" || s === "*") return true;
  const feature = tag.split(":")[0];
  return s.split(",").map((f) => f.trim()).filter(Boolean).some((f) => f === tag || f === feature);
}

// Build the logger for a database location. Every line: ISO timestamp,
// bracketed tag, message. Writes never throw: diagnostics must not break
// the host, so a missing directory or a full disk simply drops the line.
export function createDebugLog(dbPath: string, spec: string | undefined = process.env.THATCH_DEBUG): DebugLog {
  const file = join(dirname(dbPath), "debug.log");
  return (tag, msg) => {
    if (!debugEnabled(spec, tag)) return;
    try {
      appendFileSync(file, `${new Date().toISOString()} [${tag}] ${msg}\n`);
    } catch {
      // Intentionally silent; see above.
    }
  };
}
