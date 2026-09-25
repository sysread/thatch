import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { createAlerts, type AlertInput, type AlertsDeps, type RoundShape } from "../../../src/alerts";
import { alertMode, loadConfig, saveConfig, type Config } from "../../../src/config";

/**
 * UC-108: LLM alerts - pause, done, and error notifications.
 *
 * Automatable: yes - the alert state machine is pure in-memory logic with
 * injected config and delivery (createAlerts), so the full event flow
 * (ask -> reply, busy -> idle, error -> retry -> idle, abort silence)
 * runs here with a spy notifier and no real banner or voice. The live
 * end-to-end path (real events from a running opencode session, real
 * osascript banner) is covered by the manual scenarios in
 * docs/user/notifications.md.
 */

const useCase: UseCase = {
  name: "UC-108-llm-alerts",
  preconditions: [
    "- No prerequisites beyond the source tree; the notifier is a spy and no command ever spawns.",
  ].join("\n"),
  steps: [
    "1. Verify the alerts config section: default mode is banner per event, and alertMode resolves each kind.",
    "2. Drive the state machine through the pause flow: question.asked notifies once (deduped), the reply clears it, a re-ask notifies again. Same for permissions.",
    "3. Drive the done flow: busy then idle with a real-work round shape notifies exactly once; a repeat idle stays silent.",
    "4. Drive the silence rules: synthetic-triggered rounds, meta-only rounds, and user aborts never notify.",
    "5. Drive the error flow: error then idle notifies needs-attention; a retry before idle restores the normal done alert.",
    "6. Set mode none and verify the matching event kind goes silent.",
  ].join("\n"),
  expected: [
    "- alertMode defaults to banner for pause, done, and error; the alerts section round-trips through the config file.",
    "- Pause asks dedup per request id and re-arm after their reply event.",
    "- Done fires once per busy->idle transition and only for real work.",
    "- Synthetic-triggered, meta-only, and aborted rounds stay silent.",
    "- Unrecovered errors notify needs-attention; retried errors notify done when the round completes.",
    "- mode: none silences exactly its own event kind.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    // Step 1: config defaults and round-trip.
    const dbPath = `${_ctx.dir}/thatch.db`;
    const config: Config = { alerts: { done: { mode: "both" } } };
    saveConfig(config, dbPath);
    const loaded = loadConfig(dbPath).config;
    if (alertMode(loaded, "pause") !== "banner" || alertMode(loaded, "done") !== "both" || alertMode(loaded, "error") !== "banner") {
      console.log("  FAIL: alertMode defaults or override wrong");
      return "FAIL";
    }

    // Spy harness over the real state machine.
    const roundShapes: (RoundShape | null)[] = [null];
    const alerts: AlertInput[] = [];
    const deps: AlertsDeps = {
      config: () => loadConfig(dbPath).config,
      roundShape: async () => roundShapes[roundShapes.length - 1] ?? null,
      sessionTitle: async () => "uc-108 session",
      notify: async (input) => {
        alerts.push(input);
      },
    };
    const machine = createAlerts(deps);
    const fail = (why: string) => {
      console.log(`  FAIL: ${why}`);
      return "FAIL" as const;
    };

    // Step 2: pause flow - dedup, reply clears, re-ask notifies again.
    await machine.questionAsked("s1", "que_1");
    await machine.questionAsked("s1", "que_1");
    if (alerts.filter((a) => a.kind === "pause").length !== 1) return fail("question ask did not dedup");
    machine.questionResolved("s1", "que_1");
    await machine.questionAsked("s1", "que_1");
    if (alerts.filter((a) => a.kind === "pause").length !== 2) return fail("question reply did not re-arm the ask");
    await machine.permissionAsked("s1", "per_1");
    machine.permissionResolved("s1", "per_1");
    if (alerts.filter((a) => a.message === "Permission needs your approval").length !== 1) {
      return fail("permission pause flow wrong");
    }

    // Step 3: done flow - one notification per busy->idle with real work.
    roundShapes.push({ syntheticTrigger: false, toolCalls: ["read", "bash"], roundError: null });
    machine.sessionBusy("s1");
    await machine.sessionIdle("s1");
    machine.sessionBusy("s1");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 2) return fail("done did not fire exactly once per real round");

    // Step 4: silence rules.
    roundShapes.push({ syntheticTrigger: true, toolCalls: ["read"], roundError: null });
    machine.sessionBusy("s1");
    await machine.sessionIdle("s1");
    roundShapes.push({ syntheticTrigger: false, toolCalls: ["skill", "task"], roundError: null });
    machine.sessionBusy("s1");
    await machine.sessionIdle("s1");
    machine.sessionBusy("s1");
    machine.sessionError("s1", "MessageAbortedError");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 2) return fail("a silent-rule round notified done");
    if (alerts.some((a) => a.kind === "error")) return fail("a user abort notified");

    // Step 5: error flow - unrecovered error notifies, retry recovers.
    machine.sessionBusy("s1");
    machine.sessionError("s1", "ApiError");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "error").length !== 1) return fail("unrecovered error did not notify needs-attention");
    machine.sessionBusy("s1");
    machine.sessionError("s1", "ApiError");
    machine.sessionBusy("s1");
    // The retried round completes with real work - point the round-shape
    // fetcher at a real-work round (step 4 left a meta-only shape in place).
    roundShapes.push({ syntheticTrigger: false, toolCalls: ["read"], roundError: null });
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 3) return fail("retry did not restore the done alert");

    // Step 6: mode none silences only its own kind.
    saveConfig({ alerts: { done: { mode: "none" } } }, dbPath);
    machine.sessionBusy("s1");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 3) return fail("done mode none still notified");
    await machine.questionAsked("s1", "que_9");
    // Pause count: two question asks from step 2, one permission ask, this
    // re-ask - mode none on done must not leak into any of them.
    if (alerts.filter((a) => a.kind === "pause").length !== 4) return fail("mode none on done leaked into pause");

    return "PASS";
  },
};

registerUseCase(useCase);
