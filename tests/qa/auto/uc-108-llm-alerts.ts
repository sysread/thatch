import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { createAlerts, deriveRoundShape, type AlertInput, type AlertsDeps, type RoundShape } from "../../../src/alerts";
import { mapSessionContextMessages, translateEvent } from "../../../src/opencode/v2";
import { alertMode, loadConfig, saveConfig, type Config } from "../../../src/config";

/**
 * UC-108: LLM alerts - pause, done, and error notifications.
 *
 * Automatable: yes - the state machine is pure logic with injected config
 * and delivery (createAlerts), so the full event flow runs here with a
 * synchronous spy notifier and no real banner or voice. This use case also
 * covers the adapter seam the unit tests cannot: raw v2 bus events and
 * session.context message lists, translated and derived exactly as the
 * running adapter does it. A real banner off a live session (the osascript
 * path, verified by ear) remains a manual check against a live session -
 * no automated use case can assert a banner was seen.
 */

const useCase: UseCase = {
  name: "UC-108-llm-alerts",
  preconditions: [
    "- No prerequisites beyond the source tree; the notifier is a spy and no command ever spawns.",
  ].join("\n"),
  steps: [
    "1. Verify the alerts config section: default mode is banner per event, and alertMode resolves each kind.",
    "2. Drive the adapter seam: translate v2 bus events (execution.succeeded, execution.failed, execution.interrupted, question.asked) and derive round shapes from mapped session.context lists - including the host's idle marker that terminates a round.",
    "3. Drive the pause flow: question.asked notifies once (deduped), the reply clears it, a re-ask notifies again. Same for permissions.",
    "4. Drive the done flow: busy then idle with real work notifies exactly once; a repeat idle stays silent.",
    "5. Drive the silence rules: synthetic-triggered rounds, bookkeeping-only rounds, user aborts, and shutdowns never notify.",
    "6. Drive the error flow: an execution failure (error + idle pair) notifies needs-attention; mode none silences exactly its own event kind.",
  ].join("\n"),
  expected: [
    "- alertMode defaults to banner for pause, done, and error; the alerts section round-trips through the config file.",
    "- translateEvent maps execution.failed to session.error + idle (the error verdict fires) and user-reason interrupts to an abort-named error + idle (silent).",
    "- deriveRoundShape uses the host's idle marker as the round delimiter: the marker itself never hijacks the trigger scan, and pre-steer work stays in the round.",
    "- Pause asks dedup per request id and re-arm after their reply event.",
    "- Done fires once per busy->idle transition with real work; synthetic-triggered and bookkeeping-only rounds stay silent.",
    "- mode: none silences exactly its own event kind.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    // Step 1: config defaults and round-trip (isolated tempdir - a bare
    // saveConfig would overwrite the developer's real user config).
    const dbPath = `${_ctx.dir}/thatch.db`;
    const config: Config = { alerts: { done: { mode: "both" } } };
    saveConfig(config, dbPath);
    const loaded = loadConfig(dbPath).config;
    if (alertMode(loaded, "pause") !== "banner" || alertMode(loaded, "done") !== "both" || alertMode(loaded, "error") !== "banner") {
      console.log("  FAIL: alertMode defaults or override wrong");
      return "FAIL";
    }

    // Step 2: the adapter seam - v2 events and message lists, translated
    // and derived exactly as the running v2 adapter does it.
    const failedPair = translateEvent({ type: "session.execution.failed", data: { sessionID: "ses_x", error: { type: "ProviderError", message: "boom" } } });
    if (failedPair.length !== 2 || failedPair[0].type !== "session.error" || failedPair[1].type !== "session.status") {
      console.log("  FAIL: execution.failed did not translate to the error+idle pair");
      return "FAIL";
    }
    const userInterrupt = translateEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_x", reason: "user" } });
    if (userInterrupt[0].properties.error.name !== "MessageAbortedError") {
      console.log("  FAIL: user interrupt did not translate to an abort-named error");
      return "FAIL";
    }
    const shutdownInterrupt = translateEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_x", reason: "shutdown" } });
    if (shutdownInterrupt[0].properties.error.name !== "SessionShutdownError") {
      console.log("  FAIL: shutdown interrupt did not translate to a shutdown-named error");
      return "FAIL";
    }

    // A real-shaped v2 message list: turn 1 (real work, host idle marker),
    // turn 2 (the nudge round under evaluation, host idle marker last).
    const v2Context = [
      { type: "user", text: "do the thing" },
      {
        type: "assistant",
        content: [{ type: "reasoning", text: "hmm" }, { type: "tool", name: "read" }, { type: "text", text: "done" }],
      },
      { type: "idle" },
      { type: "synthetic", text: "nudge" },
      { type: "assistant", content: [{ type: "tool", name: "thatch_extraction_done" }, { type: "text", text: "ok" }] },
      { type: "idle" },
    ];
    const shape = deriveRoundShape(mapSessionContextMessages(v2Context));
    if (!shape || shape.syntheticTrigger !== true) {
      console.log("  FAIL: the idle-marker round did not resolve to its synthetic trigger");
      return "FAIL";
    }
    const realContext = [
      { type: "user", text: "do the thing" },
      { type: "assistant", content: [{ type: "tool", name: "bash" }, { type: "text", text: "done" }] },
      { type: "idle" },
    ];
    const realShape = deriveRoundShape(mapSessionContextMessages(realContext));
    if (!realShape || realShape.syntheticTrigger !== false) {
      console.log("  FAIL: a user-prompted round derived as synthetic");
      return "FAIL";
    }
    // The message-level error rides the mapping into the round shape (the
    // v2 error path when no session.error event carried the verdict).
    const erroredContext = [
      { type: "user", text: "do the thing" },
      {
        type: "assistant",
        content: [{ type: "tool", name: "bash" }, { type: "text", text: "ok" }],
        error: { type: "ProviderError", message: "boom" },
      },
      { type: "idle" },
    ];
    const erroredShape = deriveRoundShape(mapSessionContextMessages(erroredContext));
    if (!erroredShape || erroredShape.roundError !== "ProviderError") {
      console.log("  FAIL: message-level error did not reach the round shape");
      return "FAIL";
    }

    // Spy harness over the real state machine (synchronous spy: the
    // machine fire-and-forgets delivery, so the spy must record before the
    // promise resolves).
    let nextShape: RoundShape | null = { syntheticTrigger: false, roundError: null };
    const alerts: AlertInput[] = [];
    const deps: AlertsDeps = {
      config: () => loadConfig(dbPath).config,
      roundShape: async () => nextShape,
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

    // Step 3: pause flow - dedup, reply clears, re-ask notifies again.
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

    // Step 4: done flow - one notification per busy->idle with real work.
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    await machine.sessionIdle("s1");
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 2) return fail("done did not fire exactly once per real round");

    // Step 5: silence rules.
    nextShape = { syntheticTrigger: true, roundError: null };
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    await machine.sessionIdle("s1");
    nextShape = { syntheticTrigger: false, roundError: null };
    machine.sessionBusy("s1");
    await machine.sessionIdle("s1");
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    machine.sessionError("s1", "MessageAbortedError");
    await machine.sessionIdle("s1");
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    machine.sessionError("s1", "SessionShutdownError");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 2) return fail("a silent-rule round notified done");
    if (alerts.some((a) => a.kind === "error")) return fail("a user abort or shutdown notified");

    // Step 6: error flow - the v2 failed pair delivers the verdict (the
    // runtime extracts the error NAME from the pair's payload before
    // calling the machine - passing the raw object would degrade the alert
    // message to "[object Object]", so this drives the machine the way
    // production does); mode none silences only its own kind.
    const events = translateEvent({ type: "session.execution.failed", data: { sessionID: "s1", error: { type: "ProviderError" } } });
    for (const event of events) {
      if (event.type === "session.error") {
        const err = event.properties.error as { name?: string; type?: string } | undefined;
        await machine.sessionError("s1", err?.name ?? err?.type ?? null);
      } else {
        await machine.sessionIdle("s1");
      }
    }
    await machine.sessionIdle("s1");
    const errorAlerts = alerts.filter((a) => a.kind === "error");
    if (errorAlerts.length !== 1) return fail("unrecovered error did not notify needs-attention");
    if (!errorAlerts[0].message.includes("ProviderError")) return fail("error alert message lost the error name");
    // Inactivity: the location-activity sweeper evicting a quiet directory
    // is the one interrupt that must banner.
    const inactivity = translateEvent({ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "inactivity" } });
    for (const event of inactivity) {
      if (event.type === "session.error") {
        const err = event.properties.error as { name?: string; type?: string } | undefined;
        machine.sessionError("s1", err?.name ?? err?.type ?? null);
      } else {
        await machine.sessionIdle("s1");
      }
    }
    if (alerts.filter((a) => a.kind === "error").length !== 2) return fail("inactivity interrupt did not notify needs-attention");
    // Unknown interrupt reasons (the schema reserves "superseded") map to
    // the silent catch-all, never a banner.
    const superseded = translateEvent({ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "superseded" } });
    const supName = (superseded[0].properties.error as { name?: string }).name;
    if (supName !== "SessionInterruptedError") return fail("unknown interrupt reason mapped to the wrong name");
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    machine.sessionError("s1", supName);
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "error").length !== 2) return fail("superseded interrupt bannered");
    saveConfig({ alerts: { done: { mode: "none" } } }, dbPath);
    machine.sessionBusy("s1");
    machine.sessionRealWork("s1");
    await machine.sessionIdle("s1");
    if (alerts.filter((a) => a.kind === "done").length !== 2) return fail("done mode none still notified");
    await machine.questionAsked("s1", "que_9");
    // Pause count: two question asks, one permission ask, this re-ask -
    // mode none on done must not leak into any of them.
    if (alerts.filter((a) => a.kind === "pause").length !== 4) return fail("mode none on done leaked into pause");

    return "PASS";
  },
};

registerUseCase(useCase);
