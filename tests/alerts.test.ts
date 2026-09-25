import { describe, test, expect } from "bun:test";
import { createAlerts, roundDidRealWork, replyRequestID, type AlertInput, type AlertsDeps, type RoundShape } from "../src/alerts";
import { alertMode, loadConfig, saveConfig, type Config } from "../src/config";

// The alert state machine with all delivery faked out. Records every
// notified alert; roundShape and titles are injectable per test.
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
  return { syntheticTrigger: false, toolCalls: ["read", "bash"], roundError: null, ...overrides };
}

describe("roundDidRealWork", () => {
  test("a null shape (fetch failed) stays silent - alerts are best-effort", () => {
    expect(roundDidRealWork(null)).toBe(false);
  });

  test("real tool calls notify", () => {
    expect(roundDidRealWork(shape())).toBe(true);
  });

  test("synthetic-triggered rounds stay silent", () => {
    expect(roundDidRealWork(shape({ syntheticTrigger: true }))).toBe(false);
  });

  test("rounds that ended in an error stay silent (error alert owns it)", () => {
    expect(roundDidRealWork(shape({ roundError: "ProviderError" }))).toBe(false);
  });

  test("meta-only rounds stay silent", () => {
    expect(roundDidRealWork(shape({ toolCalls: ["thatch_recall", "thatch_memory_remember"] }))).toBe(false);
    expect(roundDidRealWork(shape({ toolCalls: ["skill", "task"] }))).toBe(false);
    expect(roundDidRealWork(shape({ toolCalls: ["subagent"] }))).toBe(false);
    expect(roundDidRealWork(shape({ toolCalls: ["todowrite", "question"] }))).toBe(false);
  });

  test("a round that mixed meta tools with real work notifies", () => {
    expect(roundDidRealWork(shape({ toolCalls: ["thatch_recall", "read"] }))).toBe(true);
  });

  test("a round with no tool calls did no work", () => {
    expect(roundDidRealWork(shape({ toolCalls: [] }))).toBe(false);
  });
});

describe("replyRequestID", () => {
  test("requestID (v2 / question replies)", () => {
    expect(replyRequestID({ requestID: "que_1" })).toBe("que_1");
  });

  test("permissionID (v1 permission replies)", () => {
    expect(replyRequestID({ permissionID: "per_1" })).toBe("per_1");
  });

  test("absent or non-string ids resolve to undefined", () => {
    expect(replyRequestID({})).toBeUndefined();
    expect(replyRequestID(undefined)).toBeUndefined();
    expect(replyRequestID({ requestID: 42 })).toBeUndefined();
  });
});

describe("alert state machine", () => {
  test("busy then idle with real work notifies once", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
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

  test("synthetic-triggered and meta-only rounds stay silent", async () => {
    const h = harness({}, shape({ syntheticTrigger: true }));
    h.machine.sessionBusy("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);

    const h2 = harness({}, shape({ toolCalls: ["thatch_extraction_done"] }));
    h2.machine.sessionBusy("s2");
    await h2.machine.sessionIdle("s2");
    expect(h2.alerts).toEqual([]);
  });

  test("user aborts stay silent", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionError("s1", "MessageAbortedError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("an unrecovered error notifies the error alert, not done", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionError("s1", "ApiError");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([{ kind: "error", title: "test session", message: "Session needs attention - the last round failed" }]);
  });

  test("a retry clears the error - the round completes normally", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
    h.machine.sessionError("s1", "ApiError");
    h.machine.sessionBusy("s1");
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([{ kind: "done", title: "test session", message: "Work finished" }]);
  });

  test("a message-level abort error (v2 round shape) stays silent", async () => {
    const h = harness({}, shape({ roundError: "MessageAbortedError" }));
    h.machine.sessionBusy("s1");
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
    await h.machine.sessionIdle("s1");
    expect(h.alerts).toEqual([]);
  });

  test("session deletion drops state", async () => {
    const h = harness({}, shape());
    h.machine.sessionBusy("s1");
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

  test("the alerts section round-trips through the config file", () => {
    const config: Config = { alerts: { pause: { mode: "both" } } };
    const path = saveConfig(config);
    expect(loadConfig(path).config).toEqual(config);
  });
});
