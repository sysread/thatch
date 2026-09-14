import { z } from "zod";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Thatch user config: one JSON file beside thatch.db, hand-editable and
// managed by the config_get / config_set tools. Sections are strict (unknown
// keys fail validation instead of being silently dropped) so a hand edit or a
// newer-version file can never lose data by round-tripping through an older
// process. config_set merges at the field level: omitted fields keep their
// values, so a partial section update never wipes sibling preferences.

export const notificationPrefsSchema = z.strictObject({
  mode: z.enum(["both", "banner", "voice", "none"]).optional(),
  voice: z.string().optional(),
  sound: z.string().optional(),
});

export const chatPrefsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  autoRegister: z.boolean().optional(),
});

export const configSchema = z.strictObject({
  notifications: notificationPrefsSchema.optional(),
  chat: chatPrefsSchema.optional(),
});

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export type ChatPrefs = z.infer<typeof chatPrefsSchema>;
export type Config = z.infer<typeof configSchema>;

/** Sections in presentation order. config_get / config_set iterate this. */
export const CONFIG_SECTIONS = ["notifications", "chat"] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/**
 * Resolves the config file path. By convention it lives next to thatch.db,
 * so a custom THATCH_DB_PATH moves the config with it. Tests pass an
 * explicit dbPath to keep writes inside a tempdir.
 */
export function configFilePath(dbPath?: string): string {
  if (dbPath) return join(dirname(dbPath), "config.json");
  const dir = process.env.THATCH_DB_PATH
    ? dirname(process.env.THATCH_DB_PATH)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "thatch");
  return join(dir, "config.json");
}

export interface LoadedConfig {
  config: Config;
  /** Non-null when the file exists but is unparseable; the file is ignored. */
  warning: string | null;
  path: string;
}

/** Reads the config file. A missing file is the empty config, not an error. */
export function loadConfig(dbPath?: string): LoadedConfig {
  const path = configFilePath(dbPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: {}, warning: null, path };
  }
  try {
    const parsed = configSchema.parse(JSON.parse(raw));
    return { config: parsed, warning: null, path };
  } catch (err) {
    return {
      config: {},
      warning: `config file at ${path} is invalid and was ignored (${err instanceof Error ? err.message : String(err)})`,
      path,
    };
  }
}

/**
 * Writes the config atomically (temp file + rename) so a crash mid-write
 * cannot leave a truncated file, and concurrent readers never see a partial
 * document.
 */
export function saveConfig(config: Config, dbPath?: string): string {
  const path = configFilePath(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, path);
  return path;
}

/** Field-level merge for one section: omitted fields keep their values. */
export function mergeNotificationPrefs(
  current: NotificationPrefs | undefined,
  patch: NotificationPrefs,
): NotificationPrefs {
  return { ...current, ...patch };
}

/** Field-level merge for one section: omitted fields keep their values. */
export function mergeChatPrefs(current: ChatPrefs | undefined, patch: ChatPrefs): ChatPrefs {
  return { ...current, ...patch };
}

/**
 * Whether cross-session chat is on. Unset means on - chat is the default,
 * and the toggle exists for users who want the feature entirely dark: every
 * chat tool refuses, wake delivery never starts, and the system prompt
 * omits the chat section.
 */
export function chatEnabled(config: Config): boolean {
  return config.chat?.enabled !== false;
}

/**
 * Whether opencode sessions join the chat directory automatically (first
 * idle event, name assigned by thatch). Unset means on - the directory is
 * only useful when peers are in it, and a session that must be told to
 * register never is. Turning it off restores opt-in behavior: sessions
 * stay out of the directory until they call chat_register.
 */
export function chatAutoRegister(config: Config): boolean {
  return config.chat?.autoRegister !== false;
}

/**
 * Platform fallbacks shown by config_get and applied by notify_user when the
 * user has not set a preference. Only darwin has opinionated defaults; other
 * platforms use their tools' own voices and sounds.
 */
export function notificationDefaults(): { mode: "both" | "banner" | "voice" | "none"; voice?: string; sound?: string } {
  if (process.platform === "darwin") {
    return { mode: "both", voice: "Zarvox", sound: "Submarine" };
  }
  return { mode: "both" };
}
