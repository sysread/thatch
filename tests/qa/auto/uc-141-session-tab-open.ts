import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { setup as setupV2 } from "../../../src/opencode/v2";
import { makeV2Harness } from "../../mocks/v2-harness";
import { TOOL_DEFS } from "../../../src/tool-defs";
import { ThatchDB } from "../../../src/db";

/**
 * UC-141: session_tab_open reopens a tab for an EXISTING session.
 *
 * Automatable: yes - boots the real v2 adapter on the shared mock promise
 * context (tests/mocks/v2-harness.ts) and drives the tool through the
 * registered execute. A live TUI-opening leg is out of scope for auto
 * (opening a real tab needs a window); what auto CAN pin is the
 * server-side contract: the def is v2-only, the happy path emits the
 * spawn's tab-opened event with the resolved target and the calling
 * session as the routing anchor, and the dead-directory guard refuses
 * without emitting (a session whose checkout was deleted would otherwise
 * open opencode's "Session location unavailable" dialog on the user's
 * screen).
 */

const useCase: UseCase = {
  name: "UC-141-session-tab-open",
  preconditions: [
    "- The opencode v2 adapter (src/opencode/v2.ts) loadable with a mock promise context",
    "- An isolated fixture with THATCH_DB_PATH and XDG_CONFIG_HOME set",
  ].join("\n"),
  steps: [
    "1. Verify the catalog: session_tab_open exists in TOOL_DEFS with opencodeOnly true (no MCP surface).",
    "2. Boot the v2 adapter with a session.get override that resolves a live session whose directory exists, seed its chat-roster row, and call thatch_session_tab_open with the chat name.",
    "3. Verify the emitted event: the spawn's tab-opened event, payload = resolved session id, the session's current directory, and the calling session's id as the routing anchor.",
    "4. Re-boot with a session.get override that returns a location whose directory does NOT exist, and call the tool again.",
    "5. Verify the refusal: a clear error naming the dead path, and NO event emitted.",
  ].join("\n"),
  expected: [
    "- The happy path emits exactly one tab-opened event (the wire schema the spawn path uses, unchanged) and the tool response words the tab as requested, not guaranteed.",
    "- The dead-directory guard refuses with the path and emits nothing - no 'Session location unavailable' dialog can reach the user's screen from this tool.",
  ].join("\n"),

  async run(ctx: QaContext) {
    // Step 1: the catalog pin - opencodeOnly keeps the tool off the MCP
    // list (the filter site tests the opencodeOnly flag).
    const def = TOOL_DEFS.find((t) => t.name === "session_tab_open");
    if (!def) {
      console.log("  FAIL: session_tab_open missing from TOOL_DEFS");
      return "FAIL";
    }
    if (!def.opencodeOnly) {
      console.log("  FAIL: session_tab_open must be opencodeOnly (no MCP surface)");
      return "FAIL";
    }

    const runLeg = async (options: {
      get: (input: any) => Promise<any>;
      arg: string;
      callerSessionID: string;
    }): Promise<{ result: string; emitted: { name: string; data: any }[] }> => {
      const harness = makeV2Harness(ctx.dir, options);
      let dispose: (() => Promise<void>) | undefined;
      const prevDb = process.env.THATCH_DB_PATH;
      process.env.THATCH_DB_PATH = ctx.env.THATCH_DB_PATH;
      try {
        dispose = (await setupV2(harness.context as any)) as () => Promise<void>;
        const tool = harness.addedTools.find((t) => t.name === "thatch_session_tab_open");
        if (!tool) {
          console.log("  FAIL: thatch_session_tab_open not registered by the v2 adapter");
          return { result: "", emitted: [] };
        }
        const raw = await tool.execute({ session: options.arg }, { sessionID: options.callerSessionID, agent: "build" });
        const result = typeof raw === "string" ? raw : (raw as any)?.content ?? "";
        return { result, emitted: [...harness.calls.emitted] };
      } finally {
        if (dispose) await dispose();
        if (prevDb === undefined) delete process.env.THATCH_DB_PATH;
        else process.env.THATCH_DB_PATH = prevDb;
      }
    };

    // Step 2: the happy path - seed the roster, resolve by chat name.
    const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
    try {
      db.registerChatSession("ses_qa_141_alive", "test-owner/test-repo", null, "opencode", null, null);
    } finally {
      db.close();
    }
    const seeded = new ThatchDB(ctx.env.THATCH_DB_PATH);
    let chatName: string | undefined;
    try {
      chatName = seeded.findChatSession("ses_qa_141_alive")?.name;
    } finally {
      seeded.close();
    }
    if (!chatName) {
      console.log("  FAIL: the seeded roster row did not resolve a chat name");
      return "FAIL";
    }
    const { result: happyResult, emitted: happyEmitted } = await runLeg({
      get: async (input: any) =>
        input?.sessionID === "ses_qa_141_alive"
          ? { title: "QA-141 worker", location: { directory: ctx.dir } }
          : undefined,
      arg: chatName,
      callerSessionID: "ses_qa_141_coordinator",
    });
    if (!happyResult.includes("Tab open requested")) {
      console.log(`  FAIL: happy path did not report the request:\n${happyResult}`);
      return "FAIL";
    }
    if (!happyResult.includes("If it did not appear")) {
      console.log(`  FAIL: the response must word the tab as requested, not guaranteed:\n${happyResult}`);
      return "FAIL";
    }
    // Step 3: the emitted event is the spawn's, unchanged.
    if (happyEmitted.length !== 1 || happyEmitted[0].name !== "tab-opened") {
      console.log(`  FAIL: expected exactly one tab-opened emit, got: ${JSON.stringify(happyEmitted)}`);
      return "FAIL";
    }
    const expectedPayload = {
      sessionID: "ses_qa_141_alive",
      directory: ctx.dir,
      coordinatorSessionID: "ses_qa_141_coordinator",
    };
    if (JSON.stringify(happyEmitted[0].data) !== JSON.stringify(expectedPayload)) {
      console.log(`  FAIL: tab-opened payload mismatch:\n    got:      ${JSON.stringify(happyEmitted[0].data)}\n    expected: ${JSON.stringify(expectedPayload)}`);
      return "FAIL";
    }

    // Step 4: the dead-directory guard.
    const deadDir = join(ctx.dir, "deleted-worktree");
    const { result: deadResult, emitted: deadEmitted } = await runLeg({
      get: async () => ({ title: "Ghost", location: { directory: deadDir } }),
      arg: "ses_qa_141_ghost",
      callerSessionID: "ses_qa_141_coordinator",
    });
    // Step 5: the refusal names the path and emits nothing.
    if (!deadResult.includes("no longer exists") || !deadResult.includes(deadDir)) {
      console.log(`  FAIL: the dead-directory guard must refuse with the path:\n${deadResult}`);
      return "FAIL";
    }
    if (deadEmitted.length !== 0) {
      console.log(`  FAIL: a refused open must not emit - got: ${JSON.stringify(deadEmitted)}`);
      return "FAIL";
    }

    return "PASS";
  },
};

registerUseCase(useCase);
