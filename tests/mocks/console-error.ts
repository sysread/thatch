/**
 * Scoped console.error control for tests and QA use cases. Two intents,
 * two wrappers - both replace console.error for the duration of `fn` and
 * ALWAYS restore it on exit, including on a throw. The caller never touches
 * console.error, so the classic hand-rolled failure mode - a missed or
 * conditional restore leaking a stubbed console.error over the rest of the
 * run, silently swallowing genuine errors - is structurally impossible.
 *
 * - silenceConsoleError(fn): swallow the lines. For expected failures whose
 *   logging would leak into the test output.
 * - captureConsoleError(fn): record the lines as joined strings and return
 *   them. For asserting a degrade log fired.
 *
 * Larger granularities have a sound alternative: pairing the swap with
 * beforeEach/afterEach (or a try/finally around a whole use-case run) is
 * symmetric and restores unconditionally - see the watcher-death describe
 * in tests/watchers-registry.test.ts and uc-118. What this module exists to
 * prevent is the per-test hand-rolled dance, where the restore is one
 * forgotten finally away from a leak.
 */

export async function silenceConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

export async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}
