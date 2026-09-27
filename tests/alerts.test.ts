import { describe, test, expect } from "bun:test";
import { createAlerts, deriveRoundShape, roundDidRealWork, replyRequestID, type AlertInput, type AlertsDeps, type RoundMessage, type RoundShape } from "../src/alerts";
import { alertMode, configFilePath, loadConfig, saveConfig, type Config } from "../src/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The alert state machine with all delivery faked out. The spy is
// SYNCHRONOUS on purpose: the machine fire-and-forgets delivery, so the
// spy must record before the promise resolves for assertions to be
// deterministic.
function harness(config: Config | undefined, roundShape: RoundShape | null | (() => RoundShape | null) = null) {
  const alerts: AlertInput[] = [];
  const deps: AlertsDeps = {
    config: () => config ?? {},
    roundShape: async () => (typeof roundShape === "function" ? roundShape() : roundShape),
    sessionTitle: async () => "test session",
    notify: async (input) => {
      alerts.push(input);
    },
  };
  return { alerts, machine: createAlerts(deps) };
}

function shape(overrides: Partial<RoundShape> = {}): RoundShape {
  return { syntheticTrigger: false, roundError: null, ...overrides };
}

describe("roundDidRealWork", () => {
  test("a null shape (fetch failed) stays silent - alerts are best-effort", () => {
    expect(roundDidRealWork(null, true)).toBe(false);
  });

  test("real work notifies", () => {
    expect(roundDidRealWork(shape(), true)).toBe(true);
  });

  test("no real work stays silent", () => {
    expect(roundDidRealWork(shape(), false)).toBe(false);
  });

  test("synthetic-triggered rounds stay silent even with real work", () => {
    expect(roundDidRealWork(shape({ syntheticTrigger: true }), true)).toBe(false);
  });

  test("rounds that ended in an error stay silent (error alert owns it)", () => {
    expect(roundDidRealWork(shape({ roundError: "ProviderError" }), true)).toBe(false);
  });
});

describe("replyRequestID", () => {
  test("all reply events carry requestID (both lines)", () => {
    expect(replyRequestID({ requestID: "que_1" })).toBe("que_1");
    expect(replyRequestID({ requestID: "per_1" })).toBe("per_1");
  });

  test("absent or non-string ids resolve to undefined", () => {
    expect(replyRequestID({})).toBeUndefined();
    expect(replyRequestID(undefined)).toBeUndefined();
    expect(replyRequestID({ requestID: 42 })).toBeUndefined();
  });
});

describe("deriveRoundShape", () => {
  const user = (text: string): RoundMessage => ({ info: { role: "user" }, parts: [{ type: "text", text, synthetic: false }] });
  const assistant = (tools: string[], error?: string): RoundMessage => ({
    info: { role: "assistant", ...(error ? { error } : {}) },
    parts: [...tools.map((t) => ({ type: "tool", tool: t })), { type: "text", text: "done" }],
  });

  test("empty message list has no shape", () => {
    expect(deriveRoundShape(null)).toBeNull();
    expect(deriveRoundShape([])).toBeNull();
  });

  test("v2: the round is everything after the previous idle marker", () => {
    // Turn 1: user prompt, assistant work, idle marker appended by the host.
    // Turn 2 (the round under evaluation): synthetic nudge, assistant ack, marker.
    const messages: RoundMessage[] = [
      user("do the thing"),
      assistant(["read", "bash"]),
      { info: { role: "idle" }, parts: [{ type: "text", text: "" }] },
      { info: { role: "synthetic" }, parts: [{ type: "text", text: "nudge", synthetic: true }] },
      assistant(["thatch_extraction_done"]),
      { info: { role: "idle" }, parts: [{ type: "text", text: "" }] },
    ];
    const shape = deriveRoundShape(messages)!;
    // The newest marker delimits the round; the trigger is the synthetic
    // nudge inside it - NOT the marker itself (the pre-fix bug: the marker
    // hijacked the trigger scan and every v2 round looked empty).
    expect(shape.syntheticTrigger).toBe(true);
  });

  test("v2: a user-prompted round with real work is not synthetic", () => {
    const messages: RoundMessage[] = [
      user("do the thing"),
      assistant(["read"]),
      { info: { role: "idle" }, parts: [] },
      user("and now this"),
      assistant(["bash", "edit"]),
      { info: { role: "idle" }, parts: [] },
    ];
    const shape = deriveRoundShape(messages)!;
    expect(shape.syntheticTrigger).toBe(false);
  });

  test("v2: the round error comes from the last assistant message", () => {
    const messages: RoundMessage[] = [
      user("go"),
      assistant(["read"]),
      assistant(["bash"], "ProviderError"),
      { info: { role: "idle" }, parts: [] },
    ];
    expect(deriveRoundShape(messages)!.roundError).toBe("ProviderError");
  });

  test("v2: a mid-round steer does not truncate the round (marker delimiter)", () => {
    // The user steered mid-turn; the marker-based round still contains the
    // pre-steer assistant work (v1's trigger-scan cannot see this).
    const messages: RoundMessage[] = [
      user("long task"),
      assistant(["bash"]),
      user("also watch the output"),
      assistant(["edit", "write"]),
      { info: { role: "idle" }, parts: [] },
    ];
    const shape = deriveRoundShape(messages)!;
    expect(shape.syntheticTrigger).toBe(false); // the round starts at the real prompt
  });

  test("v1 (no markers): the newest non-assistant message triggers the round", () => {
    const messages: RoundMessage[] = [
      user("earlier task"),
      assistant(["read"]),
      user("latest prompt"),
      assistant(["bash", "edit"]),
    ];
    const shape = deriveRoundShape(messages)!;
    expect(shape.syntheticTrigger).toBe(false);
  });

  test("v1: a synthetic nudge user message (all parts synthetic) is a synthetic trigger", () => {
    const messages: RoundMessage[] = [
      user("earlier task"),
      assistant(["read"]),
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "nudge part", synthetic: true },
          { type: "text", text: "nudge part 2", synthetic: true },
        ],
      },
      assistant(["thatch_extraction_done"]),
    ];
    expect(deriveRoundShape(messages)!.syntheticTrigger).toBe(true);
  });

  test("v1: a real prompt with an appended nudge part is NOT synthetic", () => {
    const messages: RoundMessage[] = [
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "real prompt", synthetic: false },
          { type: "text", text: "nudge part", synthetic: true },
        ],
      },
      assistant(["bash"]),
    ];
    expect(deriveRoundShape(messages)!.syntheticTrigger).toBe(false);
  });
});

describe("alert state machine", () => {
  test("busy then idle with real work notifies once", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([{ kind: "done", title: "test session", message: "Work finished" }]);
    // A second idle without a new busy stays silent.
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toHaveLength(1);
  });

  test("idle without a busy transition stays silent (reload window)", async () => {
    const h = harness({}, shape());
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("real work from a previous round does not leak into a bookkeeping round", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    await h.machine.sessionIdle("s1");
    // New round: busy resets the real-work flag; a meta-only round stays silent.
    h.machine.sessionBusy("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toHaveLength(1);
  });

  test("user aborts stay silent", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    h.machine.sessionError("s1", "MessageAbortedError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("v2 shutdown interrupts stay silent", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    h.machine.sessionError("s1", "SessionShutdownError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("an unrecovered error notifies the error alert with the error name, not done", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    h.machine.sessionError("s1", "ProviderError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([
      { kind: "error", title: "test session", message: "Session needs attention - the last round failed (ProviderError)" },
    ]);
  });

  test("a v2 inactivity stall notifies needs-attention", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionError("s1", "SessionInactivityError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts[0].kind).toBe("error");
  });

  test("a retry clears the error but preserves real work (v1)", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    h.machine.sessionError("s1", "ApiError");
    // Retry: opencode recovered - but the tool calls before the retry
    // happened, so the real-work flag must survive the recovery.
    h.machine.sessionRetry("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([{ kind: "done", title: "test session", message: "Work finished" }]);
  });

  test("a recorded error delivers its verdict even when the message fetch fails", async () => {
    const h = harness({}, () => {
      throw new Error("host API down");
    });
    h.machine.sessionBusy("s1");
    h.machine.sessionError("s1", "ProviderError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([
      { kind: "error", title: "test session", message: "Session needs attention - the last round failed (ProviderError)" },
    ]);
  });

  test("superseded and unknown interrupt reasons stay silent", async () => {
    const h = harness({}, shape());
    for (const name of ["SessionInterruptedError", "SessionShutdownError", "MessageAbortedError"]) {
      h.machine.sessionBusy("s1");
      h.machine.sessionRealWork("s1");
      h.machine.sessionError("s1", name);
      await h.machine.sessionIdle("s1");
    }
    expect(h.alerts).toEqual([]);
  });

  test("a message-level abort error (v2 round shape) stays silent", async () => {
    const h = harness({}, shape({ roundError: "MessageAbortedError" }));
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("pause asks dedup per request id and clear on reply", async () => {
    const h = harness({});
    await h.machine.questionAsked("s1", "que_1");
    await h.machine.questionAsked("s1", "que_1");
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].kind).toBe("pause");
    h.machine.questionResolved("s1", "que_1");
    await h.machine.questionAsked("s1", "que_1");
    expect(h.alerts).toHaveLength(2);

    await h.machine.permissionAsked("s1", "per_1");
    await h.machine.permissionAsked("s1", "per_1");
    expect(h.alerts.filter((a) => a.message === "Permission needs your approval")).toHaveLength(1);
    h.machine.permissionResolved("s1", "per_1");
    await h.machine.permissionAsked("s1", "per_1");
    expect(h.alerts.filter((a) => a.message === "Permission needs your approval")).toHaveLength(2);
  });

  test("asks without a request id dedup per session until any reply", async () => {
    const h = harness({});
    await h.machine.questionAsked("s1", undefined);
    await h.machine.questionAsked("s1", undefined);
    expect(h.alerts).toHaveLength(1);
  });

  test("mode none silences an event kind", async () => {
    const config: Config = { alerts: { done: { mode: "none" }, pause: { mode: "none" } } };
    const h = harness(config, shape());
    await h.machine.questionAsked("s1", "que_1");
    expect(h.alerts).toEqual([]);
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("session deletion drops state", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionRealWork("s1");
    h.machine.sessionDeleted("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });
});

describe("alertMode", () => {
  test("unset config defaults to banner for every event kind", () => {
    expect(alertMode({}, "pause")).toBe("banner");
    expect(alertMode({}, "done")).toBe("banner");
    expect(alertMode({}, "error")).toBe("banner");
  });

  test("a per-event mode overrides the default", () => {
    const config: Config = { alerts: { done: { mode: "voice" } } };
    expect(alertMode(config, "done")).toBe("voice");
    expect(alertMode(config, "pause")).toBe("banner");
  });

  test("the alerts section round-trips through the config file (isolated tempdir)", () => {
    // M1 regression guard: saveConfig with no path writes the REAL user
    // config (~/.config/thatch/config.json). Always pass an isolated path.
    const dir = mkdtempSync(join(tmpdir(), "thatch-alerts-test-"));
    try {
      const config: Config = { alerts: { pause: { mode: "both" } } };
      const path = saveConfig(config, join(dir, "thatch.db"));
      expect(path).toBe(configFilePath(join(dir, "thatch.db")));
      expect(loadConfig(path).config).toEqual(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
