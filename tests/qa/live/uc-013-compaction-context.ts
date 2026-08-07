import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-013: Compaction context (opencode-only).
 *
 * Manual-only: requires a live opencode compaction event, which cannot be
 * reliably triggered in a short session. The hook's string content is
 * unit-tested in the regular suite; actual compaction injection is manual.
 */

const useCase: UseCase = {
  name: "UC-013-compaction-context",
  preconditions: [
    "- An opencode session that grows long enough to trigger context compaction",
    "- Several memories already stored in the repo's store",
  ].join("\n"),
  steps: [
    "1. Work in the session until opencode compacts the context window.",
    "2. Inspect the compaction output.",
    "3. After compaction, ask the agent something that should use a memory tool.",
  ].join("\n"),
  expected: [
    "- The compaction output includes the thatch re-familiarization context block",
    "  pushed by experimental.session.compacting.",
    "- After compaction, the agent still knows the memory tools exist and uses them.",
    "- This behavior is opencode-only. Claude Code's PostCompact hook is",
    "  side-effects only; Cursor has no equivalent hook.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
