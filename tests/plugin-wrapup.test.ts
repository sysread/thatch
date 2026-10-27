// Wrap-up command resolution and command-file installation tests from
// plugin.test.ts: the /thatch/compact and /thatch/exit greenlight flow,
// installOpencodeCommands, and the action command sets.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  server,
  setupPluginHarness,
  teardownPluginHarness,
  tuiExecuteCommandCalls,
  tuiPublishCalls,
  tuiToastCalls,
} from "./mocks/plugin-harness";
import { ThatchDB } from "../src/db";

// The message list the mock session.messages returns; wrap-up tests point
// this at canned assistant responses to simulate the greenlight check.
let wrapUpMessages: any[] = [];
let hooks: Awaited<ReturnType<typeof server>>;

beforeAll(async () => {
  hooks = await setupPluginHarness({ getWrapUpMessages: () => wrapUpMessages });
});

afterAll(() => {
  teardownPluginHarness();
});

describe("wrap-up commands (/thatch/compact, /thatch/exit)", () => {
  // Drives the full flow: the command marks the session, the model's
  // response lands as the last assistant message, and the idle event
  // resolves the pending wrap-up.
  const runWrapUp = async (command: string, sessionID: string, lastAssistantText: string) => {
    wrapUpMessages = [
      { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
      {
        info: { id: "msg_u2", role: "assistant" },
        parts: [{ type: "text", text: lastAssistantText }],
      },
    ];
    await hooks["command.execute.before"]!({ command, sessionID, arguments: "" }, { parts: [] });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } } } as any,
    });
  };

  test("compact greenlight triggers the TUI compact action", async () => {
    const before = tuiExecuteCommandCalls.length;
    await runWrapUp("thatch/compact", "ses_wrapc", "All clear.\nTHATCH_COMPACT_READY");
    expect(tuiExecuteCommandCalls.slice(before)).toEqual([
      { body: { command: "session_compact" } },
    ]);
    expect(tuiPublishCalls).toHaveLength(0);
  });

  // The exit flow under the tool protocol: the command arms the exit, the
  // model greenlights with the zero-arg thatch_exit tool call, and the
  // session's next idle runs the close. The tool resolves the session from
  // the per-call host context.
  const armExit = (sessionID: string) =>
    hooks["command.execute.before"]!({ command: "thatch/exit", sessionID, arguments: "" }, { parts: [] });
  const callExitTool = (sessionID: string) =>
    hooks.tool!.thatch_exit.execute({}, { sessionID } as any) as Promise<string>;

  test("exit greenlight publishes the app.exit TUI command", async () => {
    const before = tuiPublishCalls.length;
    await armExit("ses_wrape");
    await callExitTool("ses_wrape");
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrape", status: { type: "idle" } } } as any,
    });
    expect(tuiPublishCalls.slice(before)).toEqual([
      { body: { type: "tui.command.execute", properties: { command: "app.exit" } } },
    ]);
    expect(tuiExecuteCommandCalls).toHaveLength(1); // only the compact test's
  });

  test("missing token blocks with a warning toast and triggers nothing", async () => {
    const before = { cmd: tuiExecuteCommandCalls.length, pub: tuiPublishCalls.length, toast: tuiToastCalls.length };
    await runWrapUp("thatch/compact", "ses_wrapb", "Outstanding: fix the failing test first.");
    expect(tuiExecuteCommandCalls.length).toBe(before.cmd);
    expect(tuiPublishCalls.length).toBe(before.pub);
    expect(tuiToastCalls.length).toBe(before.toast + 1);
    expect(tuiToastCalls[tuiToastCalls.length - 1].body.variant).toBe("warning");
    expect(tuiToastCalls[tuiToastCalls.length - 1].body.message).toContain("/thatch/compact");
  });

  test("token must be trailing - mid-text mentions do not greenlight", async () => {
    const before = tuiExecuteCommandCalls.length;
    await runWrapUp(
      "thatch/compact",
      "ses_wrapm",
      "As instructed, the token is THATCH_COMPACT_READY. But one todo is still open, so I have not appended it as my last line.",
    );
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });

  test("an un-greenlit exit arm survives an idle and triggers nothing", async () => {
    // The fix behind the tool protocol: idles before the thatch_exit call
    // must not consume the arm (the old consume-on-first-idle ate the arm
    // during a mid-exit wait, stranding the final close). No message fetch,
    // no toast, no host action - the arm just persists.
    const before = { pub: tuiPublishCalls.length, toast: tuiToastCalls.length };
    await armExit("ses_wrapu0");
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapu0", status: { type: "idle" } } } as any,
    });
    expect(tuiPublishCalls.length).toBe(before.pub);
    expect(tuiToastCalls.length).toBe(before.toast);
    // The arm is still live: the tool greenlights it and the NEXT idle
    // closes (the post-completion close the old flow lost).
    await callExitTool("ses_wrapu0");
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapu0", status: { type: "idle" } } } as any,
    });
    expect(tuiPublishCalls.slice(before.pub)).toEqual([
      { body: { type: "tui.command.execute", properties: { command: "app.exit" } } },
    ]);
  });

  test("thatch_exit without an armed exit refuses with no side effects", async () => {
    const before = { pub: tuiPublishCalls.length, cmd: tuiExecuteCommandCalls.length };
    const reply = await callExitTool("ses_wrapnoarm");
    expect(reply).toContain("No exit in progress");
    expect(tuiPublishCalls.length).toBe(before.pub);
    expect(tuiExecuteCommandCalls.length).toBe(before.cmd);
  });

  test("thatch_exit against a compact arm refuses and leaves the compact arm alone", async () => {
    // A compact arm plus thatch_exit is a "no exit in progress" refusal,
    // never a greenlight - the callback owns the kind check.
    const before = { pub: tuiPublishCalls.length, cmd: tuiExecuteCommandCalls.length };
    wrapUpMessages = [
      { info: { id: "msg_ck", role: "assistant" }, parts: [{ type: "text", text: "All clear.\nTHATCH_COMPACT_READY" }] },
    ];
    await hooks["command.execute.before"]!({ command: "thatch/compact", sessionID: "ses_wrapck", arguments: "" }, { parts: [] });
    const reply = await callExitTool("ses_wrapck");
    expect(reply).toContain("No exit in progress");
    expect(tuiPublishCalls.length).toBe(before.pub);
    expect(tuiExecuteCommandCalls.length).toBe(before.cmd);
    // The compact arm still resolves as compact: the token greenlights it.
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapck", status: { type: "idle" } } } as any,
    });
    expect(tuiExecuteCommandCalls.length).toBe(before.cmd + 1);
  });

  test("a second thatch_exit call is idempotent and closes exactly once", async () => {
    const before = tuiPublishCalls.length;
    await armExit("ses_wrapdbl");
    const first = await callExitTool("ses_wrapdbl");
    const second = await callExitTool("ses_wrapdbl");
    expect(first).toContain("Greenlit");
    expect(second).toContain("Already greenlit");
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapdbl", status: { type: "idle" } } } as any,
    });
    expect(tuiPublishCalls.slice(before)).toHaveLength(1);
  });

  test("unknown commands do not arm the wrap-up check", async () => {
    const before = tuiExecuteCommandCalls.length;
    await runWrapUp("some-other-command", "ses_wrapu", "done\nTHATCH_COMPACT_READY");
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });

  test("exit greenlight unregisters the session from the chat directory", async () => {
    const before = new ThatchDB(process.env.THATCH_DB_PATH!);
    before.registerChatSession("ses_wrapeu", "p", null, "opencode", "gammawrap");
    before.close();
    await armExit("ses_wrapeu");
    await callExitTool("ses_wrapeu");
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapeu", status: { type: "idle" } } } as any,
    });
    const after = new ThatchDB(process.env.THATCH_DB_PATH!);
    expect(after.listChatSessions().find((r) => r.session_id === "ses_wrapeu")).toBeUndefined();
    after.close();
  });

  test("compact greenlight does not unregister the session", async () => {
    const before = new ThatchDB(process.env.THATCH_DB_PATH!);
    before.registerChatSession("ses_wrapnu", "p", null, "opencode", "deltawrap");
    before.close();
    await runWrapUp("thatch/compact", "ses_wrapnu", "All clear.\nTHATCH_COMPACT_READY");
    const after = new ThatchDB(process.env.THATCH_DB_PATH!);
    // Compaction continues the session, so the directory row must survive.
    expect(after.listChatSessions().find((r) => r.session_id === "ses_wrapnu")).toBeDefined();
    after.close();
  });

  test("session.deleted clears a pending wrap-up", async () => {
    const before = tuiExecuteCommandCalls.length;
    await hooks["command.execute.before"]!(
      { command: "thatch/compact", sessionID: "ses_wrapd", arguments: "" },
      { parts: [] },
    );
    wrapUpMessages = [
      { info: { id: "msg_ud", role: "assistant" }, parts: [{ type: "text", text: "THATCH_COMPACT_READY" }] },
    ];
    await hooks.event!({ event: {
      type: "session.deleted",
      properties: { info: { id: "ses_wrapd" } } } as any,
    });
    await hooks.event!({ event: {
      type: "session.status",
      properties: { sessionID: "ses_wrapd", status: { type: "idle" } } } as any,
    });
    // The cleared wrap-up must not have fired a compact trigger of its own.
    expect(tuiExecuteCommandCalls.length).toBe(before);
  });
});

describe("installOpencodeCommands", () => {
  test("writes the wrap-up and action command files and is idempotent", async () => {
    const { installOpencodeCommands } = await import("../src/commands");
    const home = mkdtempSync(join(tmpdir(), "thatch-cmds-"));
    try {
      const first = installOpencodeCommands(home);
      const names = first.map((p) => p.split("/").pop()!.replace(/\.md$/, "")).sort();
      expect(names).toEqual(["bug-intake", "compact", "defrag", "exit", "extract", "hygiene", "peer-review", "refine", "reflect", "self-review", "whois"]);
      const compact = readFileSync(join(first[0]!), "utf8");
      expect(compact).toContain("description:");
      expect(compact).toContain("THATCH_COMPACT_READY");
      // Re-run: everything current, nothing rewritten.
      expect(installOpencodeCommands(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rewrites when on-disk content diverges (template update self-heal)", async () => {
    const { installOpencodeCommands } = await import("../src/commands");
    const home = mkdtempSync(join(tmpdir(), "thatch-cmds2-"));
    try {
      const dir = join(home, "opencode", "command", "thatch");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "compact.md"), "stale content");
      const written = installOpencodeCommands(home);
      // compact.md was stale (rewritten); everything else was missing (created).
      expect(written).toContain(join(dir, "compact.md"));
      expect(written).toContain(join(dir, "defrag.md"));
      expect(readFileSync(join(dir, "compact.md"), "utf8")).toContain("THATCH_COMPACT_READY");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wrap-up command bodies label the sections: user text first, then the checklist", async () => {
    // opencode replaces $ARGUMENTS with the text typed after the command
    // (/thatch/exit thanks! -> "thanks!" in the User Message section), and
    // with no argument the section renders empty. The header labels are
    // load-bearing: without them the user's text dangles after the
    // checklist and reads like a sign-off addressed at the instructions.
    const { opencodeCommandDefs } = await import("../src/commands");
    const wrapUps = opencodeCommandDefs().filter((d) => d.name === "compact" || d.name === "exit");
    for (const def of wrapUps) {
      const body = def.content.slice(def.content.indexOf("---", 3) + 3);
      expect(body.trimStart()).toMatch(/^# User Message\n\n\$ARGUMENTS\n\n\(That section carries/);
      expect(body).toContain(`# Pre-${def.name === "compact" ? "compact" : "exit"} wrap-up`);
      expect(body).toContain("treat the user message as n/a");
    }
    const exit = opencodeCommandDefs().find((d) => d.name === "exit")!;
    // The exit template deliberately does NOT instruct the model to
    // unregister from chat: the plugin-side unregister on the greenlit
    // idle is the deterministic path, and a model-side unregister mid-turn
    // would delete the chat row before the exit branch can place the
    // session's watcher deaths by that row (the death lands unplaceable).
    expect(exit.content).not.toContain("chat_unregister");
  });
});

describe("action commands", () => {
  test("each action file carries its core body and the user message section", async () => {
    const { opencodeCommandDefs, actionDefs } = await import("../src/commands");
    const defs = opencodeCommandDefs().filter((d) => !["compact", "exit"].includes(d.name));
    const actions = actionDefs();
    expect(defs.map((d) => d.name)).toEqual(actions.map((a) => a.name));
    for (const def of defs) {
      expect(def.content).toContain("description:");
      expect(def.content).toContain("$ARGUMENTS");
      // The core body must survive rendering verbatim, so a wording change
      // in prompts.ts cannot silently miss the command file.
      const action = actions.find((a) => a.name === def.name)!;
      expect(def.content).toContain(action.body);
    }
  });

  test("extract action fetches by explicit session id learned from get_session_info", async () => {
    const { opencodeCommandDefs } = await import("../src/commands");
    const extract = opencodeCommandDefs().find((d) => d.name === "extract")!;
    expect(extract.content).toContain("thatch_get_session_info");
    expect(extract.content).toContain('session_id \\"SESSION_ID\\"');
    expect(extract.content).toContain("thatch_extraction_done");
  });

  test("frontmatter descriptions are always quoted YAML scalars", async () => {
    // An unquoted value containing ": " (hygiene's description has one) is
    // invalid YAML; hosts that miss the lenient fallback then show the
    // command with no description at all.
    const { opencodeCommandDefs, claudeCommandDefs } = await import("../src/commands");
    for (const def of [...opencodeCommandDefs(), ...claudeCommandDefs()]) {
      const line = def.content.split("\n").find((l) => l.startsWith("description:"))!;
      const value = line.slice("description:".length).trim();
      expect(value).toMatch(/^".*"$/);
    }
  });

  test("Claude Code command set drops wrap-ups and the opencode-only actions (extract, whois)", async () => {
    const { claudeCommandDefs } = await import("../src/commands");
    const names = claudeCommandDefs().map((d) => d.name).sort();
    expect(names).toEqual(["bug-intake", "defrag", "hygiene", "peer-review", "refine", "reflect", "self-review"]);
    for (const def of claudeCommandDefs()) {
      // Tool spelling follows the host. Hygiene drives the thatch CLI,
      // refine triggers a skill, and self-review names no tools; all three
      // are exempt from the MCP spelling check. peer-review names
      // memory_recall through the namer, so it must pass the check.
      if (def.name !== "hygiene" && def.name !== "refine" && def.name !== "self-review") {
        expect(def.content).toMatch(/mcp__thatch__/);
        expect(def.content).not.toContain("thatch_find_duplicates");
      }
    }
  });

  test("installClaudeCommands writes under commands/thatch and is idempotent", async () => {
    const { installClaudeCommands } = await import("../src/commands");
    const claudeDir = mkdtempSync(join(tmpdir(), "thatch-claude-cmds-"));
    try {
      const first = installClaudeCommands(claudeDir);
      expect(first).toHaveLength(7);
      expect(first[0]).toContain(join("commands", "thatch"));
      expect(installClaudeCommands(claudeDir)).toEqual([]);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("host command sets are the same actions minus documented exclusions", async () => {
    const { opencodeCommandDefs, claudeCommandDefs } = await import("../src/commands");
    const { compilePrompts } = await import("../src/mcp");
    const opencodeNames = opencodeCommandDefs().map((d) => d.name).sort();
    const claudeNames = claudeCommandDefs().map((d) => d.name).sort();
    const promptNames = [...compilePrompts().keys()].sort();
    // Claude Code gets the shared actions only; opencode adds the wrap-ups
    // (needs plugin arming) and the opencode-only actions (need session
    // identity).
    expect(opencodeNames.sort()).toEqual([...claudeNames, "compact", "exit", "extract", "whois"].sort());
    // MCP prompts match Claude Code's set: same shared actions, same bodies.
    expect(promptNames).toEqual(claudeNames);
  });
});
