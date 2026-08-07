import { $ } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-015: Environment variable override matrix.
 *
 * Automatable: yes — env resolution is deterministic and side-effect-free.
 * Verifies each override via CLI calls and file existence checks. Four vars
 * (THATCH_DB_PATH, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, THATCH_QUEUE_DIR) have
 * observable side effects through the CLI. THATCH_RECALL_THRESHOLD and
 * THATCH_MODEL are smoke-tested (the CLI reads THATCH_RECALL_THRESHOLD in
 * flush-tools; THATCH_MODEL is only used by the plugin and MCP server, not
 * bin/thatch).
 */

const useCase: UseCase = {
  name: "UC-015-env-override-matrix",
  preconditions: [
    "- Writable temp directories; `bun` on PATH",
  ].join("\n"),
  steps: [
    "Set each variable and confirm the effect at the documented resolution point.",
    "",
    "| Variable | Set to | Expected effect |",
    "|----------|--------|------------------|",
    "| `THATCH_DB_PATH` | a temp file path | the SQLite DB is created there (CLI + plugin + MCP) |",
    "| `XDG_CONFIG_HOME` | a temp dir | the default DB (`$XDG_CONFIG_HOME/thatch/thatch.db`) and opencode skill dir move there; the real `~/.config` is untouched |",
    "| `CLAUDE_CONFIG_DIR` | a temp dir | `thatch setup --claude --global` writes CLAUDE.md, settings.json, and skills under that dir; project-local keeps project paths but skills under the custom dir |",
    "| `THATCH_QUEUE_DIR` | a temp dir | extraction-queue JSONL files land there instead of `$XDG_CACHE_HOME/thatch/queue` |",
    "| `THATCH_RECALL_THRESHOLD` | a low value (e.g. `0.2`) | the prompt-aware recall nudge fires for weaker matches (a prompt that matched nothing at 0.55 now surfaces results) |",
    "| `THATCH_MODEL` | a different model name | new memories carry the new model tag and vector dimension; old memories become invisible to search (see UC-012) |",
  ].join("\n"),
  expected: [
    "- Each override takes effect at the point the docs describe (see",
    "  `docs/dev/setup-and-hooks.md` and the dev README config section). None require",
    "  a restart beyond the process that reads them.",
    "- `THATCH_DB_PATH` and `XDG_CONFIG_HOME` change the **same** sideband socket",
    "  path (it is a hash of the resolved DB path) — so a hook process and the MCP",
    "  server must both resolve the same DB path or they miss each other.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const failures: string[] = [];

    // THATCH_DB_PATH: the SQLite DB is created at the custom path.
    {
      const customDb = join(ctx.dir, "custom-db.db");
      const env = { ...ctx.env, THATCH_DB_PATH: customDb };
      await $`${bin} stores`.env(env).quiet().nothrow();
      if (!existsSync(customDb)) {
        failures.push("THATCH_DB_PATH: DB not created at custom path");
      }
    }

    // XDG_CONFIG_HOME: when THATCH_DB_PATH is unset, the default DB lives
    // under $XDG_CONFIG_HOME/thatch/thatch.db. SQLite does not create parent
    // dirs, so we pre-create the thatch subdir.
    {
      const customXdg = join(ctx.dir, "custom-xdg");
      mkdirSync(join(customXdg, "thatch"), { recursive: true });
      const { THATCH_DB_PATH: _omit, ...envRest } = ctx.env;
      const env = { ...envRest, XDG_CONFIG_HOME: customXdg };
      await $`${bin} stores`.env(env).quiet().nothrow();
      const expectedDb = join(customXdg, "thatch", "thatch.db");
      if (!existsSync(expectedDb)) {
        failures.push("XDG_CONFIG_HOME: default DB not created under custom XDG");
      }
    }

    // CLAUDE_CONFIG_DIR: setup --claude --global writes CLAUDE.md and
    // settings.json under the custom config dir.
    {
      const customConfig = join(ctx.dir, "custom-claude-config");
      const env = {
        ...ctx.env,
        CLAUDE_CONFIG_DIR: customConfig,
        CLAUDE_PROJECT_DIR: ctx.dir,
      };
      await $`${bin} setup --claude --global`.env(env).quiet().nothrow();
      const claudeMd = join(customConfig, "CLAUDE.md");
      const settingsJson = join(customConfig, "settings.json");
      if (!existsSync(claudeMd)) {
        failures.push("CLAUDE_CONFIG_DIR: CLAUDE.md not written under custom config dir");
      }
      if (!existsSync(settingsJson)) {
        failures.push("CLAUDE_CONFIG_DIR: settings.json not written under custom config dir");
      }
    }

    // THATCH_QUEUE_DIR: buffer-batch writes a JSONL queue file to the custom
    // queue dir. We pipe a PostToolBatch-shaped payload via cat to stdin.
    {
      const customQueue = join(ctx.dir, "custom-queue");
      const env = { ...ctx.env, THATCH_QUEUE_DIR: customQueue };
      const payload = JSON.stringify({
        session_id: "uc015-queue-test",
        tool_calls: [{
          tool_name: "read",
          tool_input: { filePath: "/tmp/test" },
          tool_response: "ok",
        }],
      });
      const payloadFile = join(ctx.dir, "batch-payload.json");
      writeFileSync(payloadFile, payload);
      await $`cat ${payloadFile} | ${bin} buffer-batch`.env(env).quiet().nothrow();
      const queueFile = join(customQueue, "uc015-queue-test.jsonl");
      if (!existsSync(queueFile)) {
        failures.push("THATCH_QUEUE_DIR: queue file not created at custom dir");
      }
    }

    // THATCH_RECALL_THRESHOLD: flush-tools reads this env var at runtime
    // (bin/thatch line 380). Without a running sideband the recall tier
    // fails gracefully and the write nudge prints. We verify the command
    // exits 0 and produces output, confirming the var is parsed without
    // crashing.
    {
      const env = { ...ctx.env, THATCH_RECALL_THRESHOLD: "0.2" };
      const promptPayload = JSON.stringify({
        session_id: "uc015-threshold-test",
        prompt: "This is a test prompt for the recall threshold verification.",
      });
      const promptFile = join(ctx.dir, "prompt-payload.json");
      writeFileSync(promptFile, promptPayload);
      const result = await $`cat ${promptFile} | ${bin} flush-tools`.env(env).quiet().nothrow();
      if (result.exitCode !== 0) {
        failures.push("THATCH_RECALL_THRESHOLD: flush-tools exited non-zero");
      }
      if (result.stdout.toString().length === 0) {
        failures.push("THATCH_RECALL_THRESHOLD: flush-tools produced no output");
      }
    }

    // THATCH_MODEL: not read by bin/thatch (it uses BgeEmbeddingModel
    // directly). THATCH_MODEL is consumed by the plugin (src/index.ts:46)
    // and MCP server (src/mcp.ts:97). We verify the CLI still works when
    // it is set, confirming it does not interfere with CLI operations.
    {
      const env = { ...ctx.env, THATCH_MODEL: "mock-model" };
      const result = await $`${bin} stores`.env(env).quiet().nothrow();
      if (result.exitCode !== 0) {
        failures.push("THATCH_MODEL: `thatch stores` exited non-zero with THATCH_MODEL set");
      }
    }

    if (failures.length > 0) {
      for (const f of failures) {
        console.log(`  FAIL: ${f}`);
      }
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
