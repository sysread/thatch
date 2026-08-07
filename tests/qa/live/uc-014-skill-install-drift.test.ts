import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-014: Skill install and drift recovery.
 *
 * Automatable: yes — file presence, count (21 vs 22), content-diff-overwrite,
 * and coordinator host-gating are all file assertions (`setup.test.ts` already
 * covers the unit contract). Requires a live opencode session for the
 * end-to-end runbook.
 */

const useCase: UseCase = {
  name: "UC-014-skill-install-drift",
  preconditions: [
    "- Thatch installed; the host's skills directory empty",
    "- `bun` on PATH",
  ].join("\n"),
  steps: [
    "1. `thatch setup --claude` (and/or start an opencode session, and/or",
    "   `thatch setup --cursor`).",
    "2. List the skills directory.",
    "3. Edit one `SKILL.md` file locally to introduce drift.",
    "4. Re-run `setup` (or restart opencode).",
    "5. Check whether the `thatch-code-review` coordinator skill is present.",
  ].join("\n"),
  expected: [
    "- Claude Code and Cursor install exactly **21 shared skills** to the skills",
    "  dir — the coordinator (`thatch-code-review`) is **absent** (it needs",
    "  sub-agents, which those hosts lack).",
    "- opencode installs **22** — the 21 shared plus the coordinator.",
    "- The locally edited `SKILL.md` is **overwritten** with the canonical content",
    "  on the next `setup`/init (drift detection: a file is only rewritten when its",
    "  content differs from the definition). Unrelated skill files are untouched.",
    "- Skills never land in the worktree — always under the user-scoped config dir",
    "  (`~/.claude/skills`, `~/.cursor/skills`, `$XDG_CONFIG_HOME/opencode/skills`).",
  ].join("\n"),
  // No custom run — uses default runViaOpencode.
};

registerUseCase(useCase);
