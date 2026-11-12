/**
 * The notifications subcommand: prints the notification journal. The
 * journal (src/notify.ts records it, ThatchDB stores it) exists because a
 * desktop banner is write-only - its text cannot be selected or copied,
 * and clicking an osascript banner opens a Script Editor file dialog -
 * so `thatch notifications` is where the user reads and copies what was
 * said.
 */
import { flagValue } from "../args";
import type { Subcommand } from "../types";

export const DEFAULT_JOURNAL_LIMIT = 10;
export const MAX_JOURNAL_LIMIT = 100;

export const notifications: Subcommand = {
  name: "notifications",
  summary: "Print recent notification journal rows, newest last",
  usage: () => ({
    synopsis: "thatch notifications [--limit N]",
    flags: [
      {
        long: "--limit",
        short: null,
        description: `Rows to print, newest last. Default ${DEFAULT_JOURNAL_LIMIT}, maximum ${MAX_JOURNAL_LIMIT}.`,
      },
    ],
    notes: [
      "Every banner/voice delivery attempt lands in the journal - the tool calls, the automatic alerts, and suppressed attempts (THATCH_NO_NOTIFY). Each line is time, source, channel, and message; a row whose outcome is not delivered is marked [failed], [suppressed], or [unsupported] at the end of its line.",
    ],
  }),
  async run(args, ctx) {
    let limit = DEFAULT_JOURNAL_LIMIT;
    const raw = flagValue(args, "--limit");
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`error: --limit expects a positive integer, got "${raw}"`);
        process.exit(1);
      }
      limit = Math.min(n, MAX_JOURNAL_LIMIT);
    }
    const rows = ctx.db.listNotifyJournal(limit);
    if (rows.length === 0) {
      console.log("No notifications journaled yet.");
      return;
    }
    for (const r of rows) {
      const time = r.created_at.slice(0, 19).replace("T", " ");
      // Delivered rows stay clean; every other outcome says so, because a
      // line that prints a failed or suppressed attempt exactly like a
      // delivered one misleads.
      const mark = r.outcome === "delivered" ? "" : ` [${r.outcome}]`;
      const source = r.source || "-";
      console.log(`${time} ${source} ${r.channel} ${r.message}${mark}`);
    }
  },
};
