import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin for the concurrent-run fixture wipe (reproduced 2026-11-05 by
 * overlapping two `bin/qa-run` invocations): the runner used to share
 * /tmp/thatch-qa and $TMPDIR/thatch-qa-master across processes, so the
 * second run's master setup (rmSync of both roots) deleted the first
 * run's LIVE fixtures mid-test. That surfaced as "SQLiteError: disk I/O
 * error" in UC-100's serve, exit-1 saves in UC-131, and empty CLI output
 * in UC-132/130 - the week's qa-auto flake family. The runner now scopes
 * its roots per process (RUN_ID).
 *
 * Both phases run in real subprocesses because the isolation contract is
 * BETWEEN processes: two fresh runner imports must get disjoint roots,
 * and one run's ensureMaster must not delete another run's fixtures.
 */

const RUNNER = join(import.meta.dir, "qa", "runner.ts");

const VICTIM_SCRIPT = `
const r = await import(${JSON.stringify(RUNNER)});
const fs = require("fs");
await r.ensureMaster();
const { qaRoot } = r.qaPaths();
const ctx = await r.createFixture("pin-isolation-victim");
const sentinel = require("path").join(ctx.dir, "victim-sentinel.txt");
await Bun.write(sentinel, "live");
// Synchronous write to fd 1: process.stdout pipes lose buffered data when
// the process exits (process.exit races the flush).
fs.writeSync(1, JSON.stringify({ qaRoot }) + "\\n");
// Give the attacker run time to boot and do its own master setup, then
// verify this run's fixture still exists.
await new Promise((res) => setTimeout(res, 10_000));
if (!fs.existsSync(sentinel)) {
  fs.writeSync(2, "VICTIM FIXTURE WIPED by the concurrent run's master setup\\n");
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
`;

const ATTACKER_SCRIPT = `
const r = await import(${JSON.stringify(RUNNER)});
await r.ensureMaster();
require("fs").writeSync(1, JSON.stringify(r.qaPaths()) + "\\n");
process.exitCode = 0;
`;

async function runScript(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe("qa runner concurrent-run isolation", () => {
  // Budget: two master builds (~5s each, concurrent) plus the victim's
  // 10s watch window. 60s = ~3x that expected cost.
  test("two concurrent runner processes get disjoint roots and one run's setup never deletes the other's fixtures", async () => {
    const [victim, attacker] = await Promise.all([
      runScript(VICTIM_SCRIPT),
      runScript(ATTACKER_SCRIPT),
    ]);

    if (victim.code !== 0 || attacker.code !== 0) {
      writeFileSync("/tmp/thatch-pin-debug.log", `VICTIM code=${victim.code}\nVICTIM OUT: ${victim.stdout}\nVICTIM ERR: ${victim.stderr}\nATTACKER code=${attacker.code}\nATTACKER OUT: ${attacker.stdout}\nATTACKER ERR: ${attacker.stderr}`);
    }

    const victimRoots = (() => {
      try {
        return JSON.parse(victim.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
      } catch {
        return {};
      }
    })();
    const attackerRoots = (() => {
      try {
        return JSON.parse(attacker.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
      } catch {
        return {};
      }
    })();

    // Both subprocesses must have completed their runner setup.
    expect(victimRoots.qaRoot).toBeTruthy();
    expect(attackerRoots.qaRoot).toBeTruthy();

    // The core isolation contract: disjoint run roots.
    expect(victimRoots.qaRoot).not.toBe(attackerRoots.qaRoot);
    expect(victimRoots.masterRoot).not.toBe(attackerRoots.masterRoot);

    // And the victim's fixture survived the attacker's master setup.
    expect(victim.code).toBe(0);
    if (victim.code !== 0) {
      console.log(`victim stderr: ${victim.stderr.slice(0, 500)}`);
      console.log(`attacker stderr: ${attacker.stderr.slice(0, 500)}`);
    }
  }, 60_000);
});
