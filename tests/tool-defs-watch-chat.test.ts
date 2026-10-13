// The watcher tools (watch_create, watch_branch_create, watch_command_create)
// and the chat surfaces (delivery model in tool output, the chat.enabled
// config toggle).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TOOL_DEFS } from "../src/tool-defs";
import { saveConfig } from "../src/config";
import { WatcherRegistry, type GhRunner } from "../src/watchers";
import { setupToolDefsHarness, ctx, dbPath, setOpenTabsFixture } from "./mocks/tool-defs-harness";

setupToolDefsHarness();

describe("watch tools", () => {
  const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
  const host = { sessionID: "ses_watch_test", agent: "build" };

  function registryWith(overrides: Record<string, unknown> = {}): WatcherRegistry {
    return new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: mockGhRoutes(),
      pollIntervalMs: 60_000,
      ...overrides,
    });
  }

  function mockGhRoutes(): GhRunner {
    return async (apiArgs: string[]) => {
      const joined = apiArgs.join(" ");
      if (/\/issues\/\d+\/comments/.test(joined)) return [];
      if (/\/pulls\/\d+\/comments/.test(joined)) return [];
      if (/\/check-runs/.test(joined)) return { check_runs: [] };
      if (/^graphql/.test(joined)) {
        return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
      }
      if (/\/pulls\/\d+$/.test(joined)) {
        return { head: { sha: "cafe1234" }, state: "open", merged: false, title: "T", body: "b" };
      }
      throw new Error(`no route: ${joined}`);
    };
  }

  test("watch_create registers a watcher and reports the baseline", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool("watch_create").execute({ pr: 7 }, watchCtx, host);
    expect(result).toContain("[watching] test-owner/test-repo#7");
    expect(result).toContain("id: watch_");
    expect(result).toContain("cafe123");
    expect(result).toContain("first poll lands within ~60s");
    expect(registry.listForSession(host.sessionID)).toHaveLength(1);
  });

  test("watch_create defaults events to all types", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool("watch_create").execute({ pr: 7 }, watchCtx, host);
    expect(result).toContain("pr_ci");
    expect(result).toContain("pr_comment");
  });

  test("watch_create reports gh/PR failures clearly", async () => {
    const registry = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: async () => {
        throw new Error("no auth");
      },
      pollIntervalMs: 60_000,
    });
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool("watch_create").execute({ pr: 7, repo: "acme/widgets" }, watchCtx, host);
    expect(result).toContain("Watcher not created");
    expect(result).toContain("no auth");
  });

  test("watch_create honors a repo override and event filter", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool("watch_create").execute(
      { pr: 9, repo: "acme/other", events: ["pr_commit"] },
      watchCtx,
      host,
    );
    expect(result).toContain("[watching] acme/other#9");
    expect(result).toContain("events: pr_commit");
  });

  test("watch_create reports one-shot mode in the registration and the list", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool("watch_create").execute({ pr: 7, once: true }, watchCtx, host);
    expect(result).toContain("one-shot - auto-cancels after the first event");
    const listed = await findTool("watch_list").execute({}, watchCtx, host);
    expect(listed).toContain("[once]");
  });

  test("watch_list shows session watchers; other sessions are invisible", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    await findTool("watch_create").execute({ pr: 7 }, watchCtx, { sessionID: "ses_a", agent: "build" });
    await findTool("watch_create").execute({ pr: 8 }, watchCtx, { sessionID: "ses_b", agent: "build" });

    const forA = await findTool("watch_list").execute({}, watchCtx, { sessionID: "ses_a", agent: "build" });
    expect(forA).toContain("test-owner/test-repo#7");
    expect(forA).not.toContain("#8");
  });

  test("watch_list surfaces events queued behind the idle gate, then the count clears", async () => {
    let deliverable = false;
    const registry = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => deliverable,
      ghRunner: mockGhRoutes(),
      pollIntervalMs: 60_000,
    });
    const watchCtx = { ...ctx, watchers: registry };
    await findTool("watch_create").execute({ pr: 7, events: ["pr_commit"] }, watchCtx, host);
    await findTool("watch_create").execute({ pr: 9, events: ["pr_commit"], repo: "acme/other" }, watchCtx, host);
    const prWatchers = registry.listForSession(host.sessionID);
    prWatchers.forEach((w) => {
      if (w.source !== "pr") return;
      w.state.headSha = "old";
    });
    await registry.poll();

    const listed = await findTool("watch_list").execute({}, watchCtx, host);
    expect(listed).toContain("2 events detected, waiting for idle to deliver");
    expect(listed).toContain("test-owner/test-repo#7 x1");
    expect(listed).toContain("acme/other#9 x1");

    deliverable = true;
    await registry.deliverPending();
    const cleared = await findTool("watch_list").execute({}, watchCtx, host);
    expect(cleared).not.toContain("waiting for idle");
  });

  test("watch_cancel removes only the session's own watcher", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const created = await findTool("watch_create").execute({ pr: 7 }, watchCtx, host);
    const id = created.match(/id: (watch_\w+)/)![1];

    expect(await findTool("watch_cancel").execute({ id }, watchCtx, { sessionID: "ses_other", agent: "build" }))
      .toContain(`No watcher "${id}"`);
    expect(await findTool("watch_cancel").execute({ id }, watchCtx, host)).toContain("[cancelled]");
    expect(await findTool("watch_cancel").execute({ id }, watchCtx, host)).toContain(`No watcher "${id}"`);
  });

  test("watch tools explain unavailability without a host context (MCP path)", async () => {
    for (const name of ["watch_create", "watch_list", "watch_cancel"]) {
      const result = await findTool(name).execute(name === "watch_create" ? { pr: 7 } : name === "watch_cancel" ? { id: "x" } : {}, ctx);
      expect(result).toContain("unavailable");
    }
  });
});

describe("watch_branch_create", () => {
  const findTool = () => TOOL_DEFS.find((t) => t.name === "watch_branch_create")!;
  const host = { sessionID: "ses_branch_test", agent: "build" };

  function registryWith(): WatcherRegistry {
    return new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: async (apiArgs: string[]) => {
        const joined = apiArgs.join(" ");
        if (/\/issues\/\d+\/comments/.test(joined)) return [];
        if (/\/pulls\/\d+\/comments/.test(joined)) return [];
        if (/\/check-runs/.test(joined)) return { check_runs: [] };
        if (/^graphql/.test(joined)) return { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };
        if (/\/actions\/runs\?/.test(joined)) {
          return { workflow_runs: [{ id: 55, name: "CI", status: "in_progress", conclusion: null, html_url: "https://x/55", event: "push" }] };
        }
        if (/\/branches\/main$/.test(joined)) return { commit: { sha: "decafbad" } };
        if (/\/pulls\/\d+$/.test(joined)) return { head: { sha: "cafe1234" }, state: "open", merged: false, title: "T", body: "b" };
        throw new Error(`no route: ${joined}`);
      },
      pollIntervalMs: 60_000,
    });
  }

  test("registers a branch watcher and reports the baseline", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool().execute({ branch: "main" }, watchCtx, host);
    expect(result).toContain("[watching] test-owner/test-repo@main");
    expect(result).toContain("decafba");
    expect(result).toContain("branch_workflow");
    expect(result).toContain("first poll lands within ~60s");
    expect(registry.listForSession(host.sessionID)).toHaveLength(1);
  });

  test("honors a workflow-name filter in the registration report", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool().execute(
      { branch: "main", repo: "acme/other", events: ["branch_workflow"], workflows: ["release", "publish"] },
      watchCtx,
      host,
    );
    expect(result).toContain("[watching] acme/other@main");
    expect(result).toContain("workflow filter: release, publish");
  });

  test("reports gh failures clearly", async () => {
    const registry = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: async () => {
        throw new Error("no route to host");
      },
      pollIntervalMs: 60_000,
    });
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool().execute({ branch: "main" }, watchCtx, host);
    expect(result).toContain("Watcher not created");
  });

  test("explains unavailability without a host context (MCP path)", async () => {
    const result = await findTool().execute({ branch: "main" }, ctx);
    expect(result).toContain("unavailable");
  });
});

describe("watch_command_create", () => {
  const findTool = () => TOOL_DEFS.find((t) => t.name === "watch_command_create")!;
  const host = { sessionID: "ses_cmd_test", agent: "build" };

  function registryWith(overrides: Record<string, unknown> = {}): WatcherRegistry {
    return new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: async () => {
        throw new Error("gh is not used by command watches");
      },
      commandRunner: async () => ({ exitCode: 1, timedOut: false, stderr: "", durationMs: 500 }),
      pollIntervalMs: 60_000,
      ...overrides,
    });
  }

  test("registers a command watcher and reports the one-shot mode", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry, projectDir: "/tmp/project" };
    const result = await findTool().execute({ command: "test -f /tmp/marker" }, watchCtx, host);
    expect(result).toContain("[watching] cmd: test -f /tmp/marker");
    expect(result).toContain("id: watch_");
    expect(result).toContain("one-shot - fires on the first exit 0");
    expect(result).toContain("lastExit: 1");
    expect(result).toContain("carries the exit code and duration only");
    expect(registry.listForSession(host.sessionID)).toHaveLength(1);
  });

  test("refuses when the command already exits 0", async () => {
    const registry = registryWith({ commandRunner: async () => ({ exitCode: 0, timedOut: false, stderr: "", durationMs: 100 }) });
    const watchCtx = { ...ctx, watchers: registry, projectDir: "/tmp/project" };
    const result = await findTool().execute({ command: "true" }, watchCtx, host);
    expect(result).toContain("Watcher not created");
    expect(result).toContain("condition is already met");
  });

  test("refuses exit-127 commands with the stderr tail", async () => {
    const registry = registryWith({ commandRunner: async () => ({ exitCode: 127, timedOut: false, stderr: "bash: nope: command not found", durationMs: 50 }) });
    const watchCtx = { ...ctx, watchers: registry, projectDir: "/tmp/project" };
    const result = await findTool().execute({ command: "nope" }, watchCtx, host);
    expect(result).toContain("Watcher not created");
    expect(result).toContain("127");
    expect(result).toContain("command not found");
  });

  test("reports spawn failures clearly", async () => {
    const registry = registryWith({ commandRunner: async () => { throw new Error("spawn gone"); } });
    const watchCtx = { ...ctx, watchers: registry, projectDir: "/tmp/project" };
    const result = await findTool().execute({ command: "anything" }, watchCtx, host);
    expect(result).toContain("Watcher not created");
    expect(result).toContain("spawn gone");
  });

  test("cd overrides the project directory as the watch cwd", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry, projectDir: "/tmp/project" };
    const result = await findTool().execute({ command: "test -f /tmp/marker", cd: "/elsewhere" }, watchCtx, host);
    expect(result).toContain("[watching] cmd:");
    const watcher = registry.listForSession(host.sessionID)[0];
    if (watcher.source !== "command") throw new Error("expected a command watcher");
    expect(watcher.cwd).toBe("/elsewhere");
  });

  test("cd works even when the host wired no project directory", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool().execute({ command: "test -f /tmp/marker", cd: "/elsewhere" }, watchCtx, host);
    expect(result).toContain("[watching] cmd:");
    const watcher = registry.listForSession(host.sessionID)[0];
    if (watcher.source !== "command") throw new Error("expected a command watcher");
    expect(watcher.cwd).toBe("/elsewhere");
  });

  test("explains unavailability without a wired project directory", async () => {
    const registry = registryWith();
    const watchCtx = { ...ctx, watchers: registry };
    const result = await findTool().execute({ command: "test -f /tmp/marker" }, watchCtx, host);
    expect(result).toContain("unavailable");
  });

  test("explains unavailability without a host context (MCP path)", async () => {
    const result = await findTool().execute({ command: "test -f /tmp/marker" }, ctx);
    expect(result).toContain("unavailable");
  });
});

describe("chat delivery model in tool output", () => {
  const findChatTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

  test("chat_register tells opencode sessions they are woken automatically", async () => {
    const result = await findChatTool("chat_register").execute(
      {},
      ctx,
      { sessionID: "ses_wake_oc", agent: "build" },
    );
    expect(result).toMatch(/\[registered\] \S+-\d{5}/);
    expect(result).toContain("woken automatically");
    expect(result).not.toContain("opencode-only");
  });

  test("chat_register tells MCP-host sessions mail arrives at prompt time", async () => {
    const result = await findChatTool("chat_register").execute({}, ctx);
    expect(result).toMatch(/\[registered\] \S+-\d{5}/);
    expect(result).toContain("at your next prompt");
    expect(result).not.toContain("woken automatically");
  });

  test("chat_list renders last check-in age and checkout kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-loc-"));
    try {
      // A .git DIRECTORY is the project-root checkout shape; a worktree
      // checkout would carry a .git file instead.
      mkdirSync(join(dir, ".git"));
      const locCtx = { ...ctx, projectDir: dir };
      await findChatTool("chat_register").execute({}, locCtx, { sessionID: "ses_loc", agent: "build" });
      const list = await findChatTool("chat_list").execute({}, locCtx, { sessionID: "ses_loc", agent: "build" });
      expect(list).toMatch(/last seen \d+[smhd] ago/);
      expect(list).toContain("loc:root");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat_list splits stale sessions into their own section", async () => {
    await findChatTool("chat_register").execute({}, ctx, { sessionID: "ses_split_oc", agent: "build" });
    // A second session whose harness is gone: two missed heartbeats = stale.
    await findChatTool("chat_register").execute({}, ctx, { sessionID: "ses_split_ghost", agent: "build" });
    new Database(dbPath).run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_split_ghost'");
    const list = await findChatTool("chat_list").execute({}, ctx, { sessionID: "ses_split_oc", agent: "build" });
    expect(list).toContain("# Active Sessions");
    expect(list).toContain("# Stale Sessions");
    expect(list).toContain("harnesses may no longer be running");
    const staleSection = list.slice(list.indexOf("# Stale Sessions"));
    expect(staleSection).toContain("ses_split_gh");
    expect(staleSection).not.toContain("ses_split_oc");
  });

  test("chat_list renders the open/recent split as separate sections", async () => {
    await findChatTool("chat_register").execute({}, ctx, { sessionID: "ses_roster_open", agent: "build" });
    await findChatTool("chat_register").execute({}, ctx, { sessionID: "ses_roster_recent", agent: "build" });
    // One of the two carries a tab; the other is a fresh heartbeat with
    // no tab. They land in separate sections: the tabbed row in Active,
    // the tab-less row in Recent (wake not guaranteed, no open tab).
    setOpenTabsFixture(new Set(["ses_roster_open"]));
    const list = await findChatTool("chat_list").execute({}, ctx, { sessionID: "ses_roster_open", agent: "build" });
    expect(list).toContain("# Active Sessions");
    expect(list).toContain("# Recent Sessions");
    // Each section holds exactly its own row (rows render the session id
    // sliced to 12 chars, so the assertions use the same prefix).
    const activeSection = list.slice(0, list.indexOf("# Recent Sessions"));
    const recentSection = list.slice(list.indexOf("# Recent Sessions"));
    expect(activeSection).toContain("ses_roster_o");
    expect(activeSection).not.toContain("ses_roster_r");
    expect(recentSection).toContain("ses_roster_r");
    expect(recentSection).not.toContain("ses_roster_o");
    // The row bodies carry the verdict right after the last-seen age
    // (matched with context - the bare token would also match the legend).
    expect(list).toMatch(/ago open/);
    expect(list).toMatch(/ago recent/);
    expect(list).toContain("Liveness: open = the session has an opencode tab right now");
    // No tab signal at all: everything degrades to recent, never open.
    setOpenTabsFixture(new Set());
    const degraded = await findChatTool("chat_list").execute({}, ctx, { sessionID: "ses_roster_open", agent: "build" });
    expect(degraded).not.toMatch(/ago open/);
  });

  test("chat_send states the recipient's liveness at send time", async () => {
    await findChatTool("chat_register").execute({}, ctx, { sessionID: "ses_snd_to", agent: "build" });
    await findChatTool("chat_register").execute({}, ctx, { sessionID: "ses_snd_from", agent: "build" });
    // send resolves recipients by name OR session id - id keeps this test
    // free of name lookups.
    // OPEN recipient (tab in the fixture): the wake promise stands.
    const fresh = await findChatTool("chat_send").execute(
      { to: "ses_snd_to", body: "ping" },
      ctx,
      { sessionID: "ses_snd_from", agent: "build" },
    );
    expect(fresh).toContain("open (last seen");
    expect(fresh).toContain("will be woken");
    // RECENT recipient (fresh heartbeat, no tab): honest wording - the
    // tab-less wake is NOT guaranteed, replacing the old false promise.
    setOpenTabsFixture(new Set());
    const recent = await findChatTool("chat_send").execute(
      { to: "ses_snd_to", body: "ping" },
      ctx,
      { sessionID: "ses_snd_from", agent: "build" },
    );
    expect(recent).toContain("RECENT");
    expect(recent).toContain("NO OPEN TAB");
    expect(recent).toContain("not guaranteed");
    expect(recent).not.toContain("will be woken");
    new Database(dbPath).run("UPDATE chat_sessions SET last_seen = '2020-01-01T00:00:00Z' WHERE session_id = 'ses_snd_to'");
    const stale = await findChatTool("chat_send").execute(
      { to: "ses_snd_to", body: "ping again" },
      ctx,
      { sessionID: "ses_snd_from", agent: "build" },
    );
    expect(stale).toContain("STALE");
    expect(stale).toContain("no wake will fire");
  });

  test("session_search guards a missing query with a usage line", async () => {
    // A caller that cross-wired another server's search schema (different
    // param name) lands here - usage line, not a raw dereference crash.
    const result = await TOOL_DEFS.find((t) => t.name === "session_search")!.execute({} as any, ctx);
    expect(result).toContain("Usage: session_search");
  });

  test("chat_status states the delivery model per host", async () => {
    await findChatTool("chat_register").execute(
      {},
      ctx,
      { sessionID: "ses_status_oc", agent: "build" },
    );
    const oc = await findChatTool("chat_status").execute({}, ctx, { sessionID: "ses_status_oc", agent: "build" });
    expect(oc).toContain("woken automatically");

    const mcpReg = await findChatTool("chat_register").execute({}, ctx);
    const mcpName = (mcpReg.match(/\[registered\] (.+)/) ?? [])[1]!;
    const mcp = await findChatTool("chat_status").execute({ as: mcpName }, ctx);
    expect(mcp).toContain("at your next prompt");
  });

  test("chat_register MCP reclaim: an existing name resolves to its row; an unknown name is rejected", async () => {
    // The hook-printed identity path: `as` must name an existing row.
    const seed = await findChatTool("chat_register").execute({}, ctx);
    const assigned = (seed.match(/\[registered\] (.+)/) ?? [])[1]!;
    const reclaim = await findChatTool("chat_register").execute({ as: assigned }, ctx);
    expect(reclaim).toContain(`[registered] ${assigned}`);
    expect(reclaim).toContain("already registered");
    // The row keeps its session_id (identity anchoring, not a new mint).
    const status = await findChatTool("chat_status").execute({ as: assigned }, ctx);
    expect(status).toContain("at your next prompt");

    const stale = await findChatTool("chat_register").execute({ as: "nobody-99999" }, ctx);
    expect(stale).toContain("No registered session named");
    expect(stale).toContain("names are assigned by thatch");
  });

  test("chat_unregister tombstones; a rejoin via chat_register clears it and auto-registration resumes", async () => {
    const ocHost = { sessionID: "ses_tomb", agent: "build" };
    await findChatTool("chat_register").execute({}, ctx, ocHost);
    const left = await findChatTool("chat_unregister").execute({}, ctx, ocHost);
    expect(left).toContain("[unregistered]");

    // The tombstone blocks the plugin's idle-path register (same session
    // ID, opencode kind) - this is the production suppression call.
    const blocked = ctx.db.registerChatSession("ses_tomb", ctx.defaultStore, null, "opencode", "tomb");
    expect(blocked.ok).toBe(false);

    // The explicit rejoin (the production line under test) clears the
    // tombstone so auto-registration can resume for this session.
    const rejoin = await findChatTool("chat_register").execute({}, ctx, ocHost);
    expect(rejoin).toContain("[registered]");
    expect(ctx.db.hasChatLeaveTombstone("ses_tomb")).toBe(false);
  });
});

describe("chat config toggle", () => {
  const findToggleTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
  let toggleDir: string;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    toggleDir = mkdtempSync(join(tmpdir(), "thatch-chat-toggle-"));
    prevDbPath = process.env.THATCH_DB_PATH;
    process.env.THATCH_DB_PATH = join(toggleDir, "thatch.db");
  });

  afterEach(() => {
    if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
    else process.env.THATCH_DB_PATH = prevDbPath;
    rmSync(toggleDir, { recursive: true, force: true });
  });

  test("chat tools refuse when chat.enabled is false", async () => {
    saveConfig({ chat: { enabled: false } }, join(toggleDir, "thatch.db"));
    const result = await findToggleTool("chat_register").execute(
      {},
      ctx,
      { sessionID: "ses_toggle_off", agent: "build" },
    );
    expect(result).toContain("[disabled]");
    expect(result).toContain("chat.enabled: false");
  });

  test("chat tools work by default (config unset)", async () => {
    const result = await findToggleTool("chat_register").execute(
      {},
      ctx,
      { sessionID: "ses_toggle_on", agent: "build" },
    );
    expect(result).toMatch(/\[registered\] \S+-\d{5}/);
  });

  test("the identity guard also refuses (chat_status)", async () => {
    await findToggleTool("chat_register").execute(
      {},
      ctx,
      { sessionID: "ses_toggle_status", agent: "build" },
    );
    saveConfig({ chat: { enabled: false } }, join(toggleDir, "thatch.db"));
    const result = await findToggleTool("chat_status").execute({}, ctx, { sessionID: "ses_toggle_status", agent: "build" });
    expect(result).toContain("[disabled]");
  });

  test("config_set manages the chat section and config_get reads it back", async () => {
    const saved = await findToggleTool("config_set").execute({ chat: { enabled: false, autoRegister: false } }, ctx);
    expect(saved).toContain("[saved]");
    expect(saved).toContain("enabled: false");
    expect(saved).toContain("autoRegister: false");
    const read = await findToggleTool("config_get").execute({ section: "chat" }, ctx);
    expect(read).toContain("chat:");
    expect(read).toContain("enabled: false");
    // The render must surface autoRegister: a refactor that drops the
    // field from either schema fails here instead of hiding the knob.
    expect(read).toContain("autoRegister:");
  });
});
