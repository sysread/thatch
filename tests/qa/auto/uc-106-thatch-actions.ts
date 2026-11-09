import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

// The transformers mock the adapter's runtime needs (no model download in
// QA) is registered by the shared harness module below, at import time.
import { setup as setupV2 } from "../../../src/opencode/v2";
import { makeV2Harness } from "../../mocks/v2-harness";

/**
 * UC-106: Thatch actions (/thatch/defrag, extract, hygiene, peer-review,
 * refine, reflect, self-review, whois).
 *
 * Automatable: yes - verifies the user-visible artifacts and session-id
 * plumbing with no model tokens: the command files the plugin syncs, the
 * Claude Code command set, the MCP prompt parity, the review-mode command
 * bodies (pipeline couching + mode rules + host tool spelling), and the
 * omitted-session-id fallback on get_extraction_payload through the
 * plugin's own tools. The agent-facing quality of the instruction bodies
 * (does a model actually run a clean defrag?) needs a live session - not
 * covered here.
 */
const useCase: UseCase = {
  name: "UC-106-thatch-actions",
  preconditions: [
    "- The opencode plugin installed (src/index.ts default-export entry)",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Load the v2 adapter. Verify the action command files (defrag, extract, hygiene, peer-review, refine, reflect, self-review, whois) were synced into the fixture's config home, each carrying a description frontmatter and its instruction body - and that no wrap-up files install (they register in code).",
    "2. Verify the extract action instructs the model to learn the session ID from get_session_info and pass it explicitly to the sub-agent.",
    "3. Verify installClaudeCommands writes only the shared actions (defrag, hygiene, peer-review, refine, reflect, self-review), with any tool names in MCP spelling (defrag and peer-review name tools through the namer; hygiene, refine, and self-review name none).",
    "4. Verify host parity: opencode = claude set + extract/whois; MCP prompts = claude set.",
    "5. Verify the review-mode command files (peer-review, self-review) synced into both host installs with the mode overlay present, and the Claude rendering of peer-review spelling memory recall for MCP (the full body markers are pinned by tests/commands.test.ts).",
    "6. Buffer a tool interaction for a session via the tool execute.after hook, then call thatch_get_extraction_payload with the session_id omitted and a host context carrying that session ID. Verify the queued payload comes back.",
    "7. Call the same tool with no session_id and no host context (the MCP-host shape). Verify the error names the parent-session rule.",
  ].join("\n"),
  expected: [
    "- The plugin syncs every action command file (defrag, extract, hygiene, peer-review, refine, reflect, self-review, whois); the wrap-ups (compact, exit) never install as files.",
    "- The nudge-backed action bodies are rendered from the prompt cores; the extract action carries the session-id rule.",
    "- Claude Code gets the shared actions (defrag, hygiene, peer-review, refine, reflect, self-review); MCP prompts match Claude Code's set one-to-one.",
    "- The review-mode command files sync with the mode overlay present; the Claude rendering spells memory recall for MCP (mcp__thatch__memory_recall), never the opencode spelling.",
    "- An omitted session_id resolves to the invoking session on the opencode path and errors with the pass-the-parent-id rule when no session context exists.",
  ].join("\n"),

  async run(ctx: QaContext) {
    // The adapter reads env at init (same pattern as UC-103): THATCH_DB_PATH
    // for the store, XDG_CONFIG_HOME for the skill + command installs.
    // Redirect both into the fixture for the init window so the run never
    // touches the real user config, and restore immediately (other UCs
    // share this process).
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDb = process.env.THATCH_DB_PATH;
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
    const harness = makeV2Harness(ctx.dir, { childID: "qa-106-child" });
    let dispose: (() => Promise<void>) | undefined;
    try {
      dispose = (await setupV2(harness.context as any)) as () => Promise<void>;
    } finally {
      process.env.XDG_CONFIG_HOME = prevXdg;
      process.env.THATCH_DB_PATH = prevDb;
    }
    try {
      // Step 1: action command files synced at adapter load; no wrap-ups.
      const dir = join(ctx.env.XDG_CONFIG_HOME, "opencode", "command", "thatch");
      for (const name of ["defrag", "extract", "hygiene", "peer-review", "bug-intake", "refine", "reflect", "self-review", "whois"]) {
        if (!existsSync(join(dir, `${name}.md`))) {
          console.log(`  FAIL: ${name}.md not installed into the fixture config home`);
          return "FAIL";
        }
      }
      if (existsSync(join(dir, "compact.md")) || existsSync(join(dir, "exit.md"))) {
        console.log("  FAIL: wrap-up files must not install (they register in code)");
        return "FAIL";
      }
      const defrag = readFileSync(join(dir, "defrag.md"), "utf8");
      if (!defrag.includes("description:") || !defrag.includes("$ARGUMENTS")) {
        console.log("  FAIL: defrag.md missing frontmatter or user-message section");
        return "FAIL";
      }

      // Step 2: extract action's session-id rule.
      const extract = readFileSync(join(dir, "extract.md"), "utf8");
      if (!extract.includes("thatch_get_session_info") || !extract.includes("SESSION_ID")) {
        console.log("  FAIL: extract.md does not teach the get_session_info flow");
        return "FAIL";
      }

      // Step 3: Claude Code command set.
      const { installClaudeCommands, claudeCommandDefs } = await import("../../../src/commands");
      const claudeDir = join(ctx.dir, ".claude-fixture");
      const written = installClaudeCommands(claudeDir);
      const names = claudeCommandDefs().map((d) => d.name).sort();
      if (names.join(",") !== "bug-intake,defrag,hygiene,peer-review,refine,reflect,self-review" || written.length !== 7) {
        console.log(`  FAIL: claude command set should be bug-intake/defrag/hygiene/peer-review/refine/reflect/self-review, got ${names.join(",")}`);
        return "FAIL";
      }
      const claudeDefrag = readFileSync(join(claudeDir, "commands", "thatch", "defrag.md"), "utf8");
      if (!claudeDefrag.includes("mcp__thatch__find_duplicates") || claudeDefrag.includes("thatch_find_duplicates")) {
        console.log("  FAIL: claude defrag.md does not use MCP tool spellings");
        return "FAIL";
      }

      // Step 4: host parity (opencode superset, MCP prompts == claude set).
      const { opencodeCommandDefs } = await import("../../../src/commands");
      const { compilePrompts } = await import("../../../src/mcp");
      const opencodeNames = opencodeCommandDefs().map((d) => d.name).sort();
      const promptNames = [...compilePrompts().keys()].sort();
      const expectedOpen = [...names, "extract", "whois"].sort();
      if (opencodeNames.join(",") !== expectedOpen.join(",") || promptNames.join(",") !== names.join(",")) {
        console.log(`  FAIL: command set parity broken (opencode=${opencodeNames.join(",")} prompts=${promptNames.join(",")})`);
        return "FAIL";
      }

      // Step 5: the review-mode command files sync with the mode overlay.
      // The full body markers (pipeline couching, per-mode rules, target
      // sources) are pinned by tests/commands.test.ts; this step verifies
      // the end-to-end surface the unit test cannot: the files land in both
      // host installs with the overlay present and host-correct tool
      // spelling.
      for (const name of ["peer-review", "self-review"]) {
        const body = readFileSync(join(dir, `${name}.md`), "utf8");
        if (!body.includes("mode rules")) {
          console.log(`  FAIL: ${name}.md synced without the mode overlay`);
          return "FAIL";
        }
      }
      const claudePeerBody = readFileSync(join(claudeDir, "commands", "thatch", "peer-review.md"), "utf8");
      if (!claudePeerBody.includes("mcp__thatch__memory_recall") || claudePeerBody.includes("thatch_memory_recall")) {
        console.log("  FAIL: claude peer-review.md does not use the MCP tool spelling for memory recall");
        return "FAIL";
      }

      // Step 6: omitted session_id resolves through the plugin's own tools.
      // The adapter's registered execute returns a v2 Tool.Result
      // ({ content }) - the string lives in .content.
      const ses = "ses-qa-106";
      await harness.toolAfter({
        tool: "read",
        sessionID: ses,
        args: { filePath: "/tmp/qa-106.txt" },
        status: "completed",
        result: { content: "qa fixture content" },
      });
      const fetched = (await harness.addedTools
        .find((t) => t.name === "thatch_get_extraction_payload")!
        .execute({}, { sessionID: ses, agent: "build" })) as { content?: unknown };
      const fetchedText = typeof fetched === "string" ? fetched : String(fetched?.content ?? "");
      if (!fetchedText.includes("qa fixture content")) {
        console.log(`  FAIL: omitted session_id should fetch the invoking session's queue, got: ${fetchedText.slice(0, 120)}`);
        return "FAIL";
      }

      // Step 7: no session_id and no host context -> the parent-id rule.
      const noHost = (await harness.addedTools
        .find((t) => t.name === "thatch_get_extraction_payload")!
        .execute({}, undefined)) as { content?: unknown };
      const noHostText = typeof noHost === "string" ? noHost : String(noHost?.content ?? "");
      if (!noHostText.includes("session_id is required") || !noHostText.includes("parent")) {
        console.log(`  FAIL: MCP-shape call should error with the parent-id rule, got: ${noHostText.slice(0, 120)}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      await dispose?.();
    }
  },
};

registerUseCase(useCase);
