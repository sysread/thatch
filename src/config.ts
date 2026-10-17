import { z } from "zod";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_VOICE } from "./notify";

// Thatch user config: one JSON file beside thatch.db, hand-editable and
// managed by the config_get / config_set tools. Sections are strict (unknown
// keys fail validation instead of being silently dropped) so a hand edit or a
// newer-version file can never lose data by round-tripping through an older
// process. config_set merges at the field level: omitted fields keep their
// values (so a partial section update never wipes sibling preferences) and
// a null field deletes the key (the unset marker - the default applies again).

export const notificationPrefsSchema = z.strictObject({
  mode: z.enum(["both", "banner", "voice", "none"]).optional(),
  voice: z.string().optional(),
  sound: z.string().optional(),
});

export const chatPrefsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  autoRegister: z.boolean().optional(),
});

/** Channel preferences for one automatic alert event (pause / done / error). */
export const alertEventPrefsSchema = z.strictObject({
  mode: z.enum(["both", "banner", "voice", "none"]).optional(),
});

export const alertsPrefsSchema = z.strictObject({
  pause: alertEventPrefsSchema.optional(),
  done: alertEventPrefsSchema.optional(),
  error: alertEventPrefsSchema.optional(),
});

export const configSchema = z.strictObject({
  notifications: notificationPrefsSchema.optional(),
  chat: chatPrefsSchema.optional(),
  alerts: alertsPrefsSchema.optional(),
});

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export type ChatPrefs = z.infer<typeof chatPrefsSchema>;
export type AlertEventPrefs = z.infer<typeof alertEventPrefsSchema>;
export type AlertsPrefs = z.infer<typeof alertsPrefsSchema>;
export type Config = z.infer<typeof configSchema>;

/** The automatic alert events, in the order config_get renders them. */
export type AlertEventKind = "pause" | "done" | "error";
export const ALERT_EVENT_KINDS: AlertEventKind[] = ["pause", "done", "error"];

/**
 * The alerts section patch as config_set receives it: each event's mode may
 * be null (the unset marker) and the event itself may be null (delete the
 * event). One level deeper than SectionPatch because the alerts leaves are
 * nested inside the per-event objects. Keep this shape in sync with
 * alertEventPrefsSchema: when that schema gains a field, add it here too -
 * the merge treats patches as records, so a missed field fails at compile
 * time only if this type is derived; it is hand-rolled, so the drift test
 * coverage is the merge tests.
 */
export type AlertsPrefsPatch = {
  [K in AlertEventKind]?: AlertEventPrefs | { mode: AlertEventPrefs["mode"] | null } | null;
};

/** File sections in presentation order. config_get iterates this plus the
 *  presentation-only "environment" section (which reads no file);
 *  config_set iterates exactly this and refuses "environment". */
export const CONFIG_SECTIONS = ["notifications", "chat", "alerts"] as const;
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

/**
 * One section's patch as config_set receives it: leaf values may be null,
 * which is the explicit UNSET marker - the key is deleted from the file so
 * the platform default applies again. Omitted (undefined) fields are plain
 * "no change".
 */
export type SectionPatch<T> = { [K in keyof T]: T[K] | null };

/**
 * Field-level merge for one flat section object: omitted fields keep their
 * values, and a field explicitly set to null is deleted instead of merged,
 * returning that field to <unset> (the platform default applies again).
 */
function mergeSection<T extends object>(current: T | undefined, patch: object): T {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged as T;
}

/**
 * Field-level merge for one section: omitted fields keep their values, and
 * a field explicitly set to null is deleted instead of merged (see
 * mergeSection).
 */
export function mergeNotificationPrefs(
  current: NotificationPrefs | undefined,
  patch: SectionPatch<NotificationPrefs>,
): NotificationPrefs {
  return mergeSection(current, patch);
}

/** Field-level merge for one section; null deletes the field (see mergeSection). */
export function mergeChatPrefs(current: ChatPrefs | undefined, patch: SectionPatch<ChatPrefs>): ChatPrefs {
  return mergeSection(current, patch);
}

/**
 * Field-level merge for the alerts section. One level deeper than the flat
 * sections: the patch carries per-event objects whose mode may be null, so
 * each event merges recursively. An event whose fields are all deleted is
 * dropped entirely so the file carries no empty shells; a null event object
 * (not expressible through the config_set args schema) deletes the event.
 */
export function mergeAlertsPrefs(
  current: AlertsPrefs | undefined,
  patch: AlertsPrefsPatch,
): AlertsPrefs {
  const merged: Record<string, unknown> = { ...current };
  // Unknown event keys are rejected, not skipped: the patch came from a
  // caller that may not validate args, and a silently-dropped write would
  // report "[saved]" for a config change that never happened.
  for (const key of Object.keys(patch)) {
    if (!ALERT_EVENT_KINDS.includes(key as AlertEventKind)) {
      throw new Error(`Unknown alert event: ${key} (expected one of ${ALERT_EVENT_KINDS.join(", ")})`);
    }
  }
  for (const kind of ALERT_EVENT_KINDS) {
    const eventPatch = patch[kind] as Record<string, unknown> | null | undefined;
    if (eventPatch === undefined) continue;
    if (eventPatch === null) {
      delete merged[kind];
      continue;
    }
    const event = mergeSection(current?.[kind], eventPatch);
    if (Object.keys(event).length > 0) merged[kind] = event;
    else delete merged[kind];
  }
  return merged as AlertsPrefs;
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
    return { mode: "both", voice: DEFAULT_VOICE, sound: "Submarine" };
  }
  return { mode: "both" };
}

/**
 * Channel for one automatic alert event (pause / done / error). Unset means
 * banner: the alerts exist to reach a user who walked away, so voice is
 * opt-in per event rather than bundled with the notify_user default.
 */
export function alertMode(config: Config, kind: AlertEventKind): "both" | "banner" | "voice" | "none" {
  return config.alerts?.[kind]?.mode ?? "banner";
}

/**
 * Voice and sound for one alert delivery. The user's configured
 * notifications.voice / sound apply to machine alerts exactly as they do to
 * notify_user; an unset field falls back to the platform default. The
 * caller loads the config per delivery, so a config_set applies without a
 * restart.
 */
export function alertVoice(
  config: Config,
  defaults: { voice?: string; sound?: string },
): { voice?: string; sound?: string } {
  return {
    voice: config.notifications?.voice ?? defaults.voice,
    sound: config.notifications?.sound ?? defaults.sound,
  };
}
