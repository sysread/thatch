import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerUseCase, type UseCase, type QaContext } from "../runner";

/**
 * UC-094: Session archaeology CLI.
 *
 * Automatable: the `thatch session` subcommands are pure reads over a
 * controlled opencode.db fixture. Builds a minimal fixture with the same
 * table shapes opencode writes, then verifies list (JSONL timeline), get
 * (full part + message), transcript (OpenAI chat-completions roles), and
 * search (decoded content, not raw JSON syntax). Also verifies the useful
 * error when no opencode database exists.
 */

interface FixtureBuilder {
  fixtureDir: string;
  dbPath: string;
  toolPartId: string;
  assistantMsgId: string;
}

function buildFixture(fixtureDir: string): FixtureBuilder {
  const dbPath = join(fixtureDir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, title text, directory text, agent text, model text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer, data text);
  `);
  db.exec(`INSERT INTO session VALUES ('ses_qa', 'QA session', '/tmp/proj', 'build', 'test-model', 1000, 9000)`);
  const msg = db.query("INSERT INTO message VALUES (?, 'ses_qa', ?, ?)");
  msg.run("msg_u1", 1100, JSON.stringify({ role: "user" }));
  msg.run("msg_a1", 1200, JSON.stringify({ role: "assistant" }));
  const part = db.query("INSERT INTO part VALUES (?, ?, 'ses_qa', ?, ?)");
  part.run("prt_u1_text", "msg_u1", 1101, JSON.stringify({ type: "text", text: "fix the blarg pipeline" }));
  part.run("prt_a1_text", "msg_a1", 1201, JSON.stringify({ type: "text", text: "on it" }));
  part.run("prt_a1_tool", "msg_a1", 1202, JSON.stringify({
    type: "tool",
    tool: "bash",
    callID: "call_qa_1",
    state: { status: "completed", input: { command: "echo blarg" }, output: "blarg" },
  }));
  db.close();
  return { fixtureDir, dbPath, toolPartId: "prt_a1_tool", assistantMsgId: "msg_a1" };
}

const useCase: UseCase = {
  name: "UC-094-session-archaeology",
  preconditions: [
    "- Bun on PATH; thatch installed",
    "- An opencode.db fixture with a known session (user prompt, assistant text, bash tool call)",
  ].join("\n"),
  steps: [
    "1. Run `thatch session list -s <id>` and verify one JSONL object per part with timestamp, ids, role, and type.",
    "2. Verify the tool line carries call_id, tool name, and a truncated output preview.",
    "3. Run `thatch session get --id <tool part id>` and verify the full untruncated tool output and args.",
    "4. Run `thatch session get --id <message id>` and verify the message with all of its parts.",
    "5. Run `thatch session transcript -s <id>` and verify OpenAI chat-completions roles (user, assistant with tool_calls, tool results, no reasoning).",
    "6. Run `thatch session search blarg` and verify decoded-content matches (hit on tool output and user text).",
    "7. Run `thatch session search '\"tool\":\"bash\"'` and verify zero hits (raw JSON syntax must not match).",
    "8. Run `thatch session search --regex '^fix'` and verify regex matching works.",
    "9. Run `thatch session get --id prt_missing` and verify a clean not-found error.",
    "10. Unset OPENCODE_DB and point XDG_DATA_HOME at an empty dir; verify a useful no-database error.",
  ].join("\n"),
  expected: [
    "- list emits one JSONL object per part in conversation order.",
    "- Tool parts expose call_id, tool, args_preview, and output on the timeline line.",
    "- get returns full JSON with snake_case fields; tool output is untruncated.",
    "- transcript emits user/assistant/tool roles only; tool_calls carry the callID as id.",
    "- search matches decoded strings, never raw JSON field syntax; --regex works.",
    "- Missing ids and a missing database produce clean, actionable errors (non-zero exit).",
  ].join("\n"),

  async run(ctx: QaContext) {
    const bin = `${ctx.repoRoot}/bin/thatch`;
    const fixture = buildFixture(mkdtempSync(join(tmpdir(), "thatch-qa-uc094-")));
    const sessionEnv = { ...ctx.env, OPENCODE_DB: fixture.dbPath };
    try {
      // 1-2. list: one JSONL line per part, tool line carries tool fields.
      const list = await $`${bin} session list -s ses_qa`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (list.exitCode !== 0) {
        console.log(`  FAIL: session list exited ${list.exitCode}: ${list.stderr.toString()}`);
        return "FAIL";
      }
      const lines = list.stdout.toString().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      if (lines.length !== 3) {
        console.log(`  FAIL: expected 3 timeline lines, got ${lines.length}`);
        return "FAIL";
      }
      const toolLine = lines.find((l) => l.type === "tool") as Record<string, unknown>;
      if (toolLine?.call_id !== "call_qa_1" || toolLine.tool !== "bash" || !(toolLine.output as string).includes("blarg")) {
        console.log(`  FAIL: tool timeline line missing call_id/tool/output: ${JSON.stringify(toolLine)}`);
        return "FAIL";
      }

      // 3. get a tool part: full args + output, snake_case fields.
      const gotPart = await $`${bin} session get --id ${fixture.toolPartId}`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (gotPart.exitCode !== 0) {
        console.log(`  FAIL: session get (part) exited ${gotPart.exitCode}`);
        return "FAIL";
      }
      const partJson = JSON.parse(gotPart.stdout.toString()) as Record<string, unknown>;
      const state = (partJson.data as Record<string, unknown>).state as Record<string, unknown>;
      if (partJson.part_id !== fixture.toolPartId || state.output !== "blarg") {
        console.log(`  FAIL: part get shape wrong: ${gotPart.stdout.toString().slice(0, 200)}`);
        return "FAIL";
      }

      // 4. get a message: all parts included.
      const gotMsg = await $`${bin} session get --id ${fixture.assistantMsgId}`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (gotMsg.exitCode !== 0) {
        console.log(`  FAIL: session get (message) exited ${gotMsg.exitCode}`);
        return "FAIL";
      }
      const msgJson = JSON.parse(gotMsg.stdout.toString()) as Record<string, unknown>;
      if (msgJson.role !== "assistant" || (msgJson.parts as unknown[]).length !== 2) {
        console.log(`  FAIL: message get shape wrong: ${gotMsg.stdout.toString().slice(0, 200)}`);
        return "FAIL";
      }

      // 5. transcript: user/assistant/tool roles, tool_calls carry callID.
      const transcript = await $`${bin} session transcript -s ses_qa`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (transcript.exitCode !== 0) {
        console.log(`  FAIL: session transcript exited ${transcript.exitCode}`);
        return "FAIL";
      }
      const tLines = transcript.stdout.toString().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const roles = tLines.map((l) => l.role);
      if (JSON.stringify(roles) !== JSON.stringify(["user", "assistant", "tool"])) {
        console.log(`  FAIL: transcript roles ${roles.join(",")}`);
        return "FAIL";
      }
      const assistant = tLines.find((l) => l.role === "assistant") as Record<string, unknown>;
      const toolCalls = assistant.tool_calls as Array<Record<string, unknown>> | undefined;
      if (!toolCalls || toolCalls[0].id !== "call_qa_1") {
        console.log(`  FAIL: assistant tool_calls missing or wrong id`);
        return "FAIL";
      }

      // 6. search substring hits decoded content (user text + tool output).
      const search = await $`${bin} session search blarg`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      const searchLines = search.stdout.toString().trim().split("\n").filter(Boolean);
      if (search.exitCode !== 0 || searchLines.length !== 2) {
        console.log(`  FAIL: search expected 2 decoded matches, got ${searchLines.length}`);
        return "FAIL";
      }

      // 7. raw JSON syntax must not match.
      const rawSearch = await $`${bin} session search '"tool":"bash"'`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (rawSearch.exitCode !== 0 || rawSearch.stdout.toString().trim() !== "") {
        console.log(`  FAIL: raw JSON syntax should not match: ${rawSearch.stdout.toString()}`);
        return "FAIL";
      }

      // 8. regex mode.
      const regexSearch = await $`${bin} session search '^fix' --regex`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (regexSearch.exitCode !== 0 || regexSearch.stdout.toString().trim().split("\n").length !== 1) {
        console.log(`  FAIL: regex search expected 1 match: ${regexSearch.stdout.toString()}`);
        return "FAIL";
      }

      // 9. unknown id -> clean error.
      const missing = await $`${bin} session get --id prt_missing`.env(sessionEnv).cwd(ctx.dir).quiet().nothrow();
      if (missing.exitCode === 0 || !missing.stderr.toString().includes("no part")) {
        console.log(`  FAIL: missing part should error cleanly: ${missing.stderr.toString()}`);
        return "FAIL";
      }

      // 10. no database anywhere -> actionable error mentioning OPENCODE_DB.
      const emptyXdg = mkdtempSync(join(tmpdir(), "thatch-qa-uc094-empty-"));
      writeFileSync(join(emptyXdg, ".keep"), "");
      const noDbEnv = { ...ctx.env, OPENCODE_DB: "", XDG_DATA_HOME: emptyXdg };
      const noDb = await $`${bin} session list -s ses_qa`.env(noDbEnv).cwd(ctx.dir).quiet().nothrow();
      if (noDb.exitCode === 0 || !noDb.stderr.toString().includes("OPENCODE_DB")) {
        console.log(`  FAIL: missing database should error mentioning OPENCODE_DB: ${noDb.stderr.toString()}`);
        return "FAIL";
      }

      return "PASS";
    } finally {
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
