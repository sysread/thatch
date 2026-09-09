import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendNotification, spokenText, defaultSpawner, type Spawner, type SpawnResult } from "../src/notify";
import { saveConfig } from "../src/config";
import { TOOL_DEFS, type CoreContext } from "../src/tool-defs";

// All command execution goes through an injectable spawner, so no test ever
// fires a real banner or speaks out loud.
function mockSpawner(
  results: Map<string, SpawnResult>,
  recorded: string[] = [],
): Spawner {
  return async (cmd) => {
    recorded.push(cmd.join(" "));
    for (const [needle, result] of results) {
      if (cmd.join(" ").includes(needle)) return result;
    }
    return { exitCode: 0, stderr: "" };
  };
}

describe("spokenText", () => {
  test("prefixes the source label", () => {
    expect(spokenText({ message: "CI is green", source: "PLAT-280" })).toBe("PLAT-280: CI is green");
  });

  test("no source, no prefix", () => {
    expect(spokenText({ message: "CI is green" })).toBe("CI is green");
  });
});

describe("sendNotification on darwin", () => {
  test("both channels: osascript banner then say voice", async () => {
    const cmds: string[] = [];
    const result = await sendNotification({
      message: "C I is green",
      source: "PLAT-280",
      channel: "both",
      platform: "darwin",
    }, mockSpawner(new Map(), cmds));
    expect(cmds.length).toBe(2);
    expect(cmds[0]).toContain("/usr/bin/osascript");
    expect(cmds[0]).toContain('display notification "C I is green"');
    expect(cmds[0]).toContain('with title "PLAT-280"');
    expect(cmds[0]).toContain('sound name "Submarine"');
    expect(cmds[1]).toContain("/usr/bin/say -v Zarvox PLAT-280: C I is green");
    expect(result).toBe("[notified] banner (osascript) ok; voice (Zarvox) ok");
  });

  test("escapes quotes and backslashes in the AppleScript literal", async () => {
    const cmds: string[] = [];
    await sendNotification({
      message: 'say "hi" \\ now',
      channel: "banner",
      platform: "darwin",
    }, mockSpawner(new Map(), cmds));
    expect(cmds[0]).toContain('display notification "say \\"hi\\" \\\\ now"');
  });

  test("banner-only channel skips say", async () => {
    const cmds: string[] = [];
    const result = await sendNotification({ message: "m", channel: "banner", platform: "darwin" }, mockSpawner(new Map(), cmds));
    expect(cmds.length).toBe(1);
    expect(result).toContain("banner (osascript) ok");
  });

  test("voice-only channel skips osascript and honors the voice override", async () => {
    const cmds: string[] = [];
    await sendNotification({ message: "m", channel: "voice", voice: "Fred", platform: "darwin" }, mockSpawner(new Map(), cmds));
    expect(cmds.length).toBe(1);
    expect(cmds[0]).toContain("/usr/bin/say -v Fred m");
  });

  test("custom sound override", async () => {
    const cmds: string[] = [];
    await sendNotification({ message: "m", channel: "banner", sound: "Ping", platform: "darwin" }, mockSpawner(new Map(), cmds));
    expect(cmds[0]).toContain('sound name "Ping"');
  });

  test("say failure is reported but does not hide the banner success", async () => {
    const spawner = mockSpawner(new Map([["/usr/bin/say", { exitCode: 1, stderr: "Invalid voice" }]]));
    const result = await sendNotification({ message: "m", channel: "both", platform: "darwin" }, spawner);
    expect(result).toContain("[notified]");
    expect(result).toContain("voice (Zarvox) failed: exited 1: Invalid voice");
  });

  test("every channel failing yields [failed]", async () => {
    const spawner = mockSpawner(new Map([["", { exitCode: 1, stderr: "boom" }]]));
    const result = await sendNotification({ message: "m", channel: "both", platform: "darwin" }, spawner);
    expect(result.startsWith("[failed]")).toBe(true);
    expect(result).toContain("banner");
    expect(result).toContain("voice");
  });
});

describe("sendNotification on linux", () => {
  test("banner uses notify-send", async () => {
    const cmds: string[] = [];
    const result = await sendNotification({ message: "deployed", title: "thatch", channel: "banner", platform: "linux" }, mockSpawner(new Map(), cmds));
    expect(cmds[0]).toBe("notify-send thatch deployed");
    expect(result).toContain("banner (notify-send) ok");
  });

  test("voice override goes to espeak -v", async () => {
    const cmds: string[] = [];
    await sendNotification({ message: "deployed", channel: "voice", voice: "en-GB", platform: "linux" }, mockSpawner(new Map(), cmds));
    expect(cmds[0]).toBe("espeak -v en-GB deployed");
  });

  test("no voice override tries spd-say first, espeak on failure", async () => {
    const cmds: string[] = [];
    const spawner = mockSpawner(new Map([["spd-say", { exitCode: 127, stderr: "" }]]), cmds);
    const result = await sendNotification({ message: "deployed", channel: "voice", platform: "linux" }, spawner);
    expect(cmds[0]).toContain("spd-say -w deployed");
    expect(cmds[1]).toBe("espeak deployed");
    expect(result).toContain("voice (espeak) ok");
  });
});

describe("sendNotification on unsupported platforms", () => {
  test("win32 is reported, not attempted", async () => {
    const cmds: string[] = [];
    const result = await sendNotification({ message: "m", channel: "both", platform: "win32" }, mockSpawner(new Map(), cmds));
    expect(cmds.length).toBe(0);
    expect(result).toContain("[unsupported]");
    expect(result).toContain("win32");
  });
});

// Tool-level tests. config_get / config_set / notify_user resolve the config
// file from THATCH_DB_PATH, so point that at a tempdir to keep the
// developer's real ~/.config/thatch out of the tests.
describe("config and notify tool execute functions", () => {
  let dbDir: string;
  let prevDbPath: string | undefined;
  let ctx: CoreContext;
  let recorded: string[];

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "thatch-notify-tool-test-"));
    prevDbPath = process.env.THATCH_DB_PATH;
    process.env.THATCH_DB_PATH = join(dbDir, "thatch.db");
    recorded = [];
    ctx = {
      db: {} as CoreContext["db"],
      model: {} as CoreContext["model"],
      defaultStore: "test-owner/test-repo",
      spawner: mockSpawner(new Map(), recorded),
    };
  });

  afterEach(() => {
    if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
    else process.env.THATCH_DB_PATH = prevDbPath;
    rmSync(dbDir, { recursive: true, force: true });
  });

  test("config_get shows unset fields with defaults", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "config_get")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("notifications:");
    expect(result).toContain("mode: <unset> (default: both)");
    expect(result).toContain(`file: ${join(dbDir, "config.json")}`);
  });

  test("config_set merges fields without wiping siblings and echoes the result", async () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ notifications: { mode: "banner" } }, dbPath);
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ notifications: { voice: "Fred" } }, ctx);
    expect(result).toContain("[saved]");
    expect(result).toContain("mode: banner");
    expect(result).toContain("voice: Fred");
    const written = JSON.parse(readFileSync(join(dbDir, "config.json"), "utf8"));
    expect(written.notifications).toEqual({ mode: "banner", voice: "Fred" });
  });

  test("config_set with no section reports nothing to update", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("Nothing to update");
    expect(recorded.length).toBe(0);
  });

  test("notify_user no-ops when the configured mode is none", async () => {
    saveConfig({ notifications: { mode: "none" } }, join(dbDir, "thatch.db"));
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    const result = await def.execute({ message: "hello" }, ctx);
    expect(result).toContain("[skipped]");
    expect(result).toContain("mode: none");
    expect(recorded.length).toBe(0);
  });

  test("notify_user honors the configured voice", async () => {
    if (process.platform !== "darwin") return; // command construction is platform-specific
    saveConfig({ notifications: { voice: "Bad News" } }, join(dbDir, "thatch.db"));
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    await def.execute({ message: "done", channel: "voice" }, ctx);
    expect(recorded[0]).toContain("/usr/bin/say -v Bad News done");
  });

  test("notify_user defaults to both channels and prefixes the source", async () => {
    if (process.platform !== "darwin") return; // command construction is platform-specific
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    const result = await def.execute({ message: "deployed", source: "thatch-notify" }, ctx);
    expect(recorded.length).toBe(2);
    expect(recorded[0]).toContain("/usr/bin/osascript");
    expect(recorded[0]).toContain('with title "thatch-notify"');
    expect(recorded[1]).toContain("/usr/bin/say -v Zarvox thatch-notify: deployed");
    expect(result).toContain("[notified]");
  });
});

describe("defaultSpawner", () => {
  test("captures exit code and stderr of a real command", async () => {
    const result = await defaultSpawner(["/usr/bin/false"]);
    expect(result.exitCode).not.toBe(0);
  });
});
