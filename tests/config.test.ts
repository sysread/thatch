import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFilePath,
  loadConfig,
  saveConfig,
  mergeNotificationPrefs,
  notificationDefaults,
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
