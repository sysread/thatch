import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only access to the opencode session database (opencode.db). opencode
 * stores its conversation transcripts in three tables: `session` (one row per
 * conversation), `message` (one row per user/assistant turn; `data` carries
 * the role), and `part` (one row per content piece of a message; `data` is a
 * JSON blob whose `type` field distinguishes text, tool, reasoning, patch,
 * and step boundaries). This module is host-agnostic: the CLI subcommands use
 * it directly, and the opencode-only session tools reach the same db from
 * inside the plugin process.
 *
 * The database is opened read-only so a thatch bug can never corrupt the
 * host's session history. Concurrent reads are safe - the daemon holds the
 * write lock, readers never block.
 */

/** The piece types emitted by list/search. step-start/step-finish are
 *  bookkeeping boundaries opencode writes between model calls. */
export type PartType = "text" | "tool" | "reasoning" | "patch" | "step-start" | "step-finish" | "other";

/** Decoded role from the message row's data blob ("user" or "assistant"). */
export type MessageRole = "user" | "assistant" | string;

/** One content piece of a conversation, decoded from the part table. */
export interface SessionPart {
  partId: string;
  messageId: string;
  sessionId: string;
  /** Millisecond epoch from the part row. */
  timeCreated: number;
  role: MessageRole;
  type: PartType;
  /** Raw decoded data blob - shape varies by type (see listEntries docs). */
  data: Record<string, unknown>;
}

/**
 * Resolves the opencode session database path. Precedence mirrors opencode
 * itself: OPENCODE_DB (its documented override, read at opencode startup)
 * wins, then the XDG_DATA_HOME-derived default. Returns null when no
 * database file exists - the CLI turns this into a useful error and the
 * session tools report unavailability.
 */
export function resolveOpencodeDbPath(): string | null {
  if (process.env.OPENCODE_DB) {
    return existsSync(process.env.OPENCODE_DB) ? process.env.OPENCODE_DB : null;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const path = join(dataHome, "opencode", "opencode.db");
  return existsSync(path) ? path : null;
}

export interface SessionRow {
  id: string;
  title: string;
  directory: string;
  agent: string | null;
  model: string | null;
  timeCreated: number;
  timeUpdated: number;
}

/** Truncate for list/search preview fields. Kept modest so a full screen of
 *  timeline stays scannable; `session get` returns untruncated content. */
const PREVIEW_LEN = 200;

function truncate(text: string, maxLen = PREVIEW_LEN): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "...";
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Extract every human-readable string from a decoded part blob. Used by
 *  search so patterns match real content, not JSON field names or escaped
 *  syntax in the raw blob. */
function searchableStrings(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/**
 * Read-only facade over opencode.db. All methods throw when the underlying
 * file is missing or has an unexpected schema - callers surface the error.
 */
export class SessionDB {
  readonly path: string;
  #db: Database;

  constructor(path: string) {
    this.path = path;
    this.#db = new Database(path, { readonly: true });
  }

  close(): void {
    this.#db.close();
  }

  /** Fetches one session row, or null for an unknown id. */
  getSession(sessionID: string): SessionRow | null {
    const row = this.#db
      .query(
        "SELECT id, title, directory, agent, model, time_created, time_updated FROM session WHERE id = ?",
      )
      .get(sessionID) as
      | { id: string; title: string; directory: string; agent: string | null; model: string | null; time_created: number; time_updated: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      directory: row.directory,
      agent: row.agent,
      model: row.model,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    };
  }

  /**
   * Lists a session's parts in conversation order (message time, then part
   * order within the message), each joined with its message role.
   * afterMs/beforeMs bound the part time window (epoch ms, inclusive).
   */
  listParts(sessionID: string, afterMs?: number, beforeMs?: number): SessionPart[] {
    const rows = this.#db
      .query(
        `SELECT p.id AS part_id, p.message_id, p.session_id, p.time_created, p.data AS part_data,
                m.data AS message_data
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ?
           AND (? IS NULL OR p.time_created >= ?)
           AND (? IS NULL OR p.time_created <= ?)
         ORDER BY m.time_created, p.time_created, p.id`,
      )
      .all(sessionID, afterMs ?? null, afterMs ?? null, beforeMs ?? null, beforeMs ?? null) as {
      part_id: string;
      message_id: string;
      session_id: string;
      time_created: number;
      part_data: string;
      message_data: string;
    }[];

    return rows.map((row) => {
      const partData = JSON.parse(row.part_data) as Record<string, unknown>;
      const messageData = JSON.parse(row.message_data) as Record<string, unknown>;
      return {
        partId: row.part_id,
        messageId: row.message_id,
        sessionId: row.session_id,
        timeCreated: row.time_created,
        role: (messageData.role as MessageRole) ?? "unknown",
        type: (partData.type as PartType) ?? "other",
        data: partData,
      };
    });
  }

  /**
   * Fetches one part by its part id. No session filter - part ids are
   * globally unique primary keys, so a bare --id works without -s.
   */
  getPart(partID: string): SessionPart | null {
    const row = this.#db
      .query(
        `SELECT p.id AS part_id, p.message_id, p.session_id, p.time_created, p.data AS part_data,
                m.data AS message_data
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.id = ?`,
      )
      .get(partID) as
      | { part_id: string; message_id: string; session_id: string; time_created: number; part_data: string; message_data: string }
      | undefined;
    if (!row) return null;
    const partData = JSON.parse(row.part_data) as Record<string, unknown>;
    const messageData = JSON.parse(row.message_data) as Record<string, unknown>;
    return {
      partId: row.part_id,
      messageId: row.message_id,
      sessionId: row.session_id,
      timeCreated: row.time_created,
      role: (messageData.role as MessageRole) ?? "unknown",
      type: (partData.type as PartType) ?? "other",
      data: partData,
    };
  }

  /** Fetches one message row (decoded) with all of its parts in order. */
  getMessage(messageID: string): { messageId: string; sessionId: string; timeCreated: number; role: MessageRole; data: Record<string, unknown>; parts: SessionPart[] } | null {
    const row = this.#db
      .query("SELECT id, session_id, time_created, data FROM message WHERE id = ?")
      .get(messageID) as { id: string; session_id: string; time_created: number; data: string } | undefined;
    if (!row) return null;
    const decoded = JSON.parse(row.data) as Record<string, unknown>;
    const parts = this.listParts(row.session_id).filter((p) => p.messageId === messageID);
    return {
      messageId: messageID,
      sessionId: row.session_id,
      timeCreated: row.time_created,
      role: (decoded.role as MessageRole) ?? "unknown",
      data: decoded,
      parts,
    };
  }

  /** Lists a session's messages in order, each with its parts. Used by the
   *  transcript builder, which needs per-message grouping rather than the
   *  flat part stream listParts produces. */
  listMessages(sessionID: string): { messageId: string; sessionId: string; timeCreated: number; role: MessageRole; data: Record<string, unknown>; parts: SessionPart[] }[] {
    const messages = this.#db
      .query("SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(sessionID) as { id: string; session_id: string; time_created: number; data: string }[];
    const parts = this.listParts(sessionID);
    return messages.map((row) => {
      const decoded = JSON.parse(row.data) as Record<string, unknown>;
      return {
        messageId: row.id,
        sessionId: row.session_id,
        timeCreated: row.time_created,
        role: (decoded.role as MessageRole) ?? "unknown",
        data: decoded,
        parts: parts.filter((p) => p.messageId === row.id),
      };
    });
  }

  /**
   * Searches decoded part content across sessions. Plain queries are
   * case-insensitive substrings; regex queries use the pattern as-is.
   * Scans the part table in conversation order, so results come back in
   * chronological order grouped by session. sessionID narrows to one
   * session; limit caps matches (applied after the scan completes, oldest
   * first).
   */
  search(query: string, opts?: { regex?: boolean; sessionID?: string; limit?: number }): SessionPart[] {
    let matcher: (s: string) => boolean;
    if (opts?.regex) {
      const re = new RegExp(query);
      matcher = (s) => re.test(s);
    } else {
      const needle = query.toLowerCase();
      matcher = (s) => s.toLowerCase().includes(needle);
    }

    const rows = (opts?.sessionID
      ? this.#db
          .query(
            `SELECT p.id AS part_id, p.message_id, p.session_id, p.time_created, p.data AS part_data,
                    m.data AS message_data
             FROM part p JOIN message m ON m.id = p.message_id
             WHERE p.session_id = ?
             ORDER BY m.time_created, p.id`,
          )
          .all(opts.sessionID)
      : this.#db
          .query(
            `SELECT p.id AS part_id, p.message_id, p.session_id, p.time_created, p.data AS part_data,
                    m.data AS message_data
             FROM part p JOIN message m ON m.id = p.message_id
             ORDER BY p.session_id, m.time_created, p.time_created, p.id`,
          )
          .all()) as {
      part_id: string;
      message_id: string;
      session_id: string;
      time_created: number;
      part_data: string;
      message_data: string;
    }[];

    const limit = opts?.limit ?? 200;
    const matches: SessionPart[] = [];
    for (const row of rows) {
      let decoded: Record<string, unknown>;
      let role: MessageRole;
      try {
        decoded = JSON.parse(row.part_data) as Record<string, unknown>;
        role = (JSON.parse(row.message_data) as Record<string, unknown>).role as MessageRole;
      } catch {
        continue;
      }
      if (searchableStrings(decoded).some(matcher)) {
        matches.push({
          partId: row.part_id,
          messageId: row.message_id,
          sessionId: row.session_id,
          timeCreated: row.time_created,
          role: role ?? "unknown",
          type: (decoded.type as PartType) ?? "other",
          data: decoded,
        });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }
}

/** Human-recognizable epoch-ms timestamp for JSONL output. */
export function iso(ms: number): string {
  return toIso(ms);
}

/**
 * Full-content serialization of one part (the `session get` shape). Uses the
 * same snake_case field names as the timeline entries so consumers pipe
 * list/search output into get without renaming. `data` is the complete
 * decoded part blob - tool parts carry their full input and output here,
 * untruncated.
 */
export function partToFullJson(part: SessionPart): Record<string, unknown> {
  return {
    part_id: part.partId,
    message_id: part.messageId,
    session_id: part.sessionId,
    timestamp: iso(part.timeCreated),
    role: part.role,
    type: part.type,
    data: part.data,
  };
}

/** Full-content serialization of one message with all of its parts. */
export function messageToFullJson(message: {
  messageId: string;
  sessionId: string;
  timeCreated: number;
  role: MessageRole;
  data: Record<string, unknown>;
  parts: SessionPart[];
}): Record<string, unknown> {
  return {
    message_id: message.messageId,
    session_id: message.sessionId,
    timestamp: iso(message.timeCreated),
    role: message.role,
    data: message.data,
    parts: message.parts.map(partToFullJson),
  };
}

/**
 * Builds the `session list` timeline entry for one part: a flat object with
 * common identity fields plus type-specific preview fields. Tool parts keep
 * their callID so callers can trace a call back to its transcript row.
 */
export function partToTimelineEntry(part: SessionPart): Record<string, unknown> {
  const base: Record<string, unknown> = {
    timestamp: iso(part.timeCreated),
    msg_id: part.messageId,
    part_id: part.partId,
    role: part.role,
    type: part.type,
  };
  switch (part.type) {
    case "text":
    case "reasoning":
      base.detail = truncate(String(part.data.text ?? ""));
      break;
    case "tool": {
      const state = (part.data.state ?? {}) as Record<string, unknown>;
      const toolName = String(part.data.tool ?? "");
      base.call_id = part.data.callID;
      base.tool = toolName;
      base.detail = toolName;
      base.args_preview = truncate(JSON.stringify(state.input ?? {}));
      base.output = truncate(String(state.output ?? ""));
      break;
    }
    case "patch":
      base.detail = ((part.data.files as string[]) ?? []).map((f) => f.split("/").pop()).join(", ");
      break;
    case "step-finish": {
      const tokens = (part.data.tokens ?? {}) as Record<string, unknown>;
      base.detail = `tokens: ${tokens.total ?? "?"} cost: ${part.data.cost ?? "?"}`;
      break;
    }
    default:
      base.detail = "";
  }
  return base;
}

/**
 * Builds the `session transcript` OpenAI chat-completions entry set for one
 * message. Returns 0..n lines: user messages become one {role:"user"} line;
 * assistant messages become one {role:"assistant"} line (with a tool_calls
 * array when the step made tool calls) followed by one {role:"tool"} line
 * per tool result. Reasoning and step boundaries have no chat-completions
 * equivalent and are dropped.
 */
export function partToTranscriptEntries(
  messageRole: MessageRole,
  parts: SessionPart[],
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  if (messageRole === "user") {
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => String(p.data.text ?? ""))
      .join("\n");
    if (text) entries.push({ role: "user", content: text });
    return entries;
  }
  if (messageRole !== "assistant") return entries;

  const textParts = parts.filter((p) => p.type === "text");
  const toolParts = parts.filter((p) => p.type === "tool");
  const content = textParts.map((p) => String(p.data.text ?? "")).join("\n");
  // A message with neither text nor tool calls (e.g. reasoning-only) has no
  // chat-completions representation - emit nothing rather than an empty line.
  if (!content && toolParts.length === 0) return entries;
  const assistant: Record<string, unknown> = { role: "assistant", content };
  if (toolParts.length > 0) {
    assistant.tool_calls = toolParts.map((p) => ({
      id: p.data.callID,
      type: "function",
      function: {
        name: p.data.tool,
        arguments: JSON.stringify((p.data.state as Record<string, unknown>)?.input ?? {}),
      },
    }));
  }
  entries.push(assistant);
  for (const p of toolParts) {
    entries.push({
      role: "tool",
      tool_call_id: p.data.callID,
      content: String((p.data.state as Record<string, unknown>)?.output ?? ""),
    });
  }
  return entries;
}
