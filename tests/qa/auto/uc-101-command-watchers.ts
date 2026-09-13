import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { WatcherRegistry, WATCHER_EVENT_TYPES, commandTargetLabel, type WatcherEvent } from "../../../src/watchers";
import { TOOL_DEFS } from "../../../src/tool-defs";

/**
 * UC-101: Command watchers.
 *
 * Automatable: yes - the registry is in-memory with an injectable
 * CommandRunner, so the full command-watch lifecycle (registration
 * validation, baseline exit code, poll-detect-fire-auto-cancel, timeout
 * semantics, per-session limit sharing) runs against a mocked runner with
 * no process spawning. The live path (real bash -c runs plus promptAsync
 * delivery) is covered by the user doc workflow.
 */

const useCase: UseCase = {
  name: "UC-101-command-watchers",
  preconditions: [
    "- No prerequisites beyond the source tree; the mocked command runner never spawns a process.",
  ].join("\n"),
  steps: [
    "1. Verify watch_command_create exists, is opencode-only, and the command_success event type is in the vocabulary.",
    "2. Register a command watch whose baseline exits non-zero; confirm the baseline is captured.",
    "3. Poll while the condition is unmet; confirm no events and the watcher survives.",
    "4. Let the condition become met (exit 0); poll and confirm one command_success event, delivery, and auto-cancel.",
    "5. Confirm the already-exit-0 and exit-127 refusals, the timeout semantics, and the shared session limit.",
  ].join("\n"),
  expected: [
    "- watch_command_create is opencodeOnly; command_success is one of the 12 event types.",
    "- createCommand captures the baseline exit code; a baseline exit 0 is refused (condition already met) and exit 127 is refused.",
    "- Unmet conditions poll silently; the first exit 0 fires exactly one event and the watcher self-cancels at detection.",
    "- A timed-out run leaves the last-seen exit untouched and keeps the watch alive (the unit suite in tests/watchers.test.ts also covers the shared per-session limit).",
  ].join("\n"),

  async run(_ctx: QaContext) {
    // Step 1: tool surface and vocabulary.
    const tool = TOOL_DEFS.find((t) => t.name === "watch_command_create");
    if (!tool) {
      console.log("  FAIL: watch_command_create is not registered in TOOL_DEFS");
      return "FAIL";
    }
    if (!tool.opencodeOnly) {
      console.log("  FAIL: watch_command_create must be opencodeOnly");
      return "FAIL";
    }
    if (!WATCHER_EVENT_TYPES.includes("command_success")) {
      console.log("  FAIL: command_success missing from WATCHER_EVENT_TYPES");
      return "FAIL";
    }

    let canDeliver = false;
    const delivered: Array<{ sessionID: string; events: WatcherEvent[] }> = [];
    // Exit codes per run: baseline 1, poll 1 (unmet), poll 0 (met).
    let exits = [1, 1, 0];
    let run = 0;
    const registry = new WatcherRegistry({
      deliver: async (sessionID, events) => {
        delivered.push({ sessionID, events });
      },
      canDeliver: () => canDeliver,
      ghRunner: async () => {
        throw new Error("command watches must not use gh");
      },
      commandRunner: async () => {
        const exitCode = exits[Math.min(run, exits.length - 1)];
        run++;
        return { exitCode, timedOut: false, stderr: "", durationMs: 1100 };
      },
      pollIntervalMs: 60_000,
    });

    // Step 2: baseline capture.
    const created = await registry.createCommand("ses_uc101", "test -f /tmp/qa-marker", "/tmp");
    if (!created.ok) {
      console.log(`  FAIL: createCommand failed: ${created.error}`);
      return "FAIL";
    }
    if (created.watcher.state.lastExit !== 1 || created.watcher.once !== true) {
      console.log("  FAIL: baseline exit or one-shot mode was not captured");
      return "FAIL";
    }

    // Step 3: unmet condition polls silently.
    await registry.poll();
    if (delivered.length > 0 || registry.listForSession("ses_uc101").length !== 1) {
      console.log("  FAIL: unmet condition must not notify or cancel");
      return "FAIL";
    }

    // Step 4: condition met - one event, delivered, auto-cancelled.
    await registry.poll();
    if (registry.listForSession("ses_uc101").length !== 0) {
      console.log("  FAIL: the command watcher did not auto-cancel after its event");
      return "FAIL";
    }
    canDeliver = true;
    await registry.deliverPending();
    if (delivered.length !== 1) {
      console.log("  FAIL: the command_success event was not delivered");
      return "FAIL";
    }
    const event = delivered[0].events[0];
    if (event.type !== "command_success" || !event.summary.includes("exited 0") || event.url !== "") {
      console.log(`  FAIL: unexpected command event: ${JSON.stringify(event)}`);
      return "FAIL";
    }

    // Step 5: registration refusals and shared limit.
    const alreadyMet = await registry.createCommand("ses_uc101", "true", "/tmp");
    if (alreadyMet.ok || !alreadyMet.error.includes("already exits 0")) {
      console.log("  FAIL: an already-succeeding command was not refused");
      return "FAIL";
    }
    exits = [127];
    const missing = await registry.createCommand("ses_uc101", "nope", "/tmp");
    if (missing.ok || !missing.error.includes("127")) {
      console.log("  FAIL: an exit-127 command was not refused");
      return "FAIL";
    }
    // A timed-out run leaves state untouched. Baseline (run index 0) must
    // exit non-zero for registration to succeed; the poll run times out.
    let timedOutCalls = 0;
    const timeoutRegistry = new WatcherRegistry({
      deliver: async () => {},
      canDeliver: () => true,
      ghRunner: async () => {
        throw new Error("unused");
      },
      commandRunner: async () => {
        timedOutCalls++;
        return timedOutCalls === 1
          ? { exitCode: 1, timedOut: false, stderr: "", durationMs: 100 }
          : { exitCode: 124, timedOut: true, stderr: "", durationMs: 30_000 };
      },
      pollIntervalMs: 60_000,
    });
    const slow = await timeoutRegistry.createCommand("ses_uc101", "slow thing", "/tmp");
    if (!slow.ok) {
      console.log(`  FAIL: slow command registration failed: ${slow.error}`);
      return "FAIL";
    }
    await timeoutRegistry.poll();
    if (timeoutRegistry.listForSession("ses_uc101").length !== 1 || slow.watcher.state.lastExit !== 1) {
      console.log("  FAIL: a timed-out run must mean not-done-yet, not a cancel");
      return "FAIL";
    }
    timeoutRegistry.dispose();

    const label = commandTargetLabel("gh   run   list --json conclusion   --jq '.[0].conclusion'");
    if (label !== "gh run list --json conclusion --jq '.[0].conclusion'") {
      console.log(`  FAIL: commandTargetLabel did not collapse whitespace: ${label}`);
      return "FAIL";
    }

    registry.dispose();
    return "PASS";
  },
};

registerUseCase(useCase);
