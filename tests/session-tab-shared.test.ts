import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_TAB_RPC,
  TAB_OPENED_EVENT,
  TAB_CLOSED_EVENT,
  buildSubordinatePrompt,
  validateTitle,
  validateLocationArgs,
  isSameMainCheckout,
  isTabOpenedEvent,
  passesDirectoryGuard,
} from "../src/session-tab-shared";
import { TOOL_DEFS } from "../src/tool-defs";
import { ThatchDB } from "../src/db";
import { MockEmbeddingModel } from "./mocks/embeddings";
import { buildCoreContext } from "../src/tool-defs";

// The session-tab feature's shared contract: validators, the prompt
// composition, the rpc definition shape, and the TUI guard logic. Everything
// here runs without a host - the v2 adapter's flow test lives in
// opencode-v2.test.ts (it needs the makeContext double).

describe("session_tab title validation", () => {
  test("accepts a normal task title, trimmed", () => {
    expect(validateTitle("Refine the session-tab plan")).toEqual({ ok: true, title: "Refine the session-tab plan" });
    expect(validateTitle("  padded  ")).toEqual({ ok: true, title: "padded" });
  });

  test("rejects empty and non-string titles", () => {
    expect(validateTitle("").ok).toBe(false);
    expect(validateTitle("   ").ok).toBe(false);
    expect(validateTitle(42).ok).toBe(false);
    expect(validateTitle(undefined).ok).toBe(false);
  });

  test("rejects over-80 titles with the length in the error", () => {
    const result = validateTitle("x".repeat(81));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("81");
    expect(validateTitle("x".repeat(80)).ok).toBe(true);
  });

  test("rejects the machinery title: the auto-register guard would refuse the session", () => {
    const result = validateTitle("thatch-extraction");
    expect(result.ok).toBe(false);
  });
});

describe("session_tab location validation", () => {
  test("neither arg is an error", () => {
    expect(validateLocationArgs({}).ok).toBe(false);
  });

  test("both args is an error", () => {
    expect(validateLocationArgs({ worktree: "/a", directory: "/b" }).ok).toBe(false);
  });

  test("each arg alone resolves to its kind, trimmed", () => {
    expect(validateLocationArgs({ worktree: " /repo/wt " })).toEqual({ ok: true, kind: "worktree", path: "/repo/wt" });
    expect(validateLocationArgs({ directory: " /tmp/scratch " })).toEqual({ ok: true, kind: "directory", path: "/tmp/scratch" });
  });

  test("empty-string args count as absent", () => {
    expect(validateLocationArgs({ worktree: "   " }).ok).toBe(false);
  });
});

describe("buildSubordinatePrompt", () => {
  test("embeds the coordinator name and preserves the task byte-for-byte (dollar signs included)", () => {
    const task = "Run the QA suite. Echo $ARGUMENTS and $$ literally.";
    const prompt = buildSubordinatePrompt("wanda-warpdrive-00009", task);
    expect(prompt.startsWith("Your work session was created by wanda-warpdrive-00009, who is coordinating your actions.")).toBe(true);
    expect(prompt).toContain("supersede the coordinating LLM's.");
    expect(prompt.endsWith(task)).toBe(true);
  });
});

describe("SESSION_TAB_RPC definition", () => {
  test("defines exactly two events with object JSON schemas and no methods", () => {
    expect(SESSION_TAB_RPC.id).toBe("thatch-tabs");
    expect(Object.keys(SESSION_TAB_RPC.methods)).toEqual([]);
    expect(Object.keys(SESSION_TAB_RPC.events).sort()).toEqual([TAB_CLOSED_EVENT, TAB_OPENED_EVENT].sort());
    for (const event of Object.values(SESSION_TAB_RPC.events)) {
      expect((event.schema as any).type).toBe("object");
      expect((event.schema as any).properties).toBeDefined();
      expect((event.schema as any).required).toBeDefined();
    }
  });

  test("tab-closed requires sessionID and the nullable chatName", () => {
    const schema = SESSION_TAB_RPC.events[TAB_CLOSED_EVENT].schema as any;
    expect(schema.properties.chatName.type).toEqual(["string", "null"]);
    expect(schema.required).toEqual(["sessionID", "chatName"]);
  });
});

describe("TUI plugin guard logic", () => {
  test("matches only the fully-qualified tab-opened event type", () => {
    expect(isTabOpenedEvent("rpc.thatch-tabs.tab-opened")).toBe(true);
    expect(isTabOpenedEvent("rpc.thatch-tabs.tab-closed")).toBe(false);
    expect(isTabOpenedEvent("rpc.other.tab-opened")).toBe(false);
    expect(isTabOpenedEvent("session.created")).toBe(false);
    expect(isTabOpenedEvent("tui.session.select")).toBe(false);
  });

  test("directory guard: equality, and missing locations fail closed", () => {
    expect(passesDirectoryGuard("/repo", "/repo")).toBe(true);
    expect(passesDirectoryGuard("/repo", "/other")).toBe(false);
    expect(passesDirectoryGuard(undefined, "/repo")).toBe(false);
    expect(passesDirectoryGuard("/repo", undefined)).toBe(false);
  });
});

describe("isSameMainCheckout", () => {
  let base: string;
  let mainRepo: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "thatch-tab-shared-"));
    mainRepo = join(base, "main");
    mkdirSync(mainRepo);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  async function git(cmd: string, dir: string) {
    const { $ } = await import("bun");
    const proc = await $`git ${cmd.split(" ")}`.cwd(dir).quiet();
    if (proc.exitCode !== 0) throw new Error(`git ${cmd} failed: ${proc.stderr}`);
  }

  async function setupRepoWithWorktree() {
    await git("init", mainRepo);
    await git("config user.email test@example.com", mainRepo);
    await git("config user.name Test", mainRepo);
    writeFileSync(join(mainRepo, ".gitkeep"), "");
    await git("add .gitkeep", mainRepo);
    await git("commit -m init", mainRepo);
    worktree = join(base, "wt-feature");
    await git(`worktree add -b feature ${worktree}`, mainRepo);
  }

  test("a worktree and its main checkout share identity", async () => {
    await setupRepoWithWorktree();
    expect(await isSameMainCheckout(worktree, mainRepo)).toBe(true);
    expect(await isSameMainCheckout(mainRepo, mainRepo)).toBe(true);
  });

  test("different repos do not share identity", async () => {
    await setupRepoWithWorktree();
    const other = join(base, "other");
    mkdirSync(other);
    await git("init", other);
    expect(await isSameMainCheckout(worktree, other)).toBe(false);
  });

  test("a plain non-git directory matches nothing", async () => {
    await setupRepoWithWorktree();
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(await isSameMainCheckout(plain, mainRepo)).toBe(false);
    expect(await isSameMainCheckout(plain, plain)).toBe(false);
  });

  test("survives symlinked paths (macOS /tmp vs /private/tmp)", async () => {
    await setupRepoWithWorktree();
    // mkdtemp under tmpdir() already resolves through /private on macOS;
    // the explicit realpath round-trip pins the convention.
    expect(await isSameMainCheckout(realpathSync(worktree), mainRepo)).toBe(true);
  });
});

describe("session_tab registration invariants", () => {
  test("the def is flagged v2Only only - never also opencodeOnly", () => {
    const def = TOOL_DEFS.find((d) => d.name === "session_tab");
    expect(def).toBeDefined();
    expect(def?.v2Only).toBe(true);
    expect(def?.opencodeOnly).toBeUndefined();
  });

  test("the execute refuses when no host session context is supplied", async () => {
    const def = TOOL_DEFS.find((d) => d.name === "session_tab")!;
    let dbDir = mkdtempSync(join(tmpdir(), "thatch-session-tab-"));
    const db = new ThatchDB(join(dbDir, "test.db"));
    const ctx = buildCoreContext(db, new MockEmbeddingModel(), "test-owner/test-repo");
    const result = await def.execute({ prompt: "p", title: "t" }, ctx, undefined);
    expect(result).toContain("unavailable");
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test("the execute refuses when the host wired no sessionTabHost seam", async () => {
    const def = TOOL_DEFS.find((d) => d.name === "session_tab")!;
    let dbDir = mkdtempSync(join(tmpdir(), "thatch-session-tab-"));
    const db = new ThatchDB(join(dbDir, "test.db"));
    const ctx = buildCoreContext(db, new MockEmbeddingModel(), "test-owner/test-repo");
    const result = await def.execute({ prompt: "p", title: "t", directory: "/tmp" }, ctx, {
      sessionID: "ses_test",
      agent: "build",
    });
    expect(result).toContain("did not wire the session-tab surface");
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });
});

describe("package exports map", () => {
  test("resolves both the root entry and the TUI entrypoint, and both exist on disk", async () => {
    // Regression guard: package.json had NO exports field before this
    // feature, and an exports map without "." would break the bare-specifier
    // npm install path (plugins: ["@jeffober/thatch"]). The QA suite bypasses
    // package resolution (absolute-path shims), so this test is the only net.
    const root = join(import.meta.dir, "..");
    const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text());
    expect(pkg.exports["."]).toBe("./src/index.ts");
    expect(pkg.exports["./tui"]).toBe("./src/opencode/tui-plugin.ts");
    for (const file of [pkg.exports["."], pkg.exports["./tui"], pkg.main]) {
      expect(await Bun.file(join(root, file as string)).exists()).toBe(true);
    }
  });
});
