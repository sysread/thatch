import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commonFindings,
  opencodeFindings,
  claudeFindings,
  cursorFindings,
  collectDoctorFindings,
  doctorExitCode,
  type DoctorDb,
  type DoctorDeps,
  type DoctorFinding,
} from "../src/doctor";
import { setupClaudeCode, setupClaudePluginRegime, setupCursor } from "../src/setup";
import { writeRegimeMarker, stampModLiveness, modLivenessPath, npmCachePath } from "../src/version-check";
import { THATCH_BEGIN, THATCH_END } from "../src/setup";
import pkg from "../package.json";

// A dedicated throwaway environment per test: the doctor reads HOME,
// XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, and CURSOR_CONFIG_DIR through the
// same resolvers setup uses, and a leaked real-machine value (Jeff's
// machine sets a custom claude config dir) would read REAL install state.
const SAVED_ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "THATCH_DB_PATH"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let home: string;
let proj: string;
let dbPath: string;

const stubDb: DoctorDb = {
  listStores: () => ["global", "acme/payments"],
  listChatSessions: () => [],
};

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    db: stubDb,
    dbPath,
    projectDir: proj,
    home,
    now: Date.now(),
    claudeVersionOutput: () => null,
    claudeMcpGetThatch: async () => ({ exitCode: 1 }),
    opencodeVersion: () => "opencode 2.2.5",
    ...overrides,
  };
}

function byCheck(findings: DoctorFinding[], check: string): DoctorFinding[] {
  return findings.filter((f) => f.check === check);
}

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) saved[key] = process.env[key];
  base = mkdtempSync(join(tmpdir(), "thatch-doctor-"));
  home = join(base, "home");
  proj = join(base, "proj");
  dbPath = join(base, "thatch.db");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(base, "config");
  process.env.CLAUDE_CONFIG_DIR = join(base, "claude-config");
  process.env.CURSOR_CONFIG_DIR = join(base, "cursor-config");
  process.env.THATCH_DB_PATH = dbPath;
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

describe("common findings", () => {
  test("a reachable database passes with the store count", () => {
    const f = byCheck(commonFindings(deps()), "database");
    expect(f).toHaveLength(1);
    expect(f[0]!.verdict).toBe("pass");
    expect(f[0]!.detail).toContain("reachable");
    expect(f[0]!.detail).toContain("2 stores");
  });

  test("an unreadable database fails with a fix", () => {
    const d = deps({ db: { listStores: () => { throw new Error("locked"); }, listChatSessions: () => [] } });
    const f = byCheck(commonFindings(d), "database");
    expect(f[0]!.verdict).toBe("fail");
    expect(f[0]!.detail).toContain("locked");
    expect(f[0]!.fix).toBeTruthy();
  });

  test("no npm cache yet is info, not a warning", () => {
    const f = byCheck(commonFindings(deps()), "update");
    expect(f[0]!.verdict).toBe("info");
    expect(f[0]!.detail).toContain("no npm update check has run yet");
  });

  test("a current cached version passes naming the check age", () => {
    mkdirSync(join(npmCachePath(dbPath), ".."), { recursive: true });
    writeFileSync(npmCachePath(dbPath), JSON.stringify({ version: pkg.version, checkedAt: Date.now() - 60_000 }), "utf-8");
    const f = byCheck(commonFindings(deps()), "update");
    expect(f[0]!.verdict).toBe("pass");
    expect(f[0]!.detail).toContain(`v${pkg.version}, the latest known`);
  });

  test("a newer cached version warns with the update fix", () => {
    const newer = pkg.version.split(".").map(Number);
    newer[2] = (newer[2] ?? 0) + 1;
    mkdirSync(join(npmCachePath(dbPath), ".."), { recursive: true });
    writeFileSync(npmCachePath(dbPath), JSON.stringify({ version: newer.join("."), checkedAt: Date.now() }), "utf-8");
    const f = byCheck(commonFindings(deps()), "update");
    expect(f[0]!.verdict).toBe("warn");
    expect(f[0]!.fix).toContain("npm update");
  });
});

describe("opencode findings", () => {
  function writeDirShim(target: string, opts: { tui?: boolean } = {}): void {
    const shimDir = join(process.env.XDG_CONFIG_HOME!, "opencode", "plugins", "thatch");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "index.ts"), `export { default } from ${JSON.stringify(target)};\n`, "utf-8");
    if (opts.tui !== false) {
      writeFileSync(join(shimDir, "tui.ts"), `export { default } from ${JSON.stringify(target.replace(/index$/, "opencode/tui-plugin"))};\n`, "utf-8");
    }
  }

  test("a fully absent opencode collapses to one not-detected line", () => {
    const f = opencodeFindings(deps({ opencodeVersion: () => null }));
    expect(f).toHaveLength(1);
    expect(f[0]!.verdict).toBe("info");
    expect(f[0]!.detail).toContain("not detected");
  });

  test("the binary check parses the version and compares the floor", () => {
    const f = byCheck(opencodeFindings(deps()), "binary");
    expect(f[0]!.verdict).toBe("pass");
    expect(f[0]!.detail).toContain("2.2.5");
    const old = byCheck(opencodeFindings(deps({ opencodeVersion: () => "opencode 1.18.2" })), "binary");
    expect(old[0]!.verdict).toBe("warn");
    expect(old[0]!.detail).toContain("predates");
  });

  test("a package entry in a config file is detected (JSONC-safe substring scan)", () => {
    const ocDir = join(process.env.XDG_CONFIG_HOME!, "opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(join(ocDir, "opencode.jsonc"), `{ "plugin": ["@jeffober/thatch"] }`, "utf-8");
    const f = byCheck(opencodeFindings(deps()), "install");
    expect(f[0]!.verdict).toBe("pass");
    expect(f[0]!.detail).toContain("opencode.jsonc");
  });

  test("a coexisting file and directory shim fails (duplicate plugin id)", () => {
    writeDirShim(join(base, "checkout", "src", "index"));
    const pluginsDir = join(process.env.XDG_CONFIG_HOME!, "opencode", "plugins");
    writeFileSync(join(pluginsDir, "thatch.ts"), `export { default } from "x";\n`, "utf-8");
    const f = byCheck(opencodeFindings(deps()), "shim");
    expect(f[0]!.verdict).toBe("fail");
    expect(f[0]!.detail).toContain("duplicate plugin id");
    expect(f[0]!.fix).toContain("delete");
  });

  test("a shim pointing at this checkout passes with its version", () => {
    const repoRoot = join(import.meta.dir, "..");
    writeDirShim(join(repoRoot, "src", "index"));
    const f = byCheck(opencodeFindings(deps()), "shim");
    expect(f[0]!.verdict).toBe("pass");
    expect(f[0]!.detail).toContain(`v${pkg.version}`);
  });

  test("a shim pointing at a deleted checkout fails", () => {
    writeDirShim(join(base, "gone", "src", "index"));
    const f = byCheck(opencodeFindings(deps()), "shim");
    expect(f[0]!.verdict).toBe("fail");
    expect(f[0]!.detail).toContain("no longer exists");
  });

  test("a directory shim without tui.ts warns about tabs, not loading", () => {
    const repoRoot = join(import.meta.dir, "..");
    writeDirShim(join(repoRoot, "src", "index"), { tui: false });
    const f = byCheck(opencodeFindings(deps()), "shim");
    expect(f[0]!.verdict).toBe("warn");
    expect(f[0]!.detail).toContain("session tabs will not open");
  });

  test("a pre-2.x shim re-exporting the named server export fails", () => {
    const shimDir = join(process.env.XDG_CONFIG_HOME!, "opencode", "plugins", "thatch");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "index.ts"), `export { server } from "/gone/src/index";\n`, "utf-8");
    const f = byCheck(opencodeFindings(deps()), "shim");
    // The missing-tui warn may precede it; the link failure is the finding
    // that matters.
    expect(f.some((x) => x.verdict === "fail" && x.detail.includes("fails to link"))).toBe(true);
  });

  test("a shim targeting a different version warns about drift", () => {
    const checkout = join(base, "other-checkout");
    mkdirSync(join(checkout, "src"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "0.0.1" }), "utf-8");
    writeFileSync(join(checkout, "src", "index.ts"), `export const id = "thatch";\n`, "utf-8");
    writeDirShim(join(checkout, "src", "index"));
    const f = byCheck(opencodeFindings(deps()), "shim");
    expect(f[0]!.verdict).toBe("warn");
    expect(f[0]!.detail).toContain("v0.0.1");
    expect(f[0]!.detail).toContain(`v${pkg.version}`);
  });

  test("a fresh opencode heartbeat is daemon evidence", () => {
    const now = Date.now();
    const d = deps({
      now,
      db: { listStores: () => [], listChatSessions: () => [{ name: "al-go-rithm-00001", host_kind: "opencode", last_seen: new Date(now - 5_000).toISOString() }] },
    });
    const f = byCheck(opencodeFindings(d), "daemon");
    expect(f[0]!.verdict).toBe("pass");
    expect(f[0]!.detail).toContain("al-go-rithm-00001");
  });

  test("no fresh heartbeat is info, never proof the plugin is unloaded", () => {
    const now = Date.now();
    const stale = byCheck(
      opencodeFindings(deps({
        now,
        db: { listStores: () => [], listChatSessions: () => [{ name: "x", host_kind: "opencode", last_seen: new Date(now - 3_600_000).toISOString() }] },
      })),
      "daemon",
    );
    expect(stale[0]!.verdict).toBe("info");
    const empty = byCheck(opencodeFindings(deps()), "daemon");
    expect(empty[0]!.verdict).toBe("info");
    expect(empty[0]!.detail).toContain("not proof the plugin is unloaded");
  });
});

describe("claude findings", () => {
  test("a fully absent claude collapses to one not-detected line plus the legacy check", async () => {
    const f = await claudeFindings(deps());
    expect(f).toHaveLength(2);
    expect(f[0]!.verdict).toBe("info");
    expect(f[0]!.detail).toContain("not detected");
    expect(byCheck(f, "legacy block")).toHaveLength(1);
  });

  test("claude present but never set up reports binary, floor, and the not-installed info", async () => {
    const f = await claudeFindings(deps({ claudeVersionOutput: () => "2.1.319 (Claude Code)" }));
    expect(byCheck(f, "binary")[0]!.verdict).toBe("pass");
    expect(byCheck(f, "mods floor")[0]!.verdict).toBe("pass");
    expect(byCheck(f, "install")[0]!.verdict).toBe("info");
  });

  test("an orphaned regime marker (no plugin dir) fails with both repair paths", async () => {
    writeRegimeMarker(dbPath, "plugin");
    const f = await claudeFindings(deps());
    const regime = byCheck(f, "regime");
    expect(regime[0]!.verdict).toBe("fail");
    expect(regime[0]!.detail).toContain("no plugin directory exists");
    expect(regime[0]!.fix).toContain("thatch setup --claude --hooks");
  });

  test("a healthy generated plugin regime passes regime and tree, and pings never as expected", async () => {
    const checkoutBin = join(import.meta.dir, "..", "bin", "thatch");
    const result = await setupClaudePluginRegime(checkoutBin, true, proj, home);
    writeRegimeMarker(dbPath, "plugin");
    const f = await claudeFindings(deps({ claudeVersionOutput: () => "2.1.319 (Claude Code)" }));
    const regime = byCheck(f, "regime");
    expect(regime[0]!.verdict).toBe("pass");
    expect(regime[0]!.detail).toContain(result.pluginDir);
    const tree = byCheck(f, "plugin tree");
    expect(tree[0]!.verdict).toBe("pass");
    expect(tree[0]!.detail).toContain("consistent");
    const ping = byCheck(f, "ping");
    expect(ping[0]!.verdict).toBe("warn");
    expect(ping[0]!.detail).toContain("never pinged");
    expect(ping[0]!.fix).toContain("claude --plugin-dir");
  });

  test("a fresh ping passes and a stale ping warns with the three readings", async () => {
    const checkoutBin = join(import.meta.dir, "..", "bin", "thatch");
    await setupClaudePluginRegime(checkoutBin, true, proj, home);
    writeRegimeMarker(dbPath, "plugin");
    stampModLiveness(dbPath);
    const fresh = byCheck(await claudeFindings(deps()), "ping");
    expect(fresh[0]!.verdict).toBe("pass");
    expect(fresh[0]!.detail).toContain("delivering");

    const now = Date.now();
    mkdirSync(join(modLivenessPath(dbPath), ".."), { recursive: true });
    writeFileSync(modLivenessPath(dbPath), String(now - 31 * 60 * 1000), "utf-8");
    const stale = byCheck(await claudeFindings(deps({ now })), "ping");
    expect(stale[0]!.verdict).toBe("warn");
    expect(stale[0]!.detail).toContain("expected when claude is not running");
    expect(stale[0]!.detail).toContain("disableAllHooks");
  });

  test("a mixed-source manifest (server tree lacks src/claude-plugin) fails", async () => {
    const pluginDir = join(process.env.CLAUDE_CONFIG_DIR!, "thatch-plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "thatch", version: pkg.version, mcpServers: { thatch: { type: "stdio", command: "/bin/sh", args: ["mcp", "--bundled"] } } }), "utf-8");
    writeFileSync(join(pluginDir, "hooks", "mod.js"), "built\n", "utf-8");
    writeRegimeMarker(dbPath, "plugin");
    const f = await claudeFindings(deps());
    const tree = byCheck(f, "plugin tree");
    expect(tree[0]!.verdict).toBe("fail");
    expect(tree[0]!.detail).toContain("mixed-source");
  });

  test("a deleted server tree fails and still reports the ping", async () => {
    const pluginDir = join(process.env.CLAUDE_CONFIG_DIR!, "thatch-plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "thatch", version: pkg.version, mcpServers: { thatch: { type: "stdio", command: join(base, "gone", "bin", "thatch"), args: ["mcp", "--bundled"] } } }), "utf-8");
    writeRegimeMarker(dbPath, "plugin");
    stampModLiveness(dbPath);
    const f = await claudeFindings(deps());
    expect(byCheck(f, "plugin tree")[0]!.verdict).toBe("fail");
    expect(byCheck(f, "ping")).toHaveLength(1);
  });

  test("fallback writers surviving the plugin regime each warn", async () => {
    const checkoutBin = join(import.meta.dir, "..", "bin", "thatch");
    await setupClaudePluginRegime(checkoutBin, true, proj, home);
    writeRegimeMarker(dbPath, "plugin");
    // A settings hook that survived the deactivation sweep.
    const settings = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
    writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/thatch flush-tools" }] }] } }), "utf-8");
    // A standalone .mcp.json entry that survived.
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { thatch: { type: "stdio", command: "/usr/local/bin/thatch", args: ["mcp"] } } }), "utf-8");
    const f = await claudeFindings(deps());
    const writers = byCheck(f, "fallback writers");
    expect(writers).toHaveLength(2);
    expect(writers.every((w) => w.verdict === "warn")).toBe(true);
    // The user-scope probe (injected: a registration exists) is the third.
    const f2 = await claudeFindings(deps({ claudeVersionOutput: () => "2.1.319 (Claude Code)", claudeMcpGetThatch: async () => ({ exitCode: 0 }) }));
    const writers2 = byCheck(f2, "fallback writers");
    expect(writers2).toHaveLength(3);
    expect(writers2.some((w) => w.fix === "claude mcp remove thatch")).toBe(true);
  });

  test("a claude below the mods floor with a plugin marker fails the regime as impossible", async () => {
    const pluginDir = join(process.env.CLAUDE_CONFIG_DIR!, "thatch-plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "thatch", version: pkg.version, mcpServers: { thatch: { type: "stdio", command: "/bin/sh", args: ["mcp", "--bundled"] } } }), "utf-8");
    writeRegimeMarker(dbPath, "plugin");
    const f = await claudeFindings(deps({ claudeVersionOutput: () => "1.0.5 (Claude Code)" }));
    expect(byCheck(f, "mods floor")[0]!.verdict).toBe("warn");
    const regime = f.filter((x) => x.check === "regime");
    expect(regime.some((r) => r.verdict === "fail" && r.detail.includes("can never load"))).toBe(true);
  });

  test("the hooks regime reports installed markers and hooks", async () => {
    await setupClaudeCode(join(base, "bin", "thatch"), false, proj, home);
    const f = await claudeFindings(deps());
    expect(byCheck(f, "install")[0]!.verdict).toBe("pass");
    expect(byCheck(f, "install")[0]!.detail).toContain("hooks regime installed");
    expect(byCheck(f, "hooks")[0]!.verdict).toBe("pass");
  });

  test("broken instruction markers fail with the rewrite fix", async () => {
    await setupClaudeCode(join(base, "bin", "thatch"), false, proj, home);
    const md = join(proj, "CLAUDE.md");
    const body = (await import("node:fs")).readFileSync(md, "utf8").replace(THATCH_END, "");
    (await import("node:fs")).writeFileSync(md, body, "utf8");
    const f = await claudeFindings(deps());
    const install = byCheck(f, "install");
    expect(install[0]!.verdict).toBe("fail");
    expect(install[0]!.detail).toContain("corrupted");
    expect(install[0]!.fix).toContain("thatch setup --claude");
  });

  test("markers without hooks warn that nudges never fire", async () => {
    await setupClaudeCode(join(base, "bin", "thatch"), false, proj, home);
    rmSync(join(proj, ".claude", "settings.json"), { force: true });
    const f = await claudeFindings(deps());
    const hooks = byCheck(f, "hooks");
    expect(hooks[0]!.verdict).toBe("warn");
    expect(hooks[0]!.detail).toContain("no thatch hooks are registered");
  });

  test("a plugin directory without the marker warns about ambiguity", async () => {
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "thatch-plugin"), { recursive: true });
    const f = await claudeFindings(deps());
    const regime = byCheck(f, "regime");
    expect(regime[0]!.verdict).toBe("warn");
    expect(regime[0]!.detail).toContain("ambiguous");
  });

  test("a legacy thatch block at ~/CLAUDE.md warns", async () => {
    writeFileSync(join(home, "CLAUDE.md"), `# Notes\n\n${THATCH_BEGIN}\nold instructions\n${THATCH_END}\n`, "utf-8");
    const f = await claudeFindings(deps());
    const legacy = byCheck(f, "legacy block");
    expect(legacy[0]!.verdict).toBe("warn");
    expect(legacy[0]!.detail).toContain(join(home, "CLAUDE.md"));
  });
});

describe("cursor findings", () => {
  test("a fully absent cursor collapses to one not-detected line", () => {
    const f = cursorFindings(deps());
    expect(f).toHaveLength(1);
    expect(f[0]!.verdict).toBe("info");
    expect(f[0]!.detail).toContain("not detected");
  });

  test("a cursor setup reports install, markers, and hooks as pass", async () => {
    await setupCursor(join(base, "bin", "thatch"), false, proj, home);
    const f = cursorFindings(deps());
    expect(byCheck(f, "install")[0]!.verdict).toBe("pass");
    expect(byCheck(f, "markers")[0]!.verdict).toBe("pass");
    expect(byCheck(f, "hooks")[0]!.verdict).toBe("pass");
  });

  test("broken cursor markers fail with the rewrite fix", async () => {
    await setupCursor(join(base, "bin", "thatch"), false, proj, home);
    const md = join(proj, "AGENTS.md");
    const fs = await import("node:fs");
    const body = fs.readFileSync(md, "utf8").replace(THATCH_END, "");
    fs.writeFileSync(md, body, "utf8");
    const f = cursorFindings(deps());
    const markers = byCheck(f, "markers");
    expect(markers[0]!.verdict).toBe("fail");
    expect(markers[0]!.fix).toContain("thatch setup --cursor");
  });

  test("markers without cursor hooks warn that nudges never fire", async () => {
    await setupCursor(join(base, "bin", "thatch"), false, proj, home);
    rmSync(join(proj, ".cursor", "hooks.json"), { force: true });
    const f = cursorFindings(deps());
    const hooks = byCheck(f, "hooks");
    expect(hooks[0]!.verdict).toBe("warn");
    expect(hooks[0]!.detail).toContain("no thatch hooks are registered");
  });
});

describe("assembly and exit code", () => {
  test("collectDoctorFindings orders the sections and includes every host", async () => {
    const f = await collectDoctorFindings(deps());
    const sections = [...new Set(f.map((x) => x.section))];
    expect(sections).toEqual(["common", "opencode", "claude", "cursor"]);
  });

  test("exit code is 1 only when a finding failed; warnings never fail", () => {
    expect(doctorExitCode([{ section: "common", check: "x", verdict: "warn", detail: "" }])).toBe(0);
    expect(doctorExitCode([{ section: "common", check: "x", verdict: "info", detail: "" }])).toBe(0);
    expect(doctorExitCode([{ section: "common", check: "x", verdict: "fail", detail: "" }])).toBe(1);
    expect(doctorExitCode([])).toBe(0);
  });

  test("the read-only contract: no check writes to disk", async () => {
    const before = existsSync(join(base, "sentinel"));
    await collectDoctorFindings(deps());
    expect(existsSync(join(base, "sentinel"))).toBe(before);
  });
});
