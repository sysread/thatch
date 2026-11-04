import type { Readable } from "node:stream";

/**
 * The `thatch remember` subcommand's input parsing, which lives in src/
 * because bin/thatch is outside tsconfig and unreachable from bun test
 * (the same split as src/flush.ts). Parsing only: the write itself is
 * the memory_remember tool's execute() in src/tool-defs.ts - the CLI
 * must not reimplement the tool's semantics (store resolution, label
 * derivation, the dedup cross-check, the overwrite rules), so this
 * module's whole job is turning shell arguments and maybe stdin into
 * that tool's argument shape.
 */

/** The parsed input for one CLI memory write, in memory_remember's
 *  argument shape. confidence is pre-validated to the tool's 1-10. */
export interface RememberRequest {
  /** The text to save: positional words joined, or stdin read to EOF. */
  content: string;
  label?: string;
  store?: string;
  branch?: string;
  confidence?: number;
  overwrite?: boolean;
}

export type RememberParse =
  | { ok: true; request: RememberRequest }
  | { ok: false; error: string };

/** Flags that take a value; both `--flag value` and `--flag=value` parse. */
const VALUE_FLAGS = ["--store", "--branch", "--confidence", "--label"];

/**
 * Parses `thatch remember` arguments. Content comes from the positional
 * words (joined with spaces, so multi-word prose needs no quoting); when
 * there are none, it is read to EOF from stdin (null here means stdin is
 * a terminal - there is no pipe to read, so an empty content error tells
 * the caller both input shapes). A bare `--` puts every later token in
 * the content, so text that starts with `--` is still saveable. Unknown
 * flags and bad values return errors instead of throwing: bin/thatch
 * maps them to the standard console.error + exit 1 dispatch.
 */
export async function parseRememberInput(
  rest: string[],
  stdin: Readable | null,
): Promise<RememberParse> {
  const values = new Map<string, string>();
  let overwrite = false;
  const words: string[] = [];
  let afterDashDash = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (afterDashDash) {
      words.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    const eqFlag = VALUE_FLAGS.find((f) => arg.startsWith(`${f}=`));
    if (eqFlag) {
      values.set(eqFlag, arg.slice(eqFlag.length + 1));
      continue;
    }
    if (VALUE_FLAGS.includes(arg)) {
      const value = rest[++i];
      // The sibling-flag rule (the --stale precedent): a token starting
      // with `--` is a flag, not this flag's value.
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `${arg} expects a value` };
      }
      values.set(arg, value);
      continue;
    }
    if (arg === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (arg.startsWith("--")) {
      return {
        ok: false,
        error: `unknown flag "${arg}" (supported: --store, --branch, --confidence, --label, --overwrite; put -- before the content to save text that starts with --)`,
      };
    }
    words.push(arg);
  }

  let confidence: number | undefined;
  const rawConfidence = values.get("--confidence");
  if (rawConfidence !== undefined) {
    if (!/^\d+$/.test(rawConfidence)) {
      return { ok: false, error: `--confidence expects an integer 1-10, got "${rawConfidence}"` };
    }
    confidence = Number(rawConfidence);
    if (confidence < 1 || confidence > 10) {
      return { ok: false, error: `--confidence expects an integer 1-10, got ${confidence}` };
    }
  }

  let content = words.join(" ").trim();
  if (!content && stdin) {
    content = (await readAll(stdin)).trim();
  }
  if (!content) {
    return {
      ok: false,
      error: "no content provided - pass the text to remember as arguments, or pipe it on stdin: echo \"...\" | thatch remember",
    };
  }

  return {
    ok: true,
    request: {
      content,
      label: values.get("--label"),
      store: values.get("--store"),
      branch: values.get("--branch"),
      confidence,
      overwrite: overwrite || undefined,
    },
  };
}

/** Reads a stream to EOF as UTF-8 text. The caller owns destruction:
 *  a read to end fires "end" when the writer closes, which is the only
 *  exit this path has - there is no timeout, matching `thatch
 *  flush-tools`' unconditional stdin read. */
function readAll(readable: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (chunk: Buffer) => chunks.push(chunk));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString()));
    readable.on("error", reject);
  });
}
