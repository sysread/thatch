import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatEnabled,
  configFilePath,
  loadConfig,
  mergeChatPrefs,
  saveConfig,
  mergeNotificationPrefs,
  mergeAlertsPrefs,
  alertVoice,
  notificationDefaults,
  type Config,
} from "../src/config";

let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-config-test-"));
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

describe("configFilePath", () => {
  test("lives beside an explicit dbPath", () => {
    const dbPath = join(dbDir, "thatch.db");
    expect(configFilePath(dbPath)).toBe(join(dbDir, "config.json"));
  });

  test("derives from THATCH_DB_PATH when no explicit path is given", () => {
    const prev = process.env.THATCH_DB_PATH;
    process.env.THATCH_DB_PATH = join(dbDir, "thatch.db");
    try {
      expect(configFilePath()).toBe(join(dbDir, "config.json"));
    } finally {
      if (prev === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prev;
    }
  });
});

describe("loadConfig", () => {
  test("missing file is the empty config, not an error", () => {
    const loaded = loadConfig(join(dbDir, "thatch.db"));
    expect(loaded.config).toEqual({});
    expect(loaded.warning).toBeNull();
  });

  test("valid file round-trips", () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ notifications: { mode: "banner", voice: "Fred" } }, dbPath);
    const loaded = loadConfig(dbPath);
    expect(loaded.config.notifications).toEqual({ mode: "banner", voice: "Fred" });
    expect(loaded.warning).toBeNull();
  });

  test("invalid JSON is ignored with a warning", () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({}, dbPath);
    const path = configFilePath(dbPath);
    const broken = readFileSync(path, "utf8").replace("}", "this is not json");
    writeFileSync(path, broken);
    const loaded = loadConfig(dbPath);
    expect(loaded.config).toEqual({});
    expect(loaded.warning).toContain("invalid");
  });

  test("unknown sections fail validation and are ignored", () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({}, dbPath);
    const path = configFilePath(dbPath);
    writeFileSync(path, JSON.stringify({ coffee: { strength: "double" } }));
    const loaded = loadConfig(dbPath);
    expect(loaded.config).toEqual({});
    expect(loaded.warning).toContain("invalid");
  });
});

describe("saveConfig", () => {
  test("creates the config directory and leaves no temp files", () => {
    const dbPath = join(dbDir, "nested", "deeper", "thatch.db");
    saveConfig({ notifications: { mode: "voice" } }, dbPath);
    const path = configFilePath(dbPath);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      notifications: { mode: "voice" },
    });
    expect(readdirSync(join(dbDir, "nested", "deeper")).length).toBe(1);
  });
});

describe("mergeNotificationPrefs", () => {
  test("omitted fields keep their values", () => {
    const merged = mergeNotificationPrefs({ mode: "banner", sound: "Ping" }, { voice: "Fred" });
    expect(merged).toEqual({ mode: "banner", sound: "Ping", voice: "Fred" });
  });

  test("passed fields overwrite", () => {
    const merged = mergeNotificationPrefs({ mode: "banner" }, { mode: "voice" });
    expect(merged).toEqual({ mode: "voice" });
  });

  test("a null field is deleted, returning the field to <unset>", () => {
    const merged = mergeNotificationPrefs({ mode: "banner", voice: "Fred" }, { voice: null });
    expect(merged).toEqual({ mode: "banner" });
  });

  test("merging every field null leaves an empty section", () => {
    const merged = mergeNotificationPrefs({ mode: "banner", voice: "Fred", sound: "Ping" }, {
      mode: null,
      voice: null,
      sound: null,
    });
    expect(merged).toEqual({});
  });
});

describe("mergeChatPrefs", () => {
  test("a null field is deleted", () => {
    expect(mergeChatPrefs({ enabled: false, autoRegister: true }, { enabled: null })).toEqual({ autoRegister: true });
    expect(mergeChatPrefs({ enabled: false }, { enabled: null })).toEqual({});
  });
});

describe("mergeAlertsPrefs", () => {
  test("a null event mode is deleted and an emptied event object is dropped", () => {
    const merged = mergeAlertsPrefs({ pause: { mode: "voice" }, done: { mode: "none" } }, {
      pause: { mode: null },
    });
    expect(merged).toEqual({ done: { mode: "none" } });
  });

  test("sibling events and untouched modes keep their values", () => {
    const merged = mergeAlertsPrefs({ pause: { mode: "voice" }, error: { mode: "none" } }, {
      pause: { mode: "both" },
    });
    expect(merged).toEqual({ pause: { mode: "both" }, error: { mode: "none" } });
  });

  test("a null event object deletes the event", () => {
    const merged = mergeAlertsPrefs({ pause: { mode: "voice" } }, { pause: null });
    expect(merged).toEqual({});
  });

  test("an unknown event key is rejected loudly, not silently dropped", () => {
    // The merge iterates known kinds; a patch key outside them is a caller
    // bug and must throw instead of being silently dropped with a "[saved]"
    // echo.
    expect(() =>
      mergeAlertsPrefs({ done: { mode: "voice" } }, { bogus: { mode: "banner" } } as never),
    ).toThrow(/Unknown alert event: bogus/);
  });
});

describe("alertVoice", () => {
  test("a configured notifications voice overrides the platform default", () => {
    const config: Config = { notifications: { voice: "Fred", sound: "Ping" } };
    expect(alertVoice(config, { voice: "Bells", sound: "Submarine" })).toEqual({
      voice: "Fred",
      sound: "Ping",
    });
  });

  test("unset fields fall back to the platform defaults", () => {
    expect(alertVoice({}, { voice: "Bells", sound: "Submarine" })).toEqual({
      voice: "Bells",
      sound: "Submarine",
    });
    expect(alertVoice({ notifications: { mode: "banner" } }, { voice: "Bells" })).toEqual({
      voice: "Bells",
      sound: undefined,
    });
  });
});

describe("notificationDefaults", () => {
  test("mode is always both", () => {
    expect(notificationDefaults().mode).toBe("both");
  });

  test("darwin pins Zarvox and Submarine", () => {
    if (process.platform !== "darwin") return;
    expect(notificationDefaults().voice).toBe("Zarvox");
    expect(notificationDefaults().sound).toBe("Submarine");
  });
});

describe("chat config", () => {
  test("unset chat means enabled", () => {
    expect(chatEnabled({})).toBe(true);
    expect(chatEnabled({ chat: {} })).toBe(true);
    expect(chatEnabled({ chat: { enabled: true } })).toBe(true);
  });

  test("enabled: false turns the feature off", () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({ chat: { enabled: false } }, dbPath);
    const loaded = loadConfig(dbPath);
    expect(loaded.config.chat).toEqual({ enabled: false });
    expect(chatEnabled(loaded.config)).toBe(false);
  });

  test("unknown chat keys fail validation", () => {
    const dbPath = join(dbDir, "thatch.db");
    saveConfig({}, dbPath);
    const path = configFilePath(dbPath);
    writeFileSync(path, JSON.stringify({ chat: { robot: "uprising" } }));
    const loaded = loadConfig(dbPath);
    expect(loaded.config).toEqual({});
    expect(loaded.warning).toContain("invalid");
  });

  test("mergeChatPrefs is a field-level merge", () => {
    expect(mergeChatPrefs(undefined, { enabled: false })).toEqual({ enabled: false });
    expect(mergeChatPrefs({ enabled: false }, {})).toEqual({ enabled: false });
    expect(mergeChatPrefs({ enabled: false }, { enabled: true })).toEqual({ enabled: true });
  });
});
