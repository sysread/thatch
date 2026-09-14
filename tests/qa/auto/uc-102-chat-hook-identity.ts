import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { registerUseCase, type UseCase } from "../runner";
import { ThatchDB } from "../../../src/db";

/**
 * UC-102: MCP hook identity anchor.
 *
 * The flush-tools hook is the only persistent-identity path for Claude
 * Code and Cursor: chatHookLine(sessionID) ensure-registers
 * mcp_<sha256(sessionID)> and prints "you are NAME (N unread)" on every
 * prompt. This use case drives the real binary over a seeded DB and pins
 * the whole contract: identity mints on first prompt, survives later
 * prompts (same name), the line reports unread counts, and an explicit
 * unregister STICKS - the leave tombstone blocks the hook's ensure on
 * every later prompt (the line announces the leave instead of silently
 * rejoining), until an explicit rejoin clears it.
 *
 * Automatable: yes - the hook is a subprocess over a seeded SQLite file.
 */

const useCase: UseCase = {
  name: "UC-102-chat-hook-identity",
  preconditions: [
    "- No prerequisites beyond the source tree; the hook runs the real CLI binary against a seeded DB.",
  ].join("\n"),
  steps: [
    "1. Run `thatch flush-tools` with a Claude Code UserPromptSubmit stdin payload (session_id, real prompt text).",
    "2. Verify the output contains the identity line and the DB has an mcp_ row with a counter-suffixed assigned name.",
    "3. Run flush-tools again with the same session_id; verify the same name (identity is stable per conversation).",
    "4. Register a peer, send mail to the hook session, run flush-tools; verify the line reports the unread count.",
    "5. Unregister the hook session, run flush-tools; verify the leave line shows instead of an identity, the row is gone, and a tombstone exists.",
    "6. Rejoin explicitly (register + tombstone clear), run flush-tools; verify the new identity line.",
  ].join("\n"),
  expected: [
    "- flush-tools prints `[thatch] chat: you are <name> (...)` on every prompt for a session_id-bearing host, even with zero mail.",
    "- The stored session ID is mcp_<12-hex>, and the name is <slug>-<counter> assigned by thatch.",
    "- The identity is stable across prompts of the same host conversation.",
    "- The line reports the caller's unread count.",
    "- chat_unregister sticks: the hook prints the leave line instead of re-registering, the row stays deleted, and a tombstone row exists.",
  ].join("\n"),

  async run(ctx) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const env = { ...ctx.env };
    const dbPath = ctx.env.THATCH_DB_PATH;
    const dir = mkdtempSync(join(tmpdir(), "thatch-uc101-"));
    try {
      // No remote: detectRepo() falls back to the directory basename for
      // both the peer registration and the hook flush, so both sides agree
      // on the project without depending on the host's git url-rewrite
      // config (insteadOf rules rewrite github https URLs and would make
      // parseGitUrl environment-dependent).
      await $`git init`.cwd(dir).quiet();

      const flush = async (sessionID: string) => {
        const proc = Bun.spawn([bin, "flush-tools"], {
          env,
          cwd: dir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        proc.stdin.write(JSON.stringify({ session_id: sessionID, prompt: "hello there, what is next on the list" }));
        proc.stdin.end();
        await proc.exited;
        return { out: await new Response(proc.stdout).text(), code: proc.exitCode };
      };

      // Step 1+2: first prompt mints the identity.
      const first = await flush("claude-session-abc");
      if (first.code !== 0) {
        console.log(`  FAIL: flush-tools exited ${first.code}`);
        return "FAIL";
      }
      const raw = new Database(dbPath, { readonly: true });
      const rows = raw.query("SELECT session_id, name FROM chat_sessions").all() as any[];
      const mcp = rows.find((r: any) => r.session_id.startsWith("mcp_"));
      if (!mcp) {
        console.log(`  FAIL: no mcp_ row after flush-tools. Rows: ${JSON.stringify(rows)}`);
        return "FAIL";
      }
      if (!/^[a-z0-9-]+-\d{5}$/.test(mcp.name)) {
        console.log(`  FAIL: assigned name not counter-suffixed: ${mcp.name}`);
        return "FAIL";
      }
      if (!first.out.includes(`you are ${mcp.name}`)) {
        console.log(`  FAIL: identity line missing. Output: ${first.out.slice(-400)}`);
        return "FAIL";
      }
      const assignedName = mcp.name as string;
      const assignedID = mcp.session_id as string;
      raw.close();

      // Step 3: stable across prompts.
      const second = await flush("claude-session-abc");
      if (!second.out.includes(`you are ${assignedName}`)) {
        console.log(`  FAIL: identity changed across prompts. Output: ${second.out.slice(-400)}`);
        return "FAIL";
      }

      // Step 4: mail lands and the line reports it.
      const db = new ThatchDB(dbPath);
      const peer = db.registerChatSession("ses_peer", dir.split("/").pop()!, null, "opencode", "peer");
      if (!peer.ok) {
        console.log(`  FAIL: peer registration failed: ${JSON.stringify(peer)}`);
        return "FAIL";
      }
      const sent = db.sendChatMessage("ses_peer", assignedName, "hello from the peer");
      if (!sent.ok) {
        console.log(`  FAIL: peer send failed: ${JSON.stringify(sent)}`);
        return "FAIL";
      }
      db.close();
      const third = await flush("claude-session-abc");
      if (!third.out.includes("1 unread message(s) for you")) {
        console.log(`  FAIL: unread count not reported. Output: ${third.out.slice(-400)}`);
        return "FAIL";
      }

      // Step 5: unregister sticks - the tombstone blocks the hook's ensure
      // the same way it blocks opencode auto-registration, and the line
      // says so instead of silently rejoining.
      const db2 = new ThatchDB(dbPath);
      db2.unregisterChatSession(assignedID);
      db2.close();
      const fourth = await flush("claude-session-abc");
      if (!fourth.out.includes("left the chat directory")) {
        console.log(`  FAIL: unregister did not stick on the hook path. Output: ${fourth.out.slice(-400)}`);
        return "FAIL";
      }
      const raw2 = new Database(dbPath, { readonly: true });
      const resurrected = raw2.query("SELECT session_id FROM chat_sessions WHERE name = ?").get(assignedName);
      const tombstoned = raw2.query("SELECT 1 AS x FROM chat_leave_tombstones WHERE session_id = ?").get(assignedID);
      raw2.close();
      if (resurrected) {
        console.log(`  FAIL: row resurrected after unregister: ${JSON.stringify(resurrected)}`);
        return "FAIL";
      }
      if (!tombstoned) {
        console.log("  FAIL: leave tombstone missing after unregister");
        return "FAIL";
      }
      // Rejoin clears the tombstone and returns the conversation to the
      // directory (a fresh name - assigned identities are never reused).
      const db3 = new ThatchDB(dbPath);
      const rejoined = db3.registerChatSession(assignedID, dir.split("/").pop()!, null, "mcp");
      db3.clearChatLeaveTombstone(assignedID);
      db3.close();
      if (!rejoined.ok) {
        console.log(`  FAIL: rejoin failed: ${JSON.stringify(rejoined)}`);
        return "FAIL";
      }
      const fifth = await flush("claude-session-abc");
      if (!fifth.out.includes(`you are ${rejoined.name}`)) {
        console.log(`  FAIL: rejoin did not register the identity. Output: ${fifth.out.slice(-400)}`);
        return "FAIL";
      }
      return "PASS";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
