import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-087: Review no subagents.
 *
 * Live session: requires an agent to check skill directories. The
 * coordinator is not available on Claude Code or Cursor because it
 * requires sub-agent support.
 */

const useCase: UseCase = {
  name: "UC-087-review-no-subagents",
  preconditions: [
    "- A Claude Code or Cursor environment (no sub-agent support)",
    "- The MCP host skill directories (~/.claude/skills/, ~/.cursor/skills/)",
    "- The thatch plugin installed via thatch setup --claude or --cursor",
  ].join("\n"),
  steps: [
    "1. Run thatch setup --claude (or --cursor) to install skills.",
    "2. Inspect ~/.claude/skills/ (or ~/.cursor/skills/).",
    "3. Verify the thatch-code-review coordinator skill is NOT present.",
    "4. Verify specialist skills (e.g., thatch-review-pedantic, thatch-review-state-flow) ARE present.",
    "5. Verify the thatch-review-synthesizer skill IS present.",
    "6. Attempt to load the coordinator skill — confirm it is not available.",
    "7. Load a specialist skill directly — confirm it works.",
  ].join("\n"),
  expected: [
    "- The coordinator skill (thatch-code-review) is not installed in MCP host skill directories.",
    "- Specialist skills are installed and loadable.",
    "- The synthesizer is installed and loadable for manual aggregation.",
    "- MCP hosts can run the solo review path but not the coordinator path.",
  ].join("\n"),
  manualOnly: true,
};

registerUseCase(useCase);
