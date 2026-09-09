// Out-of-band user notification: desktop banner plus spoken voice. Both are
// plain child processes - no vendored binaries, no npm notifier dependency -
// because the per-platform commands are one-liners and the alternatives
// (node-notifier's bundled terminal-notifier) trip Gatekeeper on modern macOS.
// Dispatch is darwin and linux only by design: win32 support is not a goal,
// and the tool reports the gap honestly rather than half-working.

export type NotifyChannel = "both" | "banner" | "voice";

export interface NotifyRequest {
  message: string;
  title?: string;
  source?: string;
  channel: NotifyChannel;
  /** Voice name override; falls back to the platform default. */
  voice?: string;
  /** Banner alert sound (macOS); falls back to Submarine. */
  sound?: string;
  platform?: string;
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
 * so the listener immediately knows which session is talking.
 */
export function spokenText(request: Pick<NotifyRequest, "message" | "source">): string {
  return request.source ? `${request.source}: ${request.message}` : request.message;
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

  if (request.channel !== "voice") {
    const title = request.title ?? request.source ?? "thatch";
    if (platform === "darwin") {
      const sound = request.sound ?? "Submarine";
      const script =
        `display notification ${appleScriptString(request.message)} ` +
        `with title ${appleScriptString(title)} sound name ${appleScriptString(sound)}`;
      outcomes.push(await runStep("banner (osascript)", ["/usr/bin/osascript", "-e", script], spawner));
    } else {
      outcomes.push(await runStep("banner (notify-send)", ["notify-send", title, request.message], spawner));
    }
  }

  if (request.channel !== "banner") {
    const spoken = spokenText(request);
    if (platform === "darwin") {
      const voice = request.voice ?? "Zarvox";
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
