---
name: thatch-qa-write
description: Write or update QA use-case test files for the thatch project. Use when adding a new use case after a feature ships, or when converting a live-session use case to automatable.
---

# Writing Thatch QA Use Cases

You are writing a QA use-case test file for the thatch project. Each use
case verifies end-to-end behavior through the CLI, module APIs, or a live
opencode session.

## Where to put it

- `tests/qa/auto/uc-NNN-name.test.ts` — if the scenario can be verified
  without a live LLM. No model tokens, runs in seconds.
- `tests/qa/live/uc-NNN-name.test.ts` — if the scenario needs a live agent
  to read a prompt, make tool calls, and respond. Costs tokens, up to 10
  min each.
- Set `manualOnly: true` if it cannot be automated at all (visual TUI,
  compaction, real Claude Code/Cursor sessions).

When in doubt, start with `auto/`. You can always move it to `live/` later.

## File template

```typescript
import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-NNN: <one-line description>.
 *
 * <"Automatable: yes — ..." note if applicable, or
 *  "Requires a live opencode session.">
 */

const useCase: UseCase = {
  name: "UC-NNN-name",
  preconditions: [
    "- State of the system before the test",
  ].join("\n"),
  steps: [
    "1. Action",
    "2. Action",
  ].join("\n"),
  expected: [
    "- Observable outcome",
  ].join("\n"),
  // No custom run — uses default runViaOpencode.
};

registerUseCase(useCase);
```

## Automatable use cases

Add a `run(ctx: QaContext)` function. The context provides:

- `ctx.dir` — isolated repo copy path
- `ctx.env` — env vars (THATCH_DB_PATH, XDG_CONFIG_HOME, HOME,
  CLAUDE_CONFIG_DIR, etc.)
- `ctx.repoRoot` — real repo path (read-only)

### CLI-based pattern

```typescript
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

const useCase: UseCase = {
  name: "UC-NNN-name",
  preconditions: "...",
  steps: "...",
  expected: "...",

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = ctx.env;

    const result = await $`${bin} stores`.env(env).quiet().nothrow();
    if (result.exitCode !== 0) {
      console.log("  FAIL: `thatch stores` exited non-zero");
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
```

### Module-based pattern

For use cases that test internal modules directly:

```typescript
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { ThatchDB } from "../../src/db";
import { MockEmbeddingModel } from "../../src/embeddings";

const useCase: UseCase = {
  name: "UC-NNN-name",
  preconditions: "...",
  steps: "...",
  expected: "...",

  async run(ctx: QaContext) {
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    const model = new MockEmbeddingModel();

    // Exercise the module, check assertions.

    db.close();
    return "PASS";
  },
};

registerUseCase(useCase);
```

## Gotchas

- **Non-thatch hook names in setup tests:** the `replaceThatchHooks` function
  filters by `command.includes("thatch")`. If you inject a test hook, its
  command must NOT contain the substring "thatch" or it will be filtered out.
  Use a name like `"echo external-hook"`, not `"echo non-thatch-hook"`.
- **Import paths from `auto/` or `live/`:** use `../runner` for the runner
  library, `../../src/<module>` for source modules.
- **The name field must match the filename** without the `.test.ts`
  extension (e.g., `"UC-004-cli-inspection"`).
- **Join string arrays with `\n`** so preconditions, steps, and expected
  become multi-line strings.
- **Return a result:** `"PASS"`, `"FAIL"`, or `"PARTIAL"`. Print evidence
  with `console.log` on failure so it shows in the test output.

## After writing

Run `mise run check` to verify the regular suite still passes (the QA
suite is excluded from the regular check via a flat glob). Then run
`mise run qa-dry-run` to verify the new use case is discovered.
