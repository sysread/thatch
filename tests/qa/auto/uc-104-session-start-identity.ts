import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-104: Session-start identity anchor.
 *
 * The SessionStart hook (Claude Code) / sessionStart hook (Cursor) passes a
 * session id in its stdin JSON (session_id / conversation_id), and `thatch
 * reminder` reads it: chatHookLine(sessionID) ensure-registers
 * mcp_<sha256(sessionID)[0:12]> and prints "you are NAME (N unread)" at
 * session start, before any prompt. This makes the reminder a second
 * identity anchor alongside flush-tools, and covers Cursor hosts whose
 * beforeSubmitPrompt output contract is unverified.
 *
 * Automatable: yes - the hook is a subprocess over a seeded SQLite file.
 * Also pins the no-hang contract: a spawn with no stdin payload (manual
 * run, bare test spawn) must still exit.
 */

const useCase: UseCase = {
  name: "UC-104-session-start-identity",
  preconditions: [
    "- No prerequisites beyond the source tree; the hook runs the real CLI binary against a seeded DB.",
  ].join("\n"),
  steps: [
    "1. Run `thatch reminder` with a Claude Code SessionStart stdin payload (session_id, source).",
    "2. Verify the plain-text output contains the identity line and the DB has an mcp_ row.",
    "3. Run `thatch flush-tools` with the same session_id; verify both hooks resolve the same identity.",
    "4. Run `thatch reminder --json` with a Cursor sessionStart payload (conversation_id); verify the JSON output carries the identity line for a distinct identity.",
    "5. Run `thatch reminder` with no stdin payload (stdin: ignore); verify it exits and prints no identity line.",
  ].join("\n"),
  expected: [
    "- The reminder prints `[thatch] chat: you are <name> (...)` at session start for a session_id-bearing payload.",
    "- The stored session ID is mcp_<12-hex>; reminder and flush-tools derive the same id and name from one host session id.",
    "- A conversation_id payload (Cursor) anchors a distinct identity, and --json wraps the line as additional_context.",
    "- A reminder with no stdin payload exits promptly and prints no identity line (the manual-run / bare-spawn path).",
  ].join("\n"),

  async run(ctx) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env };
    const dbPath = ctx.env.THATCH_DB_PATH;
    const dir = mkdtempSync(join(tmpdir(), "thatch-uc104-"));
    try {
      // No remote: detectRepo() falls back to the directory basename for
      // both the hook registration and any peer rows, so both sides agree
      // on the project without depending on the host's git url-rewrite
      // config (insteadOf rules rewrite github https URLs and would make
      // parseGitUrl environment-dependent).
      await $`git init`.cwd(dir).quiet();

      const hook = async (command: string[], payload?: object) => {
        const proc = Bun.spawn([bin, ...command], {
          env,
          cwd: dir,
          stdin: payload ? "pipe" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        if (payload && proc.stdin) {
          proc.stdin.write(JSON.stringify(payload));
          proc.stdin.end();
        }
        await proc.exited;
        return { out: await new Response(proc.stdout).text(), code: proc.exitCode };
      };

      // Step 1+2: a Claude Code SessionStart payload yields the identity
      // line in plain-text stdout and an mcp_ row in the DB.
      const start = await hook(["reminder"], { session_id: "claude-session-xyz", source: "startup" });
      if (start.code !== 0) {
        console.log(`  FAIL: reminder exited ${start.code}`);
        return "FAIL";
      }
      const raw = new Database(dbPath, { readonly: true });
      const rows = raw.query("SELECT session_id, name FROM chat_sessions").all() as any[];
      const mine = rows.find((r: any) => r.session_id.startsWith("mcp_"));
      raw.close();
      if (!mine) {
        console.log(`  FAIL: no mcp_ row after reminder. Rows: ${JSON.stringify(rows)}`);
        return "FAIL";
      }
      if (!start.out.includes(`you are ${mine.name}`)) {
        console.log(`  FAIL: identity line missing at session start. Output: ${start.out.slice(-400)}`);
        return "FAIL";
      }
      const anchorID = mine.session_id as string;
      const anchorName = mine.name as string;

      // Step 3: flush-tools resolves the same identity from the same
      // session id - one anchor, shared by both hook commands.
      const flush = await hook(["flush-tools"], { session_id: "claude-session-xyz", prompt: "next steps?" });
      if (!flush.out.includes(`you are ${anchorName}`)) {
        console.log(`  FAIL: flush-tools identity differs from reminder. Output: ${flush.out.slice(-400)}`);
        return "FAIL";
      }

      // Step 4: a Cursor conversation_id payload anchors a distinct
      // identity, and --json wraps the line as additional_context.
      const cursor = await hook(["reminder", "--json"], { conversation_id: "cursor-convo-xyz" });
      if (cursor.code !== 0) {
        console.log(`  FAIL: reminder --json exited ${cursor.code}`);
        return "FAIL";
      }
      let cursorContext: string | undefined;
      try {
        cursorContext = (JSON.parse(cursor.out) as { additional_context?: string }).additional_context;
      } catch {
        // left undefined; the check below reports it
      }
      const raw2 = new Database(dbPath, { readonly: true });
      const cursorRows = raw2.query("SELECT session_id, name FROM chat_sessions WHERE session_id != ?").all(anchorID) as any[];
      raw2.close();
      const cursorRow = cursorRows.find((r: any) => r.session_id.startsWith("mcp_"));
      if (!cursorRow) {
        console.log(`  FAIL: no distinct mcp_ row for the Cursor conversation. Rows: ${JSON.stringify(cursorRows)}`);
        return "FAIL";
      }
      if (!cursorContext?.includes(`you are ${cursorRow.name}`)) {
        console.log(`  FAIL: --json output missing Cursor identity. Output: ${cursor.out.slice(-400)}`);
        return "FAIL";
      }

      // Step 5: no stdin payload - the reminder must exit promptly and
      // print no identity line (nothing was registered for it).
      const bare = await hook(["reminder"]);
      if (bare.code !== 0) {
        console.log(`  FAIL: bare reminder exited ${bare.code}`);
        return "FAIL";
      }
      if (bare.out.includes("you are")) {
        console.log(`  FAIL: bare reminder printed an identity line. Output: ${bare.out.slice(-400)}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
