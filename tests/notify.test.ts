import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendNotification, spokenText, applyTonePrefix, capSpokenLine, capSourceLabel, SPOKEN_LINE_MAX, defaultSpawner, type Spawner, type SpawnResult } from "../src/notify";
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
});

describe("defaultSpawner", () => {
  test("captures exit code and stderr of a real command", async () => {
    const result = await defaultSpawner(["/usr/bin/false"]);
    expect(result.exitCode).not.toBe(0);
  });
});
