import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";
import { ThatchDB } from "../../../src/db";
import type { NotifyJournalEntry, SpawnResult, Spawner } from "../../../src/notify";

/**
 * UC-147: The notification journal and its CLI.
 *
 * Automatable: yes - the QA suite sets THATCH_NO_NOTIFY=1 (tests/
 * clean-env.ts), so the notify_user dispatch below fires nothing and the
 * journal row carries outcome "suppressed"; a real banner/voice delivery
 * remains a manual by-ear check (docs/user/notifications.md). The CLI
 * leg runs bin/thatch notifications against the same tempdir database
 * the in-process rows landed in.
 */

const useCase: UseCase = {
  name: "UC-147-notification-journal",
  preconditions: [
    "- No prerequisites beyond the source tree; THATCH_NO_NOTIFY is set by the suite, so no banner or voice ever fires.",
  ].join("\n"),
  steps: [
    "1. Bind notify_user's ctx.notifyJournal to a tempdir ThatchDB and call the tool; the suite's THATCH_NO_NOTIFY=1 means nothing dispatches.",
    "2. Read the journal back through ThatchDB: one row, outcome suppressed, with the channel, source, and message as passed.",
    "3. Seed more rows through ThatchDB.recordNotifyJournal, then run `thatch notifications`, `--limit N`, and a large limit against the same database.",
    "4. Run `thatch notifications --limit bogus` and `--limit 0`; both die loudly with exit 1.",
  ].join("\n"),
  expected: [
    "- The tool result is the [suppressed] line and zero commands spawned; the journal holds one row with outcome 'suppressed'.",
    "- `thatch notifications` prints one line per row (time, source, channel, message), newest last, and marks non-delivered outcomes in brackets.",
    "- `--limit N` bounds the row count to the N newest; the default is 10.",
    "- A non-integer or non-positive --limit is an error with exit 1.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc147-"));
    const dbPath = join(dbDir, "thatch.db");
    const db = new ThatchDB(dbPath);
    const recorded: string[] = [];
    const ok: SpawnResult = { exitCode: 0, stderr: "" };
    const spawner: Spawner = async (cmd) => {
      if (cmd[0] === "/usr/bin/which") return { exitCode: 1, stderr: "" };
      recorded.push(cmd.join(" "));
      return ok;
    };
    try {
      // Step 1: the tool call under the suite's THATCH_NO_NOTIFY=1. The
      // guard must be standing for this use case's premise to hold.
      if (process.env.THATCH_NO_NOTIFY !== "1") {
        console.log("  FAIL: expected the QA env to set THATCH_NO_NOTIFY=1");
        return "FAIL";
      }
      const notifyUser = TOOL_DEFS.find((t) => t.name === "notify_user")!;
      if (!notifyUser) {
        console.log('  FAIL: notify_user missing from TOOL_DEFS');
        return "FAIL";
      }
      const journal: ((entry: NotifyJournalEntry) => void) = (entry) => db.recordNotifyJournal(entry);
      const toolCtx = {
        db: db as CoreContext["db"],
        model: {} as CoreContext["model"],
        defaultStore: "acme/widgets",
        spawner,
        notifyJournal: journal,
      } as unknown as CoreContext;
      const result = await notifyUser.execute(
        { message: "C I is green", source: "UC-147", channel: "both" },
        toolCtx,
      );
      if (!result.includes("[suppressed]")) {
        console.log(`  FAIL: expected the suppression result, got: ${result}`);
        return "FAIL";
      }
      if (recorded.length !== 0) {
        console.log(`  FAIL: dispatched ${recorded.length} commands under THATCH_NO_NOTIFY=1`);
        return "FAIL";
      }

      // Step 2: the suppressed row, exactly as passed.
      const rows = db.listNotifyJournal(10);
      if (rows.length !== 1) {
        console.log(`  FAIL: expected 1 journal row, found ${rows.length}`);
        return "FAIL";
      }
      if (
        rows[0].outcome !== "suppressed" || rows[0].channel !== "both" ||
        rows[0].source !== "UC-147" || rows[0].message !== "C I is green"
      ) {
        console.log(`  FAIL: suppressed row wrong: ${JSON.stringify(rows[0])}`);
        return "FAIL";
      }

      // Step 3: seed older rows, then read the journal back through the
      // CLI against this same database file.
      for (let i = 0; i < 12; i++) {
        db.recordNotifyJournal({
          channel: "banner",
          source: `seed-${i}`,
          title: "",
          message: `seed message ${i}`,
          outcome: "delivered",
        });
      }
      db.close();

      const bin = `${ctx.repoRoot}/bin/thatch`;
      const env = { ...ctx.env, THATCH_DB_PATH: dbPath };
      const defaultRun = await $`${bin} notifications`.env(env).quiet().nothrow();
      if (defaultRun.exitCode !== 0) {
        console.log(`  FAIL: thatch notifications exited ${defaultRun.exitCode}`);
        return "FAIL";
      }
      const defaultLines = defaultRun.stdout.toString().trim().split("\n");
      // 13 rows total; the default limit shows the newest 10, newest last.
      if (defaultLines.length !== 10) {
        console.log(`  FAIL: expected 10 lines by default, got ${defaultLines.length}`);
        return "FAIL";
      }
      if (!defaultLines[defaultLines.length - 1].includes("seed message 11")) {
        console.log(`  FAIL: newest row should be last, got: ${defaultLines[defaultLines.length - 1]}`);
        return "FAIL";
      }
      if (!defaultLines.every((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(l))) {
        console.log(`  FAIL: line shape wrong (time, source, channel, message): ${defaultLines[0]}`);
        return "FAIL";
      }

      const allRun = await $`${bin} notifications --limit 13`.env(env).quiet().nothrow();
      const allLines = allRun.stdout.toString().trim().split("\n");
      if (allRun.exitCode !== 0 || allLines.length !== 13) {
        console.log(`  FAIL: --limit 13 should print all 13 rows, got ${allLines.length}`);
        return "FAIL";
      }
      // The oldest row is the suppressed attempt: first line, marked.
      if (!allLines[0].includes("UC-147") || !allLines[0].includes("C I is green") || !allLines[0].includes("[suppressed]")) {
        console.log(`  FAIL: suppressed row not rendered first with its mark: ${allLines[0]}`);
        return "FAIL";
      }
      if (allLines.some((l, i) => i > 0 && l.includes("[suppressed]"))) {
        console.log("  FAIL: only the suppressed row should carry a mark");
        return "FAIL";
      }

      const fewRun = await $`${bin} notifications --limit=3`.env(env).quiet().nothrow();
      const fewLines = fewRun.stdout.toString().trim().split("\n");
      if (fewRun.exitCode !== 0 || fewLines.length !== 3 || !fewLines[2].includes("seed message 11")) {
        console.log(`  FAIL: --limit=3 should print the 3 newest (newest last), got: ${fewLines.join(" | ")}`);
        return "FAIL";
      }

      // Step 4: bad limits die loudly.
      const bogus = await $`${bin} notifications --limit bogus`.env(env).quiet().nothrow();
      if (bogus.exitCode === 0) {
        console.log("  FAIL: --limit bogus should exit 1");
        return "FAIL";
      }
      const zero = await $`${bin} notifications --limit 0`.env(env).quiet().nothrow();
      if (zero.exitCode === 0) {
        console.log("  FAIL: --limit 0 should exit 1");
        return "FAIL";
      }

      return "PASS";
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
