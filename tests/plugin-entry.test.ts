// The former plugin.test.ts "plugin entry" describe, split by topic,
// re-based onto the v2 harness (the drop-v1 plan's Phase A-prime): this file
// holds the plugin-entry shape tests (exports, tool registry, hook presence,
// system/context transform, chat-tool transcript echo) and the trailing
// skill-install / event-pump / delivery-guard wiring. The rest of the block
// lives in plugin-extraction.test.ts (interaction buffering + payload
// handshake), plugin-extraction-claims.test.ts (watcher journal reconcile +
// claim scoping), and plugin-extraction-direct.test.ts (direct-extraction
// child lifecycle).

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/opencode/v2";
import thatchPlugin from "../src/index";
import {
  addedTools,
  compactionHook,
  contextHook,
  currentHarness,
  makeContext,
  queueEvent,
  rpcEmitted,
  SESSION_DIR,
  sessionSyntheticCalls,
  setupTestEnv,
  teardownTestEnv,
  toolAfterHook,
  waitFor,
} from "./mocks/opencode-v2-harness";
import { TOAST_EVENT } from "../src/session-tab-shared";

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

describe("plugin entry", () => {
  test("exports the v2 plugin shape as the default export", () => {
    // A v2 host validates the default export as { id, setup } and ignores
    // named exports entirely.
    expect(typeof thatchPlugin.setup).toBe("function");
    expect(typeof thatchPlugin.id).toBe("string");
    expect(thatchPlugin.id.length).toBeGreaterThan(0);
  });

  test("registers all expected tools through the ToolEditor", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const names = addedTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "thatch_behavior_codify",
      "thatch_behavior_delete",
      "thatch_behavior_feedback",
      "thatch_behavior_list",
      "thatch_chat_broadcast",
      "thatch_chat_list",
      "thatch_chat_read",
      "thatch_chat_register",
      "thatch_chat_send",
      "thatch_chat_status",
      "thatch_chat_unregister",
      "thatch_compact",
      "thatch_config_get",
      "thatch_config_set",
      "thatch_dedup_mark_checked",
      "thatch_exit",
      "thatch_extraction_done",
      "thatch_find_duplicates",
      "thatch_get_extraction_payload",
      "thatch_get_session_info",
      "thatch_memory_forget",
      "thatch_memory_list",
      "thatch_memory_recall",
      "thatch_memory_remember",
      "thatch_memory_show",
      "thatch_notify_user",
      "thatch_prediction_delete",
      "thatch_prediction_find_duplicates",
      "thatch_prediction_list",
      "thatch_prediction_mark_checked",
      "thatch_prediction_query",
      "thatch_prediction_update",
      "thatch_session_get",
      "thatch_session_search",
      // opencode-only: the session-tab bridge rides host surfaces MCP lacks.
      "thatch_session_tab",
      "thatch_session_tab_close",
      "thatch_session_tab_open",
      "thatch_store_list",
      "thatch_watch_branch_create",
      "thatch_watch_cancel",
      "thatch_watch_command_create",
      "thatch_watch_create",
      "thatch_watch_list",
    ]);
  });

  test("has context (system) hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(currentHarness.hooks["context"]).toBeDefined();
  });

  test("has prompt hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(currentHarness.hooks["prompt"]).toBeDefined();
  });

  test("has compaction hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(currentHarness.hooks["compaction"]).toBeDefined();
  });

  test("context hook appends to the request's system array", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const system: unknown[] = [];
    await contextHook!({ sessionID: "ses_ctx", system, messages: [] });
    expect(system.length).toBe(1);
    expect((system[0] as { text: string }).text).toContain("Thatch provides persistent memory");
  });

  test("prompt hook computes no nudge when extraction is empty", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const prompt = { text: "hello" };
    await (currentHarness.hooks["prompt"]!)({ sessionID: "ses_clean", messageID: "msg_clean", prompt });
    const request = {
      sessionID: "ses_clean",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    await contextHook!(request);
    // no nudge, buffer empty: the original prompt part is all the message carries
    expect((request.messages[0].content as unknown[]).length).toBe(1);
  });

  test("compaction hook appends context and marks session as compacting", async () => {
    // Shape delta vs v1: the v2 compaction hook injects the re-familiarization
    // context through the request's system array (the full system prompt),
    // not the v1 output.context string; the flag itself is pinned by the
    // nudge-tiers compaction-guard tests.
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const system: unknown[] = [];
    await compactionHook!({ sessionID: "ses_compact_1", system });
    expect(system.length).toBe(1);
    expect((system[0] as { text: string }).text).toContain("Thatch provides persistent memory");
    // v1 asserted the short re-familiarization string here ("not containing
    // thatch_memory_recall"); the v2 adapter ships the FULL system prompt on
    // the compaction request (a deliberate superset that names every tool),
    // so the negative pin has no v2 subject.
  });

  test("each tool has description and execute", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    for (const t of addedTools) {
      expect(t.description, `${t.name} missing description`).toBeTruthy();
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute, `${t.name} missing execute`).toBe("function");
    }
  });

  test("each tool has an input schema", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    for (const t of addedTools) {
      expect(t.input, `${t.name} missing input schema`).toBeDefined();
    }
  });

  test("dispose hook is defined", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(typeof cleanup).toBe("function");
  });

  test("has tool.execute.after hook", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    expect(currentHarness.hooks["execute.after"]).toBeDefined();
  });

  test("chat tool calls echo visible parts back into the transcript", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "thatch_chat_send",
      sessionID: "ses_echo",
      input: { to: "Landru", body: "hello there" },
      status: "completed",
      result: { content: "[sent] to Landru (ses_f6c9e9a0)\n\nThe recipient is nudged when its session is idle. If its host process is gone (stale in chat_list), the message waits unread - a dead session never reads it." },
    });
    // The echo is fire-and-forget; poll for the delivery.
    await waitFor("the chat echo delivery", () => sessionSyntheticCalls.length === 1);
    const call = sessionSyntheticCalls[0];
    expect(call.sessionID).toBe("ses_echo");
    // noReply routes to the resume:false synthetic - a synthetic inbox item
    // that starts no model turn (the visible-bubble + no-turn contract).
    expect(call.resume).toBe(false);
    expect(call.text).toBe("[chat] to Landru: hello there");
  });

  test("failed chat sends and non-conversational chat tools do not echo", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await toolAfterHook!({
      tool: "thatch_chat_send",
      sessionID: "ses_echo",
      input: { to: "ghost", body: "hi" },
      status: "completed",
      result: { content: `Not sent: No registered session named "ghost". Use chat_list to see who is available.` },
    });
    await toolAfterHook!({
      tool: "thatch_chat_list",
      sessionID: "ses_echo",
      input: {},
      status: "completed",
      result: { content: "[chat] 1 session registered" },
    });
    // The echo delivery is fire-and-forget; settle before the negative assert.
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionSyntheticCalls.length).toBe(0);
  });
});

describe("plugin entry", () => {
  test("installs skill files under the redirected config home", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    const skillPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-fact-extractor", "SKILL.md",
    );
    expect(readFileSync(skillPath, "utf8")).toContain("thatch-fact-extractor");

    const primerPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-project-primer", "SKILL.md",
    );
    expect(readFileSync(primerPath, "utf8")).toContain("thatch-project-primer");

    // opencode installs both shared and opencode-only skills
    const reviewPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-review-pedantic", "SKILL.md",
    );
    expect(readFileSync(reviewPath, "utf8")).toContain("thatch-review-pedantic");

    const coordinatorPath = join(
      process.env.XDG_CONFIG_HOME!,
      "opencode", "skills", "thatch-code-review", "SKILL.md",
    );
    expect(readFileSync(coordinatorPath, "utf8")).toContain("thatch-code-review");
  });

  test("session.created delivers the session-start reminder via the resume:false synthetic", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await queueEvent({
      type: "session.created",
      location: { directory: SESSION_DIR },
      data: { sessionID: "test-session-123", info: { id: "test-session-123" } },
    });
    await waitFor("the session-start reminder", () =>
      sessionSyntheticCalls.some((c: any) => c?.sessionID === "test-session-123" && String(c?.text).includes("thatch")),
    );
    const reminder = sessionSyntheticCalls.find((c: any) => c?.sessionID === "test-session-123");
    // The noReply reminder must not wake execution.
    expect(reminder?.resume).toBe(false);
    expect(String(reminder?.text)).toContain("thatch");
  });

  test("delivery guard wiring: a wake into a deleted directory is skipped with a debug line", async () => {
    // Wiring-level, not a direct guardDelivery call: this drives the
    // integrated path (setup -> createRuntime -> guarded promptSession)
    // so a guard that is defined but never wired cannot pass here. The
    // function-level behavior lives in tests/delivery-guard.test.ts.
    const wakeDir = mkdtempSync(join(tmpdir(), "thatch-guard-gone-"));
    const guardDb = mkdtempSync(join(tmpdir(), "thatch-guard-db-"));
    const prevDbPath = process.env.THATCH_DB_PATH;
    const prevDebug = process.env.THATCH_DEBUG;
    process.env.THATCH_DB_PATH = join(guardDb, "test.db");
    // Only the delivery guard's tag passes the filter, so any matched line
    // in the log is the guard's and nothing else's.
    process.env.THATCH_DEBUG = "runtime:delivery";
    try {
      const context = makeContext({
        location: { directory: wakeDir, project: { directory: wakeDir, canonical: wakeDir } },
      });
      cleanup = (await setup(context as any)) as () => Promise<void>;
      rmSync(wakeDir, { recursive: true });
      await queueEvent({
        type: "session.created",
        location: { directory: wakeDir },
        data: { sessionID: "ses-guard-gone", info: { id: "ses-guard-gone" } },
      });
      // The pump's handler is async; give the skipped wake a beat to land
      // in the debug log before the negative assertion.
      await new Promise((r) => setTimeout(r, 300));

      // The wake must not run against the deleted directory: no delivery,
      // no throw, and the debug line names the session and the path.
      expect(sessionSyntheticCalls.length).toBe(0);
      const log = readFileSync(join(guardDb, "debug.log"), "utf8");
      expect(log).toContain("runtime:delivery");
      expect(log).toContain("ses-guard-gone");
      expect(log).toContain(wakeDir);
    } finally {
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
      if (prevDebug === undefined) delete process.env.THATCH_DEBUG;
      else process.env.THATCH_DEBUG = prevDebug;
      rmSync(wakeDir, { recursive: true, force: true });
      rmSync(guardDb, { recursive: true, force: true });
    }
  });

  test("event pump drops events it does not consume", async () => {
    cleanup = (await setup(makeContext() as any)) as () => Promise<void>;
    await queueEvent({
      type: "session.updated",
      location: { directory: SESSION_DIR },
      data: {},
    });
    // The pump's handler is async; settle before the negative assert.
    await new Promise((r) => setTimeout(r, 300));
    expect(sessionSyntheticCalls.length).toBe(0);
    expect(rpcEmitted.some((e) => e.name === TOAST_EVENT)).toBe(false);
  });
});
