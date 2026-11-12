import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendNotification, notifySuppressed, spokenText, applyTonePrefix, capSpokenLine, capSourceLabel, SPOKEN_LINE_MAX, defaultSpawner, terminalNotifierAvailable, type NotifyJournalEntry, type Spawner, type SpawnResult } from "../src/notify";
import { ThatchDB } from "../src/db";
import { saveConfig } from "../src/config";
import { TOOL_DEFS, type CoreContext } from "../src/tool-defs";

// The suite bootstrap (tests/clean-env.ts) forces THATCH_NO_NOTIFY=1 so no
// test can fire a real banner or speak. These tests exercise the dispatcher
// composition itself through an injected spawner, which the guard would
// no-op - so the guard is lifted for this file and restored after (bun
// shares one process across all test files; other files keep the guard).
let prevNoNotify: string | undefined;
beforeAll(() => {
  prevNoNotify = process.env.THATCH_NO_NOTIFY;
  delete process.env.THATCH_NO_NOTIFY;
});
afterAll(() => {
  if (prevNoNotify !== undefined) process.env.THATCH_NO_NOTIFY = prevNoNotify;
});

// All command execution goes through an injectable spawner, so no test ever
// fires a real banner or speaks out loud.
function mockSpawner(
  results: Map<string, SpawnResult>,
  recorded: string[] = [],
): Spawner {
  return async (cmd) => {
    // The terminal-notifier PATH probe (src/notify.ts) answers ABSENT by
    // default and is never recorded: recorded[] documents delivery
    // commands, and this machine has no terminal-notifier installed - so
    // the default mock reproduces the binary-absent osascript path the
    // existing assertions pin. A test that wants the terminal-notifier
    // branch puts an exit-0 result under the "/usr/bin/which" needle.
    if (cmd[0] === "/usr/bin/which") {
      return results.get("/usr/bin/which") ?? { exitCode: 1, stderr: "" };
    }
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

describe("applyTonePrefix", () => {
  test("positive prepends Amaze! Amaze!", () => {
    expect(applyTonePrefix("C I is green", "positive")).toBe("Amaze! Amaze! C I is green");
  });

  test("negative prepends Sad sad sad", () => {
    expect(applyTonePrefix("C I is red", "negative")).toBe("Sad sad sad C I is red");
  });

  test("neutral prepends nothing", () => {
    expect(applyTonePrefix("deployed", "neutral")).toBe("deployed");
    expect(applyTonePrefix("deployed", undefined)).toBe("deployed");
  });

  test("a hand-composed same-tone prefix is normalized, not doubled", () => {
    // The tool owns the prefix: a hand-composed one (any case) is
    // stripped and the canonical form applied.
    expect(applyTonePrefix("Amaze! Amaze! C I is green", "positive")).toBe("Amaze! Amaze! C I is green");
    expect(applyTonePrefix("amaze! amaze! C I is green", "positive")).toBe("Amaze! Amaze! C I is green");
  });

  test("a prefix glued to the message (no trailing space) is not stripped", () => {
    // The strip requires the boundary (whitespace or end) after the
    // prefix: "Amaze! Amaze!C" cannot be told apart from a message whose
    // own first word starts with the prefix's letters, and the boundary
    // rule protects the genuine message. The glued case reads doubled -
    // the cost of the boundary rule; the tool description tells models
    // not to compose prefixes at all.
    expect(applyTonePrefix("Amaze! Amaze!C I is green", "positive")).toBe(
      "Amaze! Amaze! Amaze! Amaze!C I is green",
    );
  });

  test("strips a cross-tone hand-composed prefix too", () => {
    // A model that composes the OTHER tone's prefix gets it stripped: the
    // tool owns all prefixes, and the passed tone is authoritative.
    expect(applyTonePrefix("Sad sad sad C I is red", "positive")).toBe("Amaze! Amaze! C I is red");
    expect(applyTonePrefix("Amaze! Amaze! C I is green", "negative")).toBe("Sad sad sad C I is green");
  });

  test("does not bite a word that merely starts with the prefix", () => {
    // The strip requires the prefix to be followed by whitespace or the
    // end of the message. "sad sad sadly" is a genuine message starting
    // with prefix-like words - the strip leaves it whole, and the
    // canonical prefix prepends verbatim (prefix + message is the
    // contract; the alternative, cutting mid-word, would mangle prose).
    expect(applyTonePrefix("sad sad sadly, this failed", "negative")).toBe(
      "Sad sad sad sad sad sadly, this failed",
    );
    expect(applyTonePrefix("amazed at the results", "positive")).toBe("Amaze! Amaze! amazed at the results");
  });
});

describe("capSpokenLine", () => {
  test("a line under the budget passes through unchanged", () => {
    expect(capSpokenLine("P L A T 2 8 0: C I is green")).toBe("P L A T 2 8 0: C I is green");
  });

  test("a line over the budget is cut to the cap at a word boundary, no ellipsis", () => {
    const long = "word ".repeat(60).trim(); // 299 chars after trim
    const capped = capSpokenLine(long);
    expect(capped.length).toBeLessThanOrEqual(SPOKEN_LINE_MAX);
    // No ellipsis: spoken punctuation for a truncation marker is an
    // unverified TTS behavior, and an attention line does not need one.
    expect(capped.endsWith("...")).toBe(false);
    expect(capped).not.toContain("...");
  });

  test("the cut prefers a word boundary", () => {
    const long = `${"word ".repeat(40)}tail`;
    const capped = capSpokenLine(long);
    expect(capped.length).toBeLessThanOrEqual(SPOKEN_LINE_MAX);
    expect(capped.endsWith("word")).toBe(true);
  });

  test("a line with no space in the budget is hard-cut", () => {
    const long = "x".repeat(SPOKEN_LINE_MAX + 50);
    expect(capSpokenLine(long)).toBe("x".repeat(SPOKEN_LINE_MAX));
  });
});

describe("capSourceLabel", () => {
  test("a short label passes through unchanged", () => {
    expect(capSourceLabel("P L A T 2 8 0")).toBe("P L A T 2 8 0");
  });

  test("a model-generated title is cut at a word boundary", () => {
    const title = "Implement the retry backoff for the watcher registry delivery loop";
    const capped = capSourceLabel(title);
    expect(capped.length).toBeLessThanOrEqual(40);
    expect(capped).toBe("Implement the retry backoff for the");
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

  test("spoken line is capped but the banner text is intact", async () => {
    const cmds: string[] = [];
    const long = "detail ".repeat(40).trim(); // 279 chars after trim
    await sendNotification({
      message: long,
      source: "PLAT-280",
      channel: "both",
      platform: "darwin",
    }, mockSpawner(new Map(), cmds));
    expect(cmds[0]).toContain(`display notification "${long}"`); // banner text intact
    expect(cmds[1].length).toBeLessThanOrEqual("/usr/bin/say -v Zarvox ".length + SPOKEN_LINE_MAX);
    expect(cmds[1].endsWith("...")).toBe(false);
  });

  test("tone prefix leads the banner text and the composed spoken line", async () => {
    const cmds: string[] = [];
    await sendNotification({
      message: "C I is green",
      source: "P L A T 2 8 0",
      tone: "positive",
      channel: "both",
      platform: "darwin",
    }, mockSpawner(new Map(), cmds));
    expect(cmds[0]).toContain('display notification "Amaze! Amaze! C I is green"');
    expect(cmds[1]).toContain("/usr/bin/say -v Zarvox Amaze! Amaze! P L A T 2 8 0: C I is green");
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

describe("terminal-notifier preference (darwin)", () => {
  test("a found binary delivers the banner through terminal-notifier with a copy-to-clipboard click action", async () => {
    const cmds: string[] = [];
    const spawner = mockSpawner(new Map([["/usr/bin/which", { exitCode: 0, stderr: "" }]]), cmds);
    const result = await sendNotification({
      message: "C I is green",
      source: "PLAT-280",
      channel: "both",
      platform: "darwin",
    }, spawner);
    expect(cmds.length).toBe(2); // the PATH probe is detection, not delivery; not recorded
    expect(cmds[0]).toContain("terminal-notifier -title PLAT-280");
    expect(cmds[0]).toContain("-message C I is green");
    expect(cmds[0]).toContain("-sound Submarine");
    expect(cmds[0]).toContain("/usr/bin/osascript -e 'set the clipboard to \"C I is green\"'");
    // Voice delivery is untouched by the banner preference.
    expect(cmds[1]).toContain("/usr/bin/say -v Zarvox PLAT-280: C I is green");
    expect(result).toBe("[notified] banner (terminal-notifier) ok; voice (Zarvox) ok");
  });

  test("the click action survives a message with single quotes, double quotes, and backslashes", async () => {
    const cmds: string[] = [];
    const spawner = mockSpawner(new Map([["/usr/bin/which", { exitCode: 0, stderr: "" }]]), cmds);
    await sendNotification({ message: 'it\'s "done" \\ now', channel: "banner", platform: "darwin" }, spawner);
    // Two quoting layers: appleScriptString escapes for AppleScript
    // (backslash + double quote), then one shell single-quote wraps the
    // whole -e argument (a single quote inside becomes '\'').
    expect(cmds[0]).toContain(
      "/usr/bin/osascript -e 'set the clipboard to \"it'\\''s \\\"done\\\" \\\\ now\"'",
    );
  });

  test("the tone prefix leads the terminal-notifier message and the copied text", async () => {
    const cmds: string[] = [];
    const spawner = mockSpawner(new Map([["/usr/bin/which", { exitCode: 0, stderr: "" }]]), cmds);
    await sendNotification({
      message: "C I is green",
      tone: "positive",
      channel: "banner",
      platform: "darwin",
    }, spawner);
    expect(cmds[0]).toContain("-message Amaze! Amaze! C I is green");
    expect(cmds[0]).toContain('set the clipboard to "Amaze! Amaze! C I is green"');
  });

  test("a probe that cannot spawn falls back to the osascript banner", async () => {
    const cmds: string[] = [];
    const result = await sendNotification(
      { message: "m", channel: "banner", platform: "darwin" },
      async (cmd) => {
        if (cmd[0] === "/usr/bin/which") throw new Error("spawn ENOENT");
        cmds.push(cmd.join(" "));
        return { exitCode: 0, stderr: "" };
      },
    );
    expect(cmds.length).toBe(1);
    expect(cmds[0]).toContain("/usr/bin/osascript");
    expect(cmds[0]).toContain('display notification "m"');
    expect(result).toContain("banner (osascript) ok");
  });

  test("terminalNotifierAvailable reads the probe result, treating spawn errors as absent", async () => {
    expect(await terminalNotifierAvailable(async () => ({ exitCode: 0, stderr: "" }))).toBe(true);
    expect(await terminalNotifierAvailable(async () => ({ exitCode: 1, stderr: "" }))).toBe(false);
    expect(await terminalNotifierAvailable(async () => { throw new Error("ENOENT"); })).toBe(false);
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

describe("THATCH_NO_NOTIFY suppression", () => {
  test("THATCH_NO_NOTIFY=1 dispatches nothing and returns a suppression line", async () => {
    process.env.THATCH_NO_NOTIFY = "1";
    try {
      const cmds: string[] = [];
      const result = await sendNotification({ message: "m", channel: "both", platform: "darwin" }, mockSpawner(new Map(), cmds));
      expect(cmds.length).toBe(0);
      expect(result).toContain("[suppressed]");
      expect(result).toContain("THATCH_NO_NOTIFY");
    } finally {
      delete process.env.THATCH_NO_NOTIFY;
    }
  });

  test("any value other than exact 1 leaves dispatch enabled", async () => {
    // "Exact 1" parity with the other boolean knobs (QA_DOCKER etc.): a bare
    // truthy check would read "0" as on.
    for (const value of ["0", "false", ""]) {
      process.env.THATCH_NO_NOTIFY = value;
      try {
        const cmds: string[] = [];
        await sendNotification({ message: "m", channel: "banner", platform: "darwin" }, mockSpawner(new Map(), cmds));
        expect(cmds.length).toBe(1);
      } finally {
        delete process.env.THATCH_NO_NOTIFY;
      }
    }
  });

  test("notifySuppressed reads the passed environment, not only process.env", () => {
    expect(notifySuppressed({ THATCH_NO_NOTIFY: "1" })).toBe(true);
    expect(notifySuppressed({})).toBe(false);
    expect(notifySuppressed({ THATCH_NO_NOTIFY: "0" })).toBe(false);
  });
});

describe("notification journal", () => {
  test("a delivered attempt journals one row with the request as passed", async () => {
    const entries: NotifyJournalEntry[] = [];
    const result = await sendNotification(
      { message: "C I is green", source: "PLAT-280", channel: "both", platform: "darwin" },
      mockSpawner(new Map()),
      (e) => entries.push(e),
    );
    expect(result).toContain("[notified]");
    expect(entries).toEqual([
      { channel: "both", source: "PLAT-280", title: "", message: "C I is green", outcome: "delivered" },
    ]);
  });

  test("a partial failure still journals delivered (any channel ran)", async () => {
    // Same semantics as the result string: [notified] when anything
    // succeeded, [failed] only when every requested channel failed.
    const entries: NotifyJournalEntry[] = [];
    await sendNotification(
      { message: "m", channel: "both", platform: "darwin" },
      mockSpawner(new Map([["/usr/bin/say", { exitCode: 1, stderr: "bad voice" }]])),
      (e) => entries.push(e),
    );
    expect(entries[0].outcome).toBe("delivered");
  });

  test("a total failure journals failed", async () => {
    const entries: NotifyJournalEntry[] = [];
    await sendNotification(
      { message: "m", channel: "both", platform: "darwin" },
      mockSpawner(new Map([["", { exitCode: 1, stderr: "boom" }]])),
      (e) => entries.push(e),
    );
    expect(entries).toEqual([{ channel: "both", source: "", title: "", message: "m", outcome: "failed" }]);
  });

  test("a suppressed attempt journals suppressed without dispatching", async () => {
    process.env.THATCH_NO_NOTIFY = "1";
    try {
      const entries: NotifyJournalEntry[] = [];
      const cmds: string[] = [];
      const result = await sendNotification(
        { message: "m", source: "S", channel: "both", platform: "darwin" },
        mockSpawner(new Map(), cmds),
        (e) => entries.push(e),
      );
      expect(cmds.length).toBe(0);
      expect(result).toContain("[suppressed]");
      expect(entries).toEqual([{ channel: "both", source: "S", title: "", message: "m", outcome: "suppressed" }]);
    } finally {
      delete process.env.THATCH_NO_NOTIFY;
    }
  });

  test("an unsupported platform journals unsupported", async () => {
    const entries: NotifyJournalEntry[] = [];
    await sendNotification(
      { message: "m", channel: "both", platform: "win32" },
      mockSpawner(new Map()),
      (e) => entries.push(e),
    );
    expect(entries).toEqual([{ channel: "both", source: "", title: "", message: "m", outcome: "unsupported" }]);
  });

  test("a journal writer that throws logs and never breaks the dispatch", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const result = await sendNotification(
        { message: "m", channel: "banner", platform: "darwin" },
        mockSpawner(new Map()),
        () => { throw new Error("database is locked"); },
      );
      expect(result).toContain("[notified]");
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("notification journal write failed");
      expect(errors[0]).toContain("database is locked");
    } finally {
      console.error = orig;
    }
  });

  test("ThatchDB journals rows and lists the newest N, oldest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-notify-journal-"));
    try {
      const db = new ThatchDB(join(dir, "thatch.db"));
      db.recordNotifyJournal({ channel: "both", source: "a", title: "", message: "first", outcome: "delivered" });
      db.recordNotifyJournal({ channel: "banner", source: "b", title: "t", message: "second", outcome: "failed" });
      db.recordNotifyJournal({ channel: "voice", source: "", title: "", message: "third", outcome: "suppressed" });
      const all = db.listNotifyJournal(10);
      expect(all.map((r) => r.message)).toEqual(["first", "second", "third"]);
      expect(all[1].id).toBeGreaterThan(all[0].id);
      expect(all[1].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(all[2].source).toBe("");
      const newestTwo = db.listNotifyJournal(2);
      expect(newestTwo.map((r) => r.message)).toEqual(["second", "third"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("config_set rejects a typo'd section with a suggestion and writes nothing", async () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ notifications: { mode: "banner" } }, dbPath);
    const before = readFileSync(join(dbDir, "config.json"), "utf8");
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    // The typo'd section is passed raw: both hosts deliver unknown keys to
    // execute (MCP's validator deep-passthroughs; v2's declared schema
    // permits them and core's input repair no longer strips what the
    // schema permits; opencode v1 forwards raw input by host
    // implementation). A stripping validator would turn this call into
    // "Nothing to update" instead.
    const result = await def.execute({ notifcations: { mode: "voice" } } as Record<string, unknown>, ctx);
    expect(result).toContain("Unknown config_set section 'notifcations'");
    expect(result).toContain('Did you mean "notifications"?');
    expect(readFileSync(join(dbDir, "config.json"), "utf8")).toBe(before);
  });

  test("config_set rejects a typo'd field with a suggestion and writes nothing", async () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ chat: { enabled: true } }, dbPath);
    const before = readFileSync(join(dbDir, "config.json"), "utf8");
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ chat: { enabld: false } } as Record<string, unknown>, ctx);
    expect(result).toContain("Unknown chat field 'enabld'");
    expect(result).toContain('Did you mean "enabled"?');
    expect(readFileSync(join(dbDir, "config.json"), "utf8")).toBe(before);
  });

  test("config_set does not steer an environment typo into the read-only refusal", async () => {
    // "environment" is a valid top-level key but read-only for config_set,
    // so it is excluded from the suggestion candidates: a free-transposition
    // typo ("enviroment") gets the valid list but no suggestion, rather
    // than being steered into the read-only refusal.
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ enviroment: {} } as Record<string, unknown>, ctx);
    expect(result).toContain("Unknown config_set section 'enviroment'");
    expect(result).toContain("Valid sections:");
    expect(result).not.toContain("Did you mean");
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

  test("notify_user tone positive prepends the prefix to banner and spoken line, source label after it", async () => {
    if (process.platform !== "darwin") return; // command construction is platform-specific
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    await def.execute({ message: "C I is green", source: "P L A T 2 8 0", tone: "positive", channel: "both" }, ctx);
    expect(recorded[0]).toContain('display notification "Amaze! Amaze! C I is green"');
    expect(recorded[1]).toContain("/usr/bin/say -v Zarvox Amaze! Amaze! P L A T 2 8 0: C I is green");
  });

  test("notify_user tone negative prepends the negative prefix; neutral stays clean", async () => {
    if (process.platform !== "darwin") return; // command construction is platform-specific
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    await def.execute({ message: "C I is red", tone: "negative", channel: "voice" }, ctx);
    expect(recorded[0]).toContain("/usr/bin/say -v Zarvox Sad sad sad C I is red");

    recorded.length = 0;
    await def.execute({ message: "deployed", tone: "neutral", channel: "voice" }, ctx);
    expect(recorded[0]).toContain("/usr/bin/say -v Zarvox deployed");
  });

  test("notify_user does not double a prefix the message already carries", async () => {
    if (process.platform !== "darwin") return; // command construction is platform-specific
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    await def.execute({ message: "Amaze! Amaze! C I is green", tone: "positive", channel: "voice" }, ctx);
    expect(recorded[0]).toContain("/usr/bin/say -v Zarvox Amaze! Amaze! C I is green");
    expect(recorded[0]).not.toContain("Amaze! Amaze! Amaze");
  });

  test("notify_user single-prefixes a hand-composed prefix even with a source label", async () => {
    // The transition-period case: a model with the old hand-compose habit
    // also passes tone. The guard strips the composed prefix from the raw
    // message BEFORE the source label is composed around it - applying it
    // after composition would let the prefix through twice.
    if (process.platform !== "darwin") return; // command construction is platform-specific
    const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
    await def.execute({ message: "Amaze! Amaze! C I is green", source: "P L A T 2 8 0", tone: "positive", channel: "voice" }, ctx);
    expect(recorded[0]).toContain("/usr/bin/say -v Zarvox Amaze! Amaze! P L A T 2 8 0: C I is green");
    expect(recorded[0].split("Amaze! Amaze!").length - 1).toBe(1);
  });

  test("notify_user journals the attempt when ctx.notifyJournal is bound to ThatchDB", async () => {
    if (process.platform !== "darwin") return; // command construction is platform-specific
    const db = new ThatchDB(join(dbDir, "thatch.db"));
    try {
      ctx.notifyJournal = (e) => db.recordNotifyJournal(e);
      const def = TOOL_DEFS.find((t) => t.name === "notify_user")!;
      const result = await def.execute({ message: "deployed", source: "journal-test" }, ctx);
      expect(result).toContain("[notified]");
      const rows = db.listNotifyJournal(10);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        channel: "both",
        source: "journal-test",
        message: "deployed",
        outcome: "delivered",
      });
    } finally {
      db.close();
      ctx.notifyJournal = undefined;
    }
  });

  test("config_set unsets a notification field via null and deletes the key from the file", async () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ notifications: { mode: "banner", voice: "Fred" } }, dbPath);
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ notifications: { voice: null } }, ctx);
    expect(result).toContain("[saved]");
    expect(result).toContain("mode: banner");
    expect(result).toContain("voice: <unset>");
    const written = JSON.parse(readFileSync(join(dbDir, "config.json"), "utf8"));
    expect(written.notifications).toEqual({ mode: "banner" });
  });

  test("config_set unsets chat and alerts fields via null", async () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig(
      { chat: { enabled: false, autoRegister: false }, alerts: { pause: { mode: "voice" }, done: { mode: "none" } } },
      dbPath,
    );
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ chat: { enabled: null }, alerts: { pause: { mode: null } } }, ctx);
    expect(result).toContain("[saved]");
    expect(result).toContain("enabled: <unset>");
    expect(result).toContain("pause.mode: <unset>");
    expect(result).toContain("done.mode: none");
    const written = JSON.parse(readFileSync(join(dbDir, "config.json"), "utf8"));
    expect(written.chat).toEqual({ autoRegister: false });
    expect(written.alerts).toEqual({ done: { mode: "none" } });
  });

  test("defaults apply after an unset: config_get shows <unset> and the default", async () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ notifications: { voice: "Fred" } }, dbPath);
    const set = TOOL_DEFS.find((t) => t.name === "config_set")!;
    await set.execute({ notifications: { voice: null } }, ctx);
    const get = TOOL_DEFS.find((t) => t.name === "config_get")!;
    const read = await get.execute({ section: "notifications" }, ctx);
    expect(read).toContain("voice: <unset>");
    // The default annotation returns with the platform default (whatever
    // DEFAULT_VOICE currently is) - the unset deleted the pinned override.
    if (process.platform === "darwin") {
      expect(read).toMatch(/voice: <unset> \(default: .+\)/);
    }
  });

  test("config_set refuses a null section object", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ notifications: null }, ctx);
    expect(result).toContain("null is not a section value");
    expect(existsSync(join(dbDir, "config.json"))).toBe(false);
  });

  test("config_set refuses the environment section", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ environment: { THATCH_DEBUG: "1" } }, ctx);
    expect(result).toContain("environment knobs are set per process");
    expect(existsSync(join(dbDir, "config.json"))).toBe(false);
  });

  test("config_set refuses to write when the file failed to parse", async () => {
    // A broken file (e.g. a hand-edited null) means the in-memory config is
    // empty defaults - saving would replace the whole file and silently
    // discard the user's other sections. The tool must refuse instead.
    writeFileSync(join(dbDir, "config.json"), '{ "notifications": { "voice": null } }');
    const def = TOOL_DEFS.find((t) => t.name === "config_set")!;
    const result = await def.execute({ notifications: { mode: "banner" } }, ctx);
    expect(result).toContain("Config file failed to parse");
    const onDisk = JSON.parse(readFileSync(join(dbDir, "config.json"), "utf8"));
    expect(onDisk.notifications.voice).toBeNull(); // the file was not touched
  });

  test("config_get renders the environment section with effective values", async () => {
    const prev = process.env.THATCH_RECALL_THRESHOLD;
    process.env.THATCH_RECALL_THRESHOLD = "0.7";
    try {
      const def = TOOL_DEFS.find((t) => t.name === "config_get")!;
      const result = await def.execute({ section: "environment" }, ctx);
      expect(result).toContain("environment:");
      expect(result).toContain("THATCH_RECALL_THRESHOLD: 0.7 (default: 0.55)");
      // The test process's own THATCH_DB_PATH shows through - values are
      // read from the live environment, not invented.
      expect(result).toContain(`THATCH_DB_PATH: ${join(dbDir, "thatch.db")}`);
    } finally {
      if (prev === undefined) delete process.env.THATCH_RECALL_THRESHOLD;
      else process.env.THATCH_RECALL_THRESHOLD = prev;
    }
  });
});

describe("defaultSpawner", () => {
  test("captures exit code and stderr of a real command", async () => {
    const result = await defaultSpawner(["/usr/bin/false"]);
    expect(result.exitCode).not.toBe(0);
  });
});
