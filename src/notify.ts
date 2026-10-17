// Out-of-band user notification: desktop banner plus spoken voice. Both are
// plain child processes - no vendored binaries, no npm notifier dependency -
// because the per-platform commands are one-liners and the alternatives
// (node-notifier's bundled terminal-notifier) trip Gatekeeper on modern macOS.
// Dispatch is darwin and linux only by design: win32 support is not a goal,
// and the tool reports the gap honestly rather than half-working.

export type NotifyChannel = "both" | "banner" | "voice";

/** Tone of the news: the tool picks the announcement prefix from this. */
export type NotifyTone = "positive" | "negative" | "neutral";

export interface NotifyRequest {
  message: string;
  title?: string;
  source?: string;
  channel: NotifyChannel;
  /** Voice name override; falls back to the platform default. */
  voice?: string;
  /** Banner alert sound (macOS); falls back to Submarine. */
  sound?: string;
  /**
   * News tone: picks the announcement prefix. The prefix leads both the
   * banner text and the spoken line (before the source label). Neutral
   * (or omitted) adds nothing.
   */
  tone?: NotifyTone;
  platform?: string;
}

/**
 * The macOS say voice used when neither the call nor the config picks one:
 * Zarvox, the author's preference. The Bell voice was tried here
 * (2026-10-16) and reverted: it sounds like Rocky from Project Hail Mary,
 * but intelligibility beats musicality for a notification voice.
 */
export const DEFAULT_VOICE = "Zarvox";

/**
 * Announcement prefixes in Rocky's exclamation style (Project Hail Mary).
 * These belong to the tool: callers pass tone, never hand-composed
 * "Amaze"/"Sad" text, so a double prefix cannot happen in normal use.
 * applyTonePrefix is the guard for the case where the message text already
 * carries the prefix anyway.
 */
export const TONE_PREFIXES: Record<NotifyTone, string> = {
  positive: "Amaze! Amaze! ",
  negative: "Sad sad sad ",
  neutral: "",
};

/**
 * Removes any tone's prefix variant from the front of the message
 * (case-insensitive, with or without its trailing space - a hand-composed
 * one), but only when the prefix is followed by whitespace or the end of
 * the message: "sad sad sadly" is a word starting with the prefix, not a
 * composed prefix, and must survive intact. A neutral or absent tone
 * strips nothing: a message composed without a tone flows through
 * verbatim, exactly as it did before the tone arg existed. The inverse of
 * applyTonePrefix's prepend.
 */
export function stripTonePrefix(message: string, tone?: NotifyTone): string {
  if (!tone) return message;
  for (const prefix of Object.values(TONE_PREFIXES)) {
    const bare = prefix.trim().toLowerCase();
    if (!bare || !message.toLowerCase().startsWith(bare)) continue;
    const rest = message.slice(bare.length);
    if (rest.length > 0 && !/^\s/.test(rest)) continue;
    return rest.trimStart();
  }
  return message;
}

/**
 * Prepends the tone's prefix to a notification message. The prefix belongs
 * to the tool, not the caller: any tone's prefix variant already on the
 * front of the message is stripped (see stripTonePrefix) and the canonical
 * form applied, so a caller that composed the prefix into the message and
 * also passed tone gets one prefix, not two. Neutral (or omitted) returns
 * the message unchanged.
 */
export function applyTonePrefix(message: string, tone?: NotifyTone): string {
  const prefix = tone ? TONE_PREFIXES[tone] : "";
  if (!prefix) return message;
  return prefix + stripTonePrefix(message, tone);
}

/**
 * Hard budget for the spoken line, in characters. Long text takes a while
 * to speak and MacinTalk gets monotone and unclear on long sentences, so
 * the line is cut, not read in full. The banner text is never truncated.
 */
export const SPOKEN_LINE_MAX = 140;

/** Cuts text to max chars, preferring a word boundary. The shared body of
 *  the named budget caps below; the codebase deliberately has one small
 *  truncate helper per module, so this one is private to notify.ts. */
function capTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return body.trimEnd();
}

/** Cuts a spoken line to SPOKEN_LINE_MAX chars, preferring a word boundary. */
export function capSpokenLine(text: string): string {
  return capTo(text, SPOKEN_LINE_MAX);
}

export interface SpawnResult {
  exitCode: number | null;
  stderr: string;
}

export type Spawner = (cmd: string[]) => Promise<SpawnResult>;

/** The real runner. Tests inject a mock so nothing actually speaks. */
export const defaultSpawner: Spawner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { exitCode: proc.exitCode, stderr };
};

/**
 * The spoken line. The source label (ticket number, feature name) goes first
 * so the listener immediately knows which session is talking. The tone
 * prefix is applied OVER this composition (after it), so the prefix leads
 * the line.
 */
export function spokenText(request: Pick<NotifyRequest, "message" | "source">): string {
  return request.source ? `${request.source}: ${request.message}` : request.message;
}

/** The source label's budget: a spoken "P L A T 2 8 0:" consumes many of
 *  the composed line's characters, and an unbounded label (a
 *  model-generated session title) would push the message out of the
 *  capped line. The message is the news; the label is the address. */
export const SOURCE_LABEL_MAX = 40;

/** Cuts a source label to SOURCE_LABEL_MAX chars at a word boundary. */
export function capSourceLabel(text: string): string {
  return capTo(text, SOURCE_LABEL_MAX);
}

/** AppleScript string literal - backslash and double-quote are the escapes. */
function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface StepOutcome {
  label: string;
  ok: boolean;
  detail: string;
}

async function runStep(label: string, cmd: string[], spawner: Spawner): Promise<StepOutcome> {
  try {
    const result = await spawner(cmd);
    if (result.exitCode === 0) {
      return { label, ok: true, detail: label };
    }
    return { label, ok: false, detail: `${label} failed: exited ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}` };
  } catch (err) {
    // Missing binary surfaces here (ENOENT) rather than as an exit code.
    return { label, ok: false, detail: `${label} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Sends the notification and returns a result line for the tool response.
 * A zero exit proves only that the command ran - macOS focus modes can still
 * suppress the banner silently - so the result never claims the user saw it.
 * Never throws: every failure becomes text the calling model can read.
 */
export async function sendNotification(
  request: NotifyRequest,
  spawner: Spawner = defaultSpawner,
): Promise<string> {
  const platform = request.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return `[unsupported] notifications are not implemented on ${platform} (macOS and Linux only); nothing was sent.`;
  }

  const outcomes: StepOutcome[] = [];
  const bannerText = applyTonePrefix(request.message, request.tone);

  if (request.channel !== "voice") {
    const title = request.title ?? request.source ?? "thatch";
    if (platform === "darwin") {
      const sound = request.sound ?? "Submarine";
      const script =
        `display notification ${appleScriptString(bannerText)} ` +
        `with title ${appleScriptString(title)} sound name ${appleScriptString(sound)}`;
      outcomes.push(await runStep("banner (osascript)", ["/usr/bin/osascript", "-e", script], spawner));
    } else {
      outcomes.push(await runStep("banner (notify-send)", ["notify-send", title, bannerText], spawner));
    }
  }

  if (request.channel !== "banner") {
    // The spoken line reads: prefix, then the source label, then the
    // message. A hand-composed prefix is stripped from the raw message
    // BEFORE composing (applying only after composition would miss it -
    // the composed line starts with the source label, not the prefix -
    // and the prefix would end up doubled). The source label is capped
    // HERE, structurally: an unbounded label (a model-generated session
    // title) would eat the composed line's budget and cut the message -
    // the part that carries the news. The banner title above keeps the
    // full source: the banner has no line budget.
    const spokenSource = request.source ? capSourceLabel(request.source) : undefined;
    const spoken = capSpokenLine(
      applyTonePrefix(spokenText({ source: spokenSource, message: stripTonePrefix(request.message, request.tone) }), request.tone),
    );
    if (platform === "darwin") {
      const voice = request.voice ?? DEFAULT_VOICE;
      outcomes.push(await runStep(`voice (${voice})`, ["/usr/bin/say", "-v", voice, spoken], spawner));
    } else {
      // spd-say has no voice flag, so a voice override goes straight to
      // espeak (-v). Without an override, speech-dispatcher is the friendlier
      // default; raw espeak is the fallback when it is absent.
      if (request.voice) {
        outcomes.push(await runStep(`voice (espeak -v ${request.voice})`, ["espeak", "-v", request.voice, spoken], spawner));
      } else {
        const spd = await runStep("voice (spd-say)", ["spd-say", "-w", spoken], spawner);
        outcomes.push(spd.ok ? spd : await runStep("voice (espeak)", ["espeak", spoken], spawner));
      }
    }
  }

  const failed = outcomes.filter((o) => !o.ok);
  if (outcomes.every((o) => !o.ok)) {
    return `[failed] ${failed.map((o) => o.detail).join("; ")}`;
  }
  const parts = outcomes.map((o) => (o.ok ? `${o.detail} ok` : o.detail));
  return `[notified] ${parts.join("; ")}`;
}
