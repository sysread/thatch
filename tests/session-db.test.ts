import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  SessionDB,
  resolveOpencodeDbPath,
  mostRecentTopLevelSessionId,
  enumerateSweepSessions,
  partToTimelineEntry,
  partToTranscriptEntries,
} from "../src/session-db";
import { TOOL_DEFS } from "../src/tool-defs";

/**
 * Builds a minimal opencode.db fixture with the same table shapes the real
 * daemon writes: session/message/part, JSON data blobs, millisecond epochs.
 * Only the columns SessionDB queries exist - adding more would be dead
 * weight and would drift with opencode's schema.
 */
function makeFixtureDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, title text, directory text, agent text, model text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer, data text);
  `);
  db.exec(`INSERT INTO session VALUES ('ses_test', 'Test session', '/tmp/proj', 'build', 'test-model', 1000, 9000)`);

  const msg = (id: string, role: string, time: number): void => {
    db.query("INSERT INTO message VALUES (?, 'ses_test', ?, ?)")
      .run(id, time, JSON.stringify({ role, time: { created: time } }));
  };
  const part = (id: string, messageId: string, time: number, data: Record<string, unknown>): void => {
    db.query("INSERT INTO part VALUES (?, ?, 'ses_test', ?, ?)")
      .run(id, messageId, time, JSON.stringify(data));
  };

  msg("msg_u1", "user", 1100);
  part("prt_u1_text", "msg_u1", 1101, { type: "text", text: "hello blarg world" });

  msg("msg_a1", "assistant", 1200);
  part("prt_a1_text", "msg_a1", 1201, { type: "text", text: "running the thing" });
  part("prt_a1_tool", "msg_a1", 1202, {
    type: "tool",
    tool: "bash",
    callID: "call_1",
    state: { status: "completed", input: { command: "echo blarg" }, output: "blarg\nsecond line" },
  });
  part("prt_a1_reason", "msg_a1", 1203, { type: "reasoning", text: "thinking about blarg" });

  msg("msg_u2", "user", 1300);
  part("prt_u2_text", "msg_u2", 1301, { type: "text", text: "another message" });

  db.close();
}

let dbDir: string;
let dbPath: string;
let db: SessionDB;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "thatch-session-db-"));
  dbPath = join(dbDir, "opencode.db");
  makeFixtureDb(dbPath);
  process.env.OPENCODE_DB = dbPath;
  db = new SessionDB(dbPath);
});

afterEach(() => {
  db.close();
  delete process.env.OPENCODE_DB;
  rmSync(dbDir, { recursive: true, force: true });
});

describe("resolveOpencodeDbPath", () => {
  test("honors OPENCODE_DB when the file exists", () => {
    expect(resolveOpencodeDbPath()).toBe(dbPath);
  });

  test("returns null when OPENCODE_DB points nowhere", () => {
    process.env.OPENCODE_DB = "/nonexistent/opencode.db";
    expect(resolveOpencodeDbPath()).toBeNull();
  });
});

describe("mostRecentTopLevelSessionId", () => {
  test("picks the newest top-level session in the directory; children and other directories skipped", () => {
    // The fixture db lacks parent_id, so build a dedicated one.
    const contPath = join(dbDir, "continue.db");
    const cont = new Database(contPath);
    cont.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, time_updated integer)`);
    cont.query("INSERT INTO session VALUES ('ses_old', '/tmp/work', NULL, 1000)").run();
    cont.query("INSERT INTO session VALUES ('ses_child', '/tmp/work', 'ses_old', 5000)").run();
    cont.query("INSERT INTO session VALUES ('ses_new', '/tmp/work', NULL, 4000)").run();
    cont.query("INSERT INTO session VALUES ('ses_elsewhere', '/somewhere/else', NULL, 9000)").run();
    cont.close();

    const saved = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = contPath;
    try {
      expect(mostRecentTopLevelSessionId("/tmp/work")).toBe("ses_new");
      expect(mostRecentTopLevelSessionId("/tmp/nowhere")).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = saved;
    }
  });

  test("returns null when no session db exists", () => {
    process.env.OPENCODE_DB = "/nonexistent/opencode.db";
    expect(mostRecentTopLevelSessionId("/tmp/work")).toBeNull();
  });

  test("prefers the v2 session_v2 table when the database has one", () => {
    // Under a v2 daemon the legacy `session` table only holds pre-migration
    // rows; reading it would resolve -c from years-old sessions. The v2
    // table must win even when the legacy table holds newer-looking rows.
    const contPath = join(dbDir, "continue-v2.db");
    const cont = new Database(contPath);
    cont.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, time_updated integer)`);
    cont.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, directory text, parent_id text, time_updated integer)`);
    cont.query("INSERT INTO session VALUES ('ses_legacy_new', '/tmp/work', NULL, 9000)").run();
    cont.query("INSERT INTO session_v2 VALUES ('ses_v2_new', '/tmp/work', NULL, 2000)").run();
    cont.query("INSERT INTO session_v2 VALUES ('ses_v2_child', '/tmp/work', 'ses_v2_new', 8000)").run();
    cont.query("INSERT INTO session_v2 VALUES ('ses_v2_elsewhere', '/somewhere/else', NULL, 9500)").run();
    cont.close();

    const saved = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = contPath;
    try {
      expect(mostRecentTopLevelSessionId("/tmp/work")).toBe("ses_v2_new");
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = saved;
    }
  });

});

describe("enumerateSweepSessions", () => {
  test("reads v2 tables with canonicals when present", () => {
    const sweepPath = join(dbDir, "sweep-v2.db");
    const s = new Database(sweepPath);
    s.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, title text, directory text, parent_id text, project_id text)`);
    s.exec(`CREATE TABLE project (id text PRIMARY KEY, worktree text)`);
    s.query("INSERT INTO session_v2 VALUES ('ses_corpse', 'thatch-extraction', '/tmp/wt-dead', NULL, 'p1')").run();
    s.query("INSERT INTO session_v2 VALUES ('ses_child', 'sub', '/tmp/wt-dead', 'ses_parent', 'p1')").run();
    s.query("INSERT INTO project VALUES ('p1', '/tmp/canonical')").run();
    s.close();

    const saved = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = sweepPath;
    try {
      const result = enumerateSweepSessions();
      expect(result).not.toBeNull();
      expect(result!.sessions).toHaveLength(2);
      expect(result!.sessions[0]).toMatchObject({ id: "ses_corpse", title: "thatch-extraction", parentId: null, projectId: "p1" });
      expect(result!.sessions[1]).toMatchObject({ id: "ses_child", parentId: "ses_parent" });
      expect(result!.canonicalByProject).toEqual({ p1: "/tmp/canonical" });
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = saved;
    }
  });

  test("falls back to the v1 session table with no canonicals", () => {
    const sweepPath = join(dbDir, "sweep-v1.db");
    const s = new Database(sweepPath);
    s.exec(`CREATE TABLE session (id text PRIMARY KEY, title text, directory text, parent_id text, time_created integer, time_updated integer)`);
    s.query("INSERT INTO session VALUES ('ses_v1', 'work', '/tmp/proj', NULL, 1, 2)").run();
    s.close();

    const saved = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = sweepPath;
    try {
      const result = enumerateSweepSessions();
      expect(result).not.toBeNull();
      expect(result!.sessions).toHaveLength(1);
      expect(result!.sessions[0]).toMatchObject({ id: "ses_v1", directory: "/tmp/proj", parentId: null, projectId: null });
      expect(result!.canonicalByProject).toEqual({});
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = saved;
    }
  });

  test("returns null when no session db exists", () => {
    process.env.OPENCODE_DB = "/nonexistent/opencode.db";
    expect(enumerateSweepSessions()).toBeNull();
  });
});

describe("SessionDB", () => {
  test("getSession returns decoded session rows", () => {
    const session = db.getSession("ses_test")!;
    expect(session.title).toBe("Test session");
    expect(session.agent).toBe("build");
    expect(session.timeCreated).toBe(1000);
    expect(db.getSession("ses_nope")).toBeNull();
  });

  test("listParts returns parts in order joined with message role", () => {
    const parts = db.listParts("ses_test");
    expect(parts.map((p) => p.partId)).toEqual([
      "prt_u1_text",
      "prt_a1_text",
      "prt_a1_tool",
      "prt_a1_reason",
      "prt_u2_text",
    ]);
    expect(parts[0].role).toBe("user");
    expect(parts[1].role).toBe("assistant");
    expect(parts[2].type).toBe("tool");
  });

  test("listParts honors the time window", () => {
    const parts = db.listParts("ses_test", 1202, undefined);
    expect(parts.map((p) => p.partId)).toEqual(["prt_a1_tool", "prt_a1_reason", "prt_u2_text"]);
    expect(db.listParts("ses_test", undefined, 1201).map((p) => p.partId)).toEqual([
      "prt_u1_text",
      "prt_a1_text",
    ]);
  });

  test("getPart fetches one part without a session filter", () => {
    const part = db.getPart("prt_a1_tool")!;
    expect(part.role).toBe("assistant");
    const state = part.data.state as Record<string, unknown>;
    expect(state.output).toBe("blarg\nsecond line");
    expect(db.getPart("prt_nope")).toBeNull();
  });

  test("getMessage returns the message with its parts", () => {
    const message = db.getMessage("msg_a1")!;
    expect(message.role).toBe("assistant");
    expect(message.parts.map((p) => p.partId)).toEqual(["prt_a1_text", "prt_a1_tool", "prt_a1_reason"]);
    expect(db.getMessage("msg_nope")).toBeNull();
  });

  test("search matches decoded content case-insensitively", () => {
    const hits = db.search("BLARG");
    expect(hits.map((p) => p.partId).sort()).toEqual(["prt_a1_reason", "prt_a1_tool", "prt_u1_text"]);
  });

  test("search does not match raw JSON syntax", () => {
    // The raw blob contains "tool":"bash" but decoded strings never do.
    expect(db.search('"tool":"bash"')).toEqual([]);
    expect(db.search("bash").length).toBeGreaterThan(0);
  });

  test("search supports regex and session narrowing and limit", () => {
    expect(db.search("^hello", { regex: true }).map((p) => p.partId)).toEqual(["prt_u1_text"]);
    expect(db.search("e", { limit: 2 }).length).toBe(2);
    expect(db.search("blarg", { sessionID: "ses_other" })).toEqual([]);
  });
});

describe("partToTimelineEntry", () => {
  test("text parts carry a truncated detail", () => {
    const entry = partToTimelineEntry(db.getPart("prt_u1_text")!);
    expect(entry.type).toBe("text");
    expect(entry.detail).toBe("hello blarg world");
    expect(entry.timestamp).toBe(new Date(1101).toISOString());
  });

  test("tool parts carry call_id, tool name, and output preview", () => {
    const entry = partToTimelineEntry(db.getPart("prt_a1_tool")!) as Record<string, string>;
    expect(entry.call_id).toBe("call_1");
    expect(entry.tool).toBe("bash");
    expect(entry.detail).toBe("bash");
    expect(entry.output).toContain("blarg");
  });

  test("long output is truncated with an ellipsis", () => {
    const db2 = new SessionDB(dbPath);
    try {
      const long = "x".repeat(500);
      const part = db2.getPart("prt_a1_tool")!;
      (part.data.state as Record<string, unknown>).output = long;
      const entry = partToTimelineEntry(part) as Record<string, string>;
      expect(entry.output.length).toBeLessThan(long.length);
      expect(entry.output.endsWith("...")).toBe(true);
    } finally {
      db2.close();
    }
  });
});

describe("partToTranscriptEntries", () => {
  test("user message becomes one OpenAI user line", () => {
    const parts = db.listParts("ses_test").filter((p) => p.messageId === "msg_u1");
    const entries = partToTranscriptEntries("user", parts);
    expect(entries).toEqual([{ role: "user", content: "hello blarg world" }]);
  });

  test("assistant message with tool calls becomes assistant + tool lines", () => {
    const parts = db.listParts("ses_test").filter((p) => p.messageId === "msg_a1");
    const entries = partToTranscriptEntries("assistant", parts);
    expect(entries).toHaveLength(2);
    const assistant = entries[0] as Record<string, unknown>;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("running the thing");
    const toolCalls = assistant.tool_calls as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_1");
    expect(JSON.parse((toolCalls[0].function as Record<string, string>).arguments)).toEqual({ command: "echo blarg" });
    const toolResult = entries[1] as Record<string, unknown>;
    expect(toolResult.role).toBe("tool");
    expect(toolResult.tool_call_id).toBe("call_1");
    expect(toolResult.content).toBe("blarg\nsecond line");
  });

  test("reasoning and step parts are dropped from transcripts", () => {
    const entries = partToTranscriptEntries("assistant", [
      { ...db.getPart("prt_a1_reason")! },
    ]);
    expect(entries).toEqual([]);
  });
});

describe("session tool defs", () => {
  test("both are opencode-only", () => {
    expect(TOOL_DEFS.filter((t) => t.name === "session_search" || t.name === "session_get").every((t) => t.opencodeOnly)).toBe(true);
  });

  test("session_search returns JSONL matches", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "session_search")!;
    const result = await def.execute({ query: "blarg" }, {} as never);
    const lines = result.split("\n");
    expect(lines.length).toBe(3);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(first.session_id).toBe("ses_test");
    expect(first.part_id).toBeDefined();
  });

  test("session_search reports no matches plainly", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "session_search")!;
    const result = await def.execute({ query: "zzz-not-there" }, {} as never);
    expect(result).toContain("No matches");
  });

  test("session_get returns full tool output for a part id", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "session_get")!;
    const result = await def.execute({ id: "prt_a1_tool" }, {} as never);
    expect(result).toContain("second line");
    expect(result).toContain("echo blarg");
  });

  test("session_get returns a message with parts for a msg id", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "session_get")!;
    const result = await def.execute({ id: "msg_a1" }, {} as never);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.role).toBe("assistant");
    expect((parsed.parts as unknown[]).length).toBe(3);
  });
});
