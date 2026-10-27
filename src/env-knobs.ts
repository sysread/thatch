// The registry of THATCH_* environment knobs. thatch's persistent config is
// the JSON file the config_get / config_set tools manage, but a second layer
// of tuning lives in environment variables read at process startup (some are
// read at call time; the config_get output is call-time either way). This
// module is the single source of truth for what those knobs are and what
// they do: config_get's "environment" section renders it, and the docs point
// here instead of restating the list. Values are read from process.env at
// call time, so the output reflects the running process's environment.
// KNOWN GAP: the drift test enforces the knob NAMES in both directions, not
// the default strings - a code-side default change does not fail the gate;
// update this registry in the same commit as the constant.

/** One THATCH_* environment knob. */
export interface EnvKnob {
  /** The environment variable name, verbatim. */
  name: string;
  /** What the knob does, in one sentence. */
  description: string;
  /** Human-readable default applied when the variable is unset. */
  default: string;
}

/**
 * Every THATCH_* knob that exists in code, in presentation order. Protocol
 * markers (THATCH_MARKER, THATCH_BEGIN, THATCH_END, THATCH_BEGIN_MARKER,
 * THATCH_END_MARKER) are not knobs
 * and are deliberately absent; the drift test's exclusion set must match
 * this list.
 */
export const ENV_KNOBS: EnvKnob[] = [
  {
    name: "THATCH_DB_PATH",
    description: "SQLite database location; the config file lives beside it.",
    default: "~/.config/thatch/thatch.db",
  },
  {
    name: "THATCH_DEBUG",
    description:
      "Diagnostic log filter: 1, all, or * logs every tag; otherwise a comma-separated list of feature:aspect tag filters.",
    default: "off",
  },
  {
    name: "THATCH_MODEL",
    description:
      "Embedding model id used by the plugin and MCP server for similarity scoring (the CLI always uses the default).",
    default: "Xenova/bge-small-en-v1.5",
  },
  {
    name: "THATCH_MODEL_CACHE",
    description: "Directory for the downloaded embedding model.",
    default: "<platform cache dir>/thatch/models",
  },
  {
    name: "THATCH_EMBEDDING_BACKEND",
    description: "Embedding runtime: native or wasm.",
    default: "wasm",
  },
  {
    name: "THATCH_QUEUE_DIR",
    description: "Directory where pending extraction interactions are queued.",
    default: "~/.cache/thatch/queue",
  },
  {
    name: "THATCH_RECALL_THRESHOLD",
    description: "Cosine similarity above which a memory is surfaced in the recall nudge.",
    default: "0.55",
  },
  {
    name: "THATCH_PREDICTION_THRESHOLD",
    description: "Cosine similarity above which a prediction auto-fires.",
    default: "0.60",
  },
  {
    name: "THATCH_BEHAVIOR_THRESHOLD",
    description: "Cosine similarity above which a behavior auto-fires.",
    default: "0.60",
  },
  {
    name: "THATCH_CHAT_SPLIT_PART_LEN",
    description: "Chat message bodies longer than this many characters are split into several parts (clamped to 500..9000).",
    default: "2000",
  },
  {
    name: "THATCH_CHAT_MAX_BODY_CHARS",
    description: "Chat message body acceptance ceiling in characters; larger bodies are refused (clamped to 1000..1000000).",
    default: "20000",
  },
  {
    name: "THATCH_CHAT_REHOST_GRACE_MINUTES",
    description:
      "Minutes a restarted daemon re-hosts the previous daemon's silent chat sessions; 0 means the 24-hour default.",
    default: "1440 (24 hours)",
  },
  {
    name: "THATCH_CHILD_RECONCILE_MS",
    description: "How often the runtime reconciles background extraction child sessions, in milliseconds.",
    default: "10000",
  },
  {
    name: "THATCH_STRAND_SWEEP",
    description: "Strand-sweep kill switch: 0, false, or off disables the sweep of stranded sessions.",
    default: "on",
  },
  {
    name: "THATCH_STRAND_SWEEP_MS",
    description: "Milliseconds between strand sweeps of opencode's session store.",
    default: "6 hours (21600000)",
  },
  {
    name: "THATCH_RUNTIME_STATE_TTL_MS",
    description: "Milliseconds a runtime state row (extraction claims and the like) stays fresh.",
    default: "7 days (604800000)",
  },
  {
    name: "THATCH_WATCH_COMMAND_TIMEOUT_SECONDS",
    description: "Per-run kill timeout for watched shell commands, in seconds.",
    default: "30",
  },
  {
    name: "THATCH_WATCH_DEATH_MINUTES",
    description: "Pending age in minutes after which a watched check is presumed dead and re-armed.",
    default: "120",
  },
  {
    name: "THATCH_WATCH_POLL_SECONDS",
    description: "Watch poll interval, in seconds.",
    default: "60",
  },
  {
    name: "THATCH_WATCH_TTL_MINUTES",
    description: "Minutes a watch stays armed before expiring.",
    default: "480",
  },
  {
    name: "THATCH_WATCH_MAX_PER_SESSION",
    description: "Maximum armed watches per session.",
    default: "5",
  },
  {
    name: "THATCH_PROJECT_DIR",
    description:
      "Project directory pin written into MCP configs by setup; resolves the project (and its database) instead of trusting the working directory.",
    default: "host project dir or cwd",
  },
  {
    name: "THATCH_OPENCODE_STATE_ROOT",
    description: "Overrides the opencode state root used to tell whether an opencode tab is still open (test and QA override).",
    default: "~/.local/state/opencode",
  },
];

/**
 * One knob's effective value in this process: the raw environment value, or
 * <unset> when the variable is not set.
 */
export function envKnobValue(name: string, env: Record<string, string | undefined> = process.env): string {
  return env[name] ?? "<unset>";
}

/** Renders the environment section: one line per knob, values from `env`. */
export function renderEnvKnobs(env: Record<string, string | undefined> = process.env): string {
  const lines = ["environment:"];
  for (const knob of ENV_KNOBS) {
    lines.push(`  ${knob.name}: ${envKnobValue(knob.name, env)} (default: ${knob.default}) - ${knob.description}`);
  }
  return lines.join("\n");
}
