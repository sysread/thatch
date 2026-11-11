/**
 * The doctor command: runs src/doctor.ts's checks and renders the
 * findings. Output is the command's product, so it goes to stdout -
 * pipeable and greppable; verdict tags take color only on a terminal
 * without NO_COLOR (the chat roster's rule). Exit code 1 only when a
 * check failed (warnings do not fail the run).
 */
import { homedir } from "node:os";
import { collectDoctorFindings, doctorExitCode, type DoctorFinding, type DoctorSection } from "../../doctor";
import { projectDir } from "../context";
import type { Subcommand } from "../types";

const SECTION_ORDER: DoctorSection[] = ["common", "opencode", "claude", "cursor"];

/** The verdict tag, colored on a terminal; plain everywhere else. */
function renderVerdict(verdict: DoctorFinding["verdict"], colored: boolean): string {
  const plain = `[${verdict}]`;
  if (!colored) return plain;
  const code = verdict === "pass" ? "32" : verdict === "warn" ? "33" : verdict === "fail" ? "31" : "36";
  return `\x1b[${code}m${plain}\x1b[0m`;
}

/** Prints the findings grouped by section, then a one-line summary. */
export function printDoctorFindings(findings: DoctorFinding[]): void {
  const colored = process.stdout.isTTY === true && !process.env.NO_COLOR;
  for (const section of SECTION_ORDER) {
    const rows = findings.filter((f) => f.section === section);
    if (rows.length === 0) continue;
    console.log(section);
    for (const f of rows) {
      console.log(`  ${renderVerdict(f.verdict, colored)} ${f.check}: ${f.detail}`);
      if (f.fix) console.log(`      fix: ${f.fix}`);
    }
  }
  const fail = findings.filter((f) => f.verdict === "fail").length;
  const warn = findings.filter((f) => f.verdict === "warn").length;
  const pass = findings.filter((f) => f.verdict === "pass").length;
  const info = findings.filter((f) => f.verdict === "info").length;
  console.log(`summary: ${fail} fail, ${warn} warn, ${pass} pass, ${info} info`);
}

export const doctor: Subcommand = {
  name: "doctor",
  summary: "Check environment setup for every host (read-only diagnostics)",
  usage: () => ({
    synopsis: "thatch doctor",
    flags: [],
    notes: [
      "Checks the database and thatch's version, the opencode plugin install and dev shim, daemon liveness, the Claude Code plugin or hooks regime (the mod ping, the plugin tree's source consistency, leftover fallback writers), and Cursor's standalone-server install. Every finding prints a pass/warn/fail/info verdict, and warn/fail findings name the fix.",
      "The doctor is advice only: it never modifies your install or configuration. Repairs go through thatch setup.",
      "Exit code 0 when no check fails, 1 when any check fails (warnings do not affect it). Color only on a terminal; pipes and NO_COLOR get plain text.",
    ],
  }),
  async run(_args, ctx) {
    const findings = await collectDoctorFindings({
      db: ctx.db,
      dbPath: ctx.dbPath,
      projectDir: projectDir(),
      home: process.env.HOME ?? homedir(),
    });
    printDoctorFindings(findings);
    // exitCode, not exit(): the dispatcher's finally still closes the db.
    process.exitCode = doctorExitCode(findings);
  },
};
