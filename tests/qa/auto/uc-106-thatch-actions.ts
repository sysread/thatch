import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-106: Thatch actions (/thatch/defrag, extract, hygiene, reflect).
 *
 * Automatable: yes - verifies the user-visible artifacts and session-id
 * plumbing with no model tokens: the command files the plugin syncs, the
 * Claude Code command set, the MCP prompt parity, and the omitted-session-id
 * fallback on get_extraction_payload through the plugin's own tools. The
 * agent-facing quality of the instruction bodies (does a model actually run
 * a clean defrag?) needs a live session - not covered here.
 */
const useCase: UseCase = {
  name: "UC-106-thatch-actions",
  preconditions: [
    "- The opencode plugin installed (src/index.ts dual-shape entry export)",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Load the plugin server. Verify the action command files (defrag, extract, hygiene, reflect) were synced next to the wrap-up files, each carrying a description frontmatter and its prompt-core body.",
    "2. Verify the extract action instructs the model to learn the session ID from get_session_info and pass it explicitly to the sub-agent.",
    "3. Verify installClaudeCommands writes only defrag/hygiene/reflect, spelled with mcp__thatch__ tool names.",
    "4. Verify host parity: opencode = claude set + compact/exit/extract; MCP prompts = claude set.",
    "5. Buffer a tool interaction for a session via tool.execute.after, then call thatch_get_extraction_payload with the session_id omitted and a host context carrying that session ID. Verify the queued payload comes back.",
    "6. Call the same tool with no session_id and no host context (the MCP-host shape). Verify the error names the parent-session rule.",
  ].join("\n"),
  expected: [
    "- The plugin syncs six command files: wrap-ups (compact, exit) plus the four actions.",
    "- Action bodies are rendered from the prompt cores; the extract action carries the session-id rule.",
    "- Claude Code gets the three shared actions; MCP prompts match Claude Code's set one-to-one.",
    "- An omitted session_id resolves to the invoking session on the opencode path and errors with the pass-the-parent-id rule when no session context exists.",
  ].join("\n"),

  async run(ctx: QaContext) {
    // server() reads env at init (same pattern as UC-103).
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevDb = process.env.THATCH_DB_PATH;
    process.env.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
    process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
    const { server } = await import("../../../src/index");
    let hooks: Awaited<ReturnType<typeof server>>;
    try {
      hooks = await server({ client: {
        session: {
          prompt: async () => {},
          promptAsync: async () => {},
          create: async () => ({ data: { id: "qa-106-child" } }),
          delete: async () => {},
          get: async () => ({ data: { title: "QA actions session" } }),
          status: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
        },
        tui: { showToast: async () => {}, executeCommand: async () => ({ data: true }), publish: async () => ({ data: true }) },
      }, worktree: ctx.dir } as any);
    } finally {
      process.env.XDG_CONFIG_HOME = prevXdg;
      process.env.THATCH_DB_PATH = prevDb;
    }
    try {
      // Step 1: action command files synced at plugin load.
      const dir = join(ctx.env.XDG_CONFIG_HOME, "opencode", "command", "thatch");
      for (const name of ["compact", "exit", "defrag", "extract", "hygiene", "reflect"]) {
        if (!existsSync(join(dir, `${name}.md`))) {
          console.log(`  FAIL: ${name}.md not installed into the fixture config home`);
          return "FAIL";
        }
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
      if (names.join(",") !== "defrag,hygiene,reflect" || written.length !== 3) {
        console.log(`  FAIL: claude command set should be defrag/hygiene/reflect, got ${names.join(",")}`);
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
      const expectedOpen = [...names, "compact", "exit", "extract"].sort();
      if (opencodeNames.join(",") !== expectedOpen.join(",") || promptNames.join(",") !== names.join(",")) {
        console.log(`  FAIL: command set parity broken (opencode=${opencodeNames.join(",")} prompts=${promptNames.join(",")})`);
        return "FAIL";
      }

      // Step 5: omitted session_id resolves through the plugin's own tools.
      const ses = "ses-qa-106";
      await hooks["tool.execute.after"]!({
        tool: "read",
        sessionID: ses,
        callID: "qa-106-call",
        args: { filePath: "/tmp/qa-106.txt" },
      }, { output: "qa fixture content" } as any);
      const fetched = await hooks.tool!.thatch_get_extraction_payload.execute({}, {
        sessionID: ses,
        agent: "build",
      } as any);
      if (typeof fetched !== "string" || !fetched.includes("qa fixture content")) {
        console.log(`  FAIL: omitted session_id should fetch the invoking session's queue, got: ${String(fetched).slice(0, 120)}`);
        return "FAIL";
      }

      // Step 6: no session_id and no host context -> the parent-id rule.
      const noHost = await hooks.tool!.thatch_get_extraction_payload.execute({}, {} as any);
      if (typeof noHost !== "string" || !noHost.includes("session_id is required") || !noHost.includes("parent")) {
        console.log(`  FAIL: MCP-shape call should error with the parent-id rule, got: ${String(noHost).slice(0, 120)}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      hooks.dispose?.();
    }
  },
};

registerUseCase(useCase);
