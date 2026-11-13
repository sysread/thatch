// Wrap-up command resolution and command-file installation tests from
// plugin.test.ts, re-based onto the v2 harness (the drop-v1 plan's Phase
// A-prime): the /thatch/compact and /thatch/exit greenlight flow, the
// registered wrap-up commands, and the action command sets. On v2 the
// wrap-up commands arm inside their execute (v1's command.execute.before
// hook) and the SAME execute also delivers the wrap-up body (a real
// prompt); the compact action rides session.compact and the exit action
// emits the rpc bridge's exit-tab-closed event (v1: the TUI publish /
// executeCommand channels).

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/opencode/v2";
import { ThatchDB } from "../src/db";
import { EXIT_TAB_CLOSED_EVENT } from "../src/session-tab-shared";
import {
  addedCommands,
  addedTools,
  makeContext,
  queueEvent,
  rpcEmitted,
  SESSION_DIR,
  sessionCompactCalls,
  setupTestEnv,
  teardownTestEnv,
  waitFor,
} from "./mocks/opencode-v2-harness";

// These tests pump async events through the v2 adapter harness; under a
// loaded CI runner the pump can lag. Bun's default per-test timeout is 5s
// with no margin for that (the 2026-11-03 fleet-contention CI reds). 90s =
// expected (ms-scale pump handling) x ~900 headroom, above the harness
// waitFor deadline so real hangs report the poll message.
setDefaultTimeout(90_000);

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  setupTestEnv();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  await teardownTestEnv();
});

const exitEvents = () => rpcEmitted.filter((e) => e.name === EXIT_TAB_CLOSED_EVENT);

describe("wrap-up commands (/thatch/compact, /thatch/exit)", () => {
  // Drives the full tool-protocol flow: the registered command arms the
  // session (and delivers the wrap-up body - the v2 execute does both),
  // the model greenlights with the kind's zero-arg tool call, and the
  // session's next idle runs the host action. The tool resolves the
  // session from the per-call host context.
  const arm = (name: "thatch/compact" | "thatch/exit", sessionID: string) =>
    addedCommands.find((c) => c.name === name)!.execute({ sessionID });
  const idle = (sessionID: string) =>
    queueEvent({
      type: "session.execution.succeeded",
      location: { directory: SESSION_DIR },
      data: { sessionID },
    });
  const callExitTool = (sessionID: string) =>
    addedTools.find((t) => t.name === "thatch_exit")!.execute({}, { sessionID, agent: "build" }) as Promise<unknown>;
  const callCompactTool = (sessionID: string) =>
    addedTools.find((t) => t.name === "thatch_compact")!.execute({}, { sessionID, agent: "build" }) as Promise<unknown>;
  const replyOf = (r: unknown): string => String((r as any)?.content ?? "");

  test("compact greenlight triggers the session.compact action", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/compact", "ses_wrapc");
    await callCompactTool("ses_wrapc");
    await idle("ses_wrapc");
    await waitFor("session.compact called", () => sessionCompactCalls.length === 1);
    expect(sessionCompactCalls[0]).toEqual({ sessionID: "ses_wrapc" });
    expect(exitEvents()).toHaveLength(0);
  });

  // The exit flow under the tool protocol: the command arms the exit, the
  // model greenlights with the zero-arg thatch_exit tool call, and the
  // session's next idle runs the close.
  test("exit greenlight emits the exit-tab-closed event", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/exit", "ses_wrape");
    await callExitTool("ses_wrape");
    await idle("ses_wrape");
    await waitFor("exit close emitted", () => exitEvents().length === 1);
    // TUI-only payload: just the tab to close.
    expect(exitEvents()[0].data).toEqual({ sessionID: "ses_wrape" });
    expect(sessionCompactCalls.length).toBe(0);
  });

  // There is no runtime "blocked" concept under the tool protocol: the
  // blockers are prose per the templates, and an un-greenlit arm simply
  // persists. (The old one-idle token handshake consumed the arm on the
  // first idle either way - the mid-wrap-up idle ate it and stranded the
  // final action. That toast pin has no tool-protocol analog; likewise the
  // old "token must be trailing" pin: a tool call cannot be mid-text.)
  test("an un-greenlit compact arm survives an idle and triggers nothing", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/compact", "ses_wrapb");
    await idle("ses_wrapb");
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionCompactCalls.length).toBe(0);
    // The arm is still live: the tool greenlights it and the NEXT idle
    // compacts (the post-checklist compaction the old flow lost).
    await callCompactTool("ses_wrapb");
    await idle("ses_wrapb");
    await waitFor("late session.compact called", () => sessionCompactCalls.length === 1);
  });

  test("an un-greenlit exit arm survives an idle and triggers nothing", async () => {
    // The fix behind the tool protocol: idles before the thatch_exit call
    // must not consume the arm (the old consume-on-first-idle ate the arm
    // during a mid-exit wait, stranding the final close). No host action -
    // the arm just persists.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/exit", "ses_wrapu0");
    await idle("ses_wrapu0");
    // Negative wait: the pump's handler is async; settle before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(exitEvents().length).toBe(0);
    // The arm is still live: the tool greenlights it and the NEXT idle
    // closes (the post-completion close the old flow lost).
    await callExitTool("ses_wrapu0");
    await idle("ses_wrapu0");
    await waitFor("late exit close emitted", () => exitEvents().length === 1);
  });

  test("thatch_exit without an armed exit refuses with no side effects", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const reply = await callExitTool("ses_wrapnoarm");
    expect(replyOf(reply)).toContain("No exit in progress");
    expect(exitEvents().length).toBe(0);
    expect(sessionCompactCalls.length).toBe(0);
  });

  test("thatch_compact without an armed compact refuses with no side effects", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const reply = await callCompactTool("ses_wrapnoarmc");
    expect(replyOf(reply)).toContain("No compaction in progress");
    expect(exitEvents().length).toBe(0);
    expect(sessionCompactCalls.length).toBe(0);
  });

  test("a thatch_compact call against an exit arm refuses and leaves the exit arm alone", async () => {
    // The cross-kind refusal matrix, compact leg: an exit arm plus
    // thatch_compact is a "no compaction in progress" refusal, never a
    // greenlight - the callback owns the kind check.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/exit", "ses_wrapxk");
    const reply = await callCompactTool("ses_wrapxk");
    expect(replyOf(reply)).toContain("No compaction in progress");
    expect(exitEvents().length).toBe(0);
    expect(sessionCompactCalls.length).toBe(0);
    // The exit arm still resolves as exit: the thatch_exit tool greenlights it.
    await callExitTool("ses_wrapxk");
    await idle("ses_wrapxk");
    await waitFor("exit close emitted", () => exitEvents().length === 1);
  });

  test("thatch_exit against a compact arm refuses and leaves the compact arm alone", async () => {
    // The cross-kind refusal matrix, exit leg: a compact arm plus
    // thatch_exit is a "no exit in progress" refusal, never a greenlight.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/compact", "ses_wrapck");
    const reply = await callExitTool("ses_wrapck");
    expect(replyOf(reply)).toContain("No exit in progress");
    expect(exitEvents().length).toBe(0);
    expect(sessionCompactCalls.length).toBe(0);
    // The compact arm still resolves as compact: the tool greenlights it.
    await callCompactTool("ses_wrapck");
    await idle("ses_wrapck");
    await waitFor("session.compact called", () => sessionCompactCalls.length === 1);
  });

  test("a second thatch_exit call is idempotent and closes exactly once", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/exit", "ses_wrapdbl");
    const first = await callExitTool("ses_wrapdbl");
    const second = await callExitTool("ses_wrapdbl");
    expect(replyOf(first)).toContain("Greenlit");
    expect(replyOf(second)).toContain("Already greenlit");
    await idle("ses_wrapdbl");
    await waitFor("exit close emitted", () => exitEvents().length === 1);
    expect(exitEvents()).toHaveLength(1);
  });

  test("a second thatch_compact call is idempotent and compacts exactly once", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/compact", "ses_wrapdblc");
    const first = await callCompactTool("ses_wrapdblc");
    const second = await callCompactTool("ses_wrapdblc");
    expect(replyOf(first)).toContain("Greenlit");
    expect(replyOf(second)).toContain("Already greenlit");
    await idle("ses_wrapdblc");
    await waitFor("session.compact called", () => sessionCompactCalls.length === 1);
    expect(sessionCompactCalls).toHaveLength(1);
  });

  test("exit greenlight unregisters the session from the chat directory", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const before = new ThatchDB(process.env.THATCH_DB_PATH!);
    before.registerChatSession("ses_wrapeu", "p", null, "opencode", "gammawrap");
    before.close();
    await arm("thatch/exit", "ses_wrapeu");
    await callExitTool("ses_wrapeu");
    await idle("ses_wrapeu");
    await waitFor("the chat unregister", () =>
      new ThatchDB(process.env.THATCH_DB_PATH!).listChatSessions().find((r) => r.session_id === "ses_wrapeu") === undefined,
    );
    // The exit tombstone also stops the same idle's auto-register from
    // resurrecting the row.
    await new Promise((r) => setTimeout(r, 300));
    expect(new ThatchDB(process.env.THATCH_DB_PATH!).listChatSessions().find((r) => r.session_id === "ses_wrapeu")).toBeUndefined();
  });

  test("compact greenlight does not unregister the session", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const before = new ThatchDB(process.env.THATCH_DB_PATH!);
    before.registerChatSession("ses_wrapnu", "p", null, "opencode", "deltawrap");
    before.close();
    await arm("thatch/compact", "ses_wrapnu");
    await callCompactTool("ses_wrapnu");
    await idle("ses_wrapnu");
    await waitFor("session.compact called", () => sessionCompactCalls.length === 1);
    const after = new ThatchDB(process.env.THATCH_DB_PATH!);
    // Compaction continues the session, so the directory row must survive.
    expect(after.listChatSessions().find((r) => r.session_id === "ses_wrapnu")).toBeDefined();
    after.close();
  });

  test("session.deleted clears a pending wrap-up", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await arm("thatch/compact", "ses_wrapd");
    await queueEvent({
      type: "session.deleted",
      location: { directory: SESSION_DIR },
      data: { sessionID: "ses_wrapd" },
    });
    await idle("ses_wrapd");
    // The cleared wrap-up must not have fired a compact trigger of its own.
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionCompactCalls.length).toBe(0);
  });
});

describe("installOpencodeCommands", () => {
  test("writes the action command files (wrap-ups register in code) and is idempotent", async () => {
    const { installOpencodeCommands } = await import("../src/commands");
    const home = mkdtempSync(join(tmpdir(), "thatch-cmds-"));
    try {
      const first = installOpencodeCommands(home);
      const names = first.map((p) => p.split("/").pop()!.replace(/\.md$/, "")).sort();
      expect(names).toEqual(["bug-intake", "defrag", "extract", "hygiene", "peer-review", "refine", "reflect", "self-review", "whois"]);
      const defrag = readFileSync(join(first[0]!), "utf8");
      expect(defrag).toContain("description:");
      expect(defrag).toContain("$ARGUMENTS");
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
      writeFileSync(join(dir, "defrag.md"), "stale content");
      const written = installOpencodeCommands(home);
      // defrag.md was stale (rewritten); everything else was missing (created).
      expect(written).toContain(join(dir, "defrag.md"));
      expect(written).toContain(join(dir, "extract.md"));
      expect(readFileSync(join(dir, "defrag.md"), "utf8")).toContain("$ARGUMENTS");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("wrap-up command bodies label the sections: user text first, then the checklist", async () => {
    // The wrap-ups are no longer file-installed; their template bodies
    // load through wrapUpCommandContent (the CommandEditor's execute
    // delivers this same text as the session prompt).
    const { wrapUpCommandContent } = await import("../src/commands");
    const wrapUps = (["compact", "exit"] as const).map((kind) => ({ name: kind, content: wrapUpCommandContent(kind) }));
    for (const def of wrapUps) {
      const body = def.content.slice(def.content.indexOf("---", 3) + 3);
      expect(body.trimStart()).toMatch(/^# User Message\n\n\$ARGUMENTS\n\n\(That section carries/);
      expect(body).toContain(`# Pre-${def.name === "compact" ? "compact" : "exit"} wrap-up`);
      expect(body).toContain("treat the user message as n/a");
    }
    const exit = wrapUpCommandContent("exit");
    // The exit template deliberately does NOT instruct the model to
    // unregister from chat: the plugin-side unregister on the greenlit
    // idle is the deterministic path, and a model-side unregister mid-turn
    // would delete the chat row before the exit branch can place the
    // session's watcher deaths by that row (the death lands unplaceable).
    expect(exit).not.toContain("chat_unregister");
  });
});

describe("action commands", () => {
  test("each action file carries its core body and the user message section", async () => {
    const { opencodeCommandDefs, actionDefs } = await import("../src/commands");
    const defs = opencodeCommandDefs();
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

  test("extract action dispatches with no session id (the host resolves the child)", async () => {
    // The 2026-11-13 corrupted-id fix: the dispatched sub-agent is
    // session-linked and the host resolves its queue, so the command must
    // not teach an id to learn, substitute, or copy.
    const { opencodeCommandDefs } = await import("../src/commands");
    const extract = opencodeCommandDefs().find((d) => d.name === "extract")!;
    expect(extract.content).toContain("thatch_get_extraction_payload");
    expect(extract.content).toContain("thatch_extraction_done");
    expect(extract.content).toContain("no session_id");
    expect(extract.content).not.toContain("SESSION_ID");
    expect(extract.content).not.toContain("thatch_get_session_info");
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
    // Claude Code gets the shared actions only; opencode adds the
    // opencode-only actions (need session identity). The wrap-ups register
    // in code on opencode and never file-install on either host.
    expect(opencodeNames.sort()).toEqual([...claudeNames, "extract", "whois"].sort());
    // MCP prompts match Claude Code's set: same shared actions, same bodies.
    expect(promptNames).toEqual(claudeNames);
  });
});
