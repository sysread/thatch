import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-127: Bug-intake command + skill pair (/thatch/bug-intake, the
 * thatch-bug-intake skill).
 *
 * Automatable: yes - verifies the shipped pair is wired correctly with no
 * model tokens: the skill is registered and parses, the command renders for
 * opencode and Claude Code with host-correct tool spellings, the MCP prompt
 * parity holds, and the command body couches the skill and carries the route
 * decision (ticket vs fix). The agent-facing quality of the coordination
 * (does a model actually run a clean intake?) needs a live session - not
 * covered here.
 */
const useCase: UseCase = {
  name: "UC-127-bug-intake-command",
  preconditions: [
    "- The repo checked out with artifacts/skills/ and src/ present",
    "- No external services required",
  ].join("\n"),
  steps: [
    "1. Verify the thatch-bug-intake skill artifact exists, its frontmatter has name and description, and it carries the coordinator procedure (registration check, verify against source, route decision, close-out).",
    "2. Verify SHARED_SKILLS registers the skill (it ships to every host).",
    "3. Verify the bug-intake action renders as an opencode command file with the user-message section ($ARGUMENTS) and couches the skill.",
    "4. Verify the Claude Code command set includes bug-intake with MCP tool spellings (mcp__thatch__), never the opencode spelling.",
    "5. Verify host parity: MCP prompts include bug-intake (same set as Claude Code).",
    "6. Verify the route rules are present in the rendered command: ticket route (file an issue, thatch-ticket-description format) and fix route (worktree/subordinate), plus the user-instruction precedence line.",
  ].join("\n"),
  expected: [
    "- The skill installs to every host and its frontmatter parses.",
    "- /thatch/bug-intake exists on opencode and Claude Code, and as an MCP prompt on Cursor.",
    "- The command body applies the user message to the matching step, names the ticket route (filed issue, thatch-ticket-description format) and the fix route, and defaults to routing by the project's convention.",
  ].join("\n"),
  run: async (_ctx: QaContext): Promise<"PASS" | "FAIL"> => {
    const fail = (detail: string): "FAIL" => {
      console.log(`  FAIL: ${detail}`);
      return "FAIL";
    };

    // Step 1: skill artifact exists with clean frontmatter and the procedure.
    // The artifact lives in the real repo, not the fixture sandbox: resolve
    // it relative to this file (tests/qa/auto/ is three levels below root).
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const artifactPath = join(repoRoot, "artifacts", "skills", "thatch-bug-intake.md");
    if (!readFileSync(artifactPath, "utf8").match(/^---\nname: thatch-bug-intake\ndescription: '/)) {
      return fail("skill artifact frontmatter missing or description not single-quoted");
    }
    const artifact = readFileSync(artifactPath, "utf8");
    for (const marker of [
      "thatch_chat_status",
      "CONFIRMED, REFUTED, or PARTIAL",
      "thatch-ticket-description",
      "Close out",
    ]) {
      if (!artifact.includes(marker)) {
        return fail(`skill artifact missing coordinator content: ${marker}`);
      }
    }

    // Step 2: registered in SHARED_SKILLS (ships to every host).
    const { SHARED_SKILLS } = await import("../../../src/skills");
    const skill = SHARED_SKILLS.find((s) => s.name === "thatch-bug-intake");
    if (!skill) {
      return fail("thatch-bug-intake not registered in SHARED_SKILLS");
    }
    if (!skill.content.includes("Bug intake coordination")) {
      return fail("registered skill content does not match the artifact body");
    }

    // Step 3: opencode command rendering carries the user-message section
    // ($ARGUMENTS) and couches the skill.
    const { opencodeCommandDefs, claudeCommandDefs } = await import("../../../src/commands");
    const opencode = opencodeCommandDefs().find((d) => d.name === "bug-intake");
    if (!opencode) {
      return fail("bug-intake missing from the opencode command set");
    }
    if (!opencode.content.includes("$ARGUMENTS")) {
      return fail("bug-intake command lacks the user-message ($ARGUMENTS) section");
    }
    if (!opencode.content.includes("thatch-bug-intake")) {
      return fail("bug-intake command does not couch the thatch-bug-intake skill");
    }

    // Step 4: Claude Code set carries it with MCP tool spellings only.
    const claude = claudeCommandDefs().find((d) => d.name === "bug-intake");
    if (!claude) {
      return fail("bug-intake missing from the Claude Code command set");
    }
    if (!claude.content.includes("mcp__thatch__chat_status")) {
      return fail("bug-intake Claude rendering does not spell chat tools for MCP");
    }
    if (/[^_a-z]thatch_chat_status/.test(claude.content)) {
      return fail("bug-intake Claude rendering leaks the opencode tool spelling");
    }

    // Step 5: MCP prompt parity (Cursor gets it as a prompt).
    const { compilePrompts } = await import("../../../src/mcp");
    if (![...compilePrompts().keys()].includes("bug-intake")) {
      return fail("bug-intake missing from the MCP prompt surface");
    }

    // Step 6: the route rules survive rendering.
    for (const marker of [
      "file an issue",
      "thatch-ticket-description",
      "user instructions win over the skill's defaults",
    ]) {
      if (!claude.content.includes(marker)) {
        return fail(`bug-intake command missing route rule: ${marker}`);
      }
    }

    return "PASS";
  },
};

registerUseCase(useCase);
