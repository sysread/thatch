import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";
import type { SpawnResult, Spawner } from "../../../src/notify";

/**
 * UC-096: Notifications and user config.
 *
 * Automatable: yes - the config tools read the config file path from
 * THATCH_DB_PATH (isolated to a tempdir here), and notify_user runs command
 * construction through an injectable spawner, so nothing fires a real banner
 * or speaks. The real end-to-end path (osascript banner + say voice, verified
 * by ear) is covered by the user doc workflow in docs/user/notifications.md.
 */

const useCase: UseCase = {
  name: "UC-096-notify-user",
  preconditions: [
    "- No prerequisites beyond the source tree; the mock spawner never runs a real command.",
  ].join("\n"),
  steps: [
    "1. Verify config_get, config_set, and notify_user are shared tools (available on all hosts).",
    "2. Use config_set to write notification prefs into a tempdir config file; verify field-level merge keeps sibling fields.",
    "3. Use config_get to read the config back; verify defaults are annotated for unset fields.",
    "4. Call notify_user with a mock spawner; verify the banner and voice commands and the source-prefixed spoken text.",
    "5. Set mode to none and call notify_user; verify it no-ops without spawning.",
  ].join("\n"),
  expected: [
    "- The three tools exist in TOOL_DEFS with no opencodeOnly flag.",
    "- config_set merges fields (omitted siblings keep their values) and echoes the resulting section.",
    "- config_get annotates unset fields with their platform defaults.",
    "- notify_user constructs an osascript banner and a /usr/bin/say voice command (darwin), prefixes the spoken text with the source label, and reports success without claiming the banner was seen.",
    "- mode: none produces a [skipped] result with zero spawned commands.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    // Step 1: the tools are shared across hosts.
    const names = ["config_get", "config_set", "notify_user"];
    for (const name of names) {
      const def = TOOL_DEFS.find((t) => t.name === name);
      if (!def) {
        console.log(`  FAIL: tool "${name}" missing from TOOL_DEFS`);
        return "FAIL";
      }
      if (def.opencodeOnly) {
        console.log(`  FAIL: "${name}" should be a shared tool (no host capabilities required)`);
        return "FAIL";
      }
    }

    // Isolate the config file from the developer's real ~/.config/thatch.
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc096-"));
    const prevDbPath = process.env.THATCH_DB_PATH;
    process.env.THATCH_DB_PATH = join(dbDir, "thatch.db");
    try {
      const recorded: string[] = [];
      const ok: SpawnResult = { exitCode: 0, stderr: "" };
      const spawner: Spawner = async (cmd) => {
        recorded.push(cmd.join(" "));
        return ok;
      };
      const ctx = { db: {}, model: {}, defaultStore: "acme/widgets", spawner } as unknown as CoreContext;
      const configSet = TOOL_DEFS.find((t) => t.name === "config_set")!;
      const configGet = TOOL_DEFS.find((t) => t.name === "config_get")!;
      const notifyUser = TOOL_DEFS.find((t) => t.name === "notify_user")!;

      // Step 2: config_set merges fields instead of wiping siblings.
      await configSet.execute({ notifications: { mode: "banner" } }, ctx);
      const result = await configSet.execute({ notifications: { voice: "Fred" } }, ctx);
      if (!(result.includes("mode: banner") && result.includes("voice: Fred"))) {
        console.log(`  FAIL: config_set did not merge fields, got: ${result}`);
        return "FAIL";
      }
      const written = JSON.parse(readFileSync(join(dbDir, "config.json"), "utf8"));
      if (written.notifications.mode !== "banner" || written.notifications.voice !== "Fred") {
        console.log("  FAIL: config file does not contain the merged section");
        return "FAIL";
      }

      // Step 3: config_get annotates unset fields with defaults.
      const got = await configGet.execute({}, ctx);
      if (!got.includes("sound: <unset>") || !got.includes("default:")) {
        console.log(`  FAIL: config_get did not annotate defaults, got: ${got}`);
        return "FAIL";
      }

      // Step 4: notify_user command construction (darwin assertions; the
      // qa runner runs on the author's macOS machine).
      if (process.platform === "darwin") {
        recorded.length = 0;
        const notified = await notifyUser.execute(
          { message: "C I is green", source: "UC-096", channel: "both" },
          ctx,
        );
        if (recorded.length !== 2) {
          console.log(`  FAIL: expected banner + voice commands, got ${recorded.length}`);
          return "FAIL";
        }
        if (!recorded[0].includes("/usr/bin/osascript") || !recorded[0].includes('with title "UC-096"')) {
          console.log(`  FAIL: banner command wrong: ${recorded[0]}`);
          return "FAIL";
        }
        if (!recorded[1].includes("/usr/bin/say -v Fred UC-096: C I is green")) {
          console.log(`  FAIL: voice command wrong (configured voice or source prefix missing): ${recorded[1]}`);
          return "FAIL";
        }
        if (!notified.startsWith("[notified]") || notified.includes("displayed") || notified.includes("seen")) {
          console.log(`  FAIL: result must not claim delivery, got: ${notified}`);
          return "FAIL";
        }
      }

      // Step 5: mode none no-ops.
      await configSet.execute({ notifications: { mode: "none" } }, ctx);
      recorded.length = 0;
      const skipped = await notifyUser.execute({ message: "hello" }, ctx);
      if (!skipped.startsWith("[skipped]") || recorded.length !== 0) {
        console.log(`  FAIL: mode none should no-op, got: ${skipped}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      if (prevDbPath === undefined) delete process.env.THATCH_DB_PATH;
      else process.env.THATCH_DB_PATH = prevDbPath;
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
