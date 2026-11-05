/**
 * The session namespace: read-only archaeology on the opencode session
 * database. A namespace is a Subcommand whose run dispatches a child
 * registry; each child was a case of sessionCommand's switch before the
 * registry replaced it. Every child opens its own SessionDB - the
 * CliContext's ThatchDB is the thatch store, not the opencode database.
 */
import { resolveOpencodeDbPath, SessionDB, partToTimelineEntry, partToTranscriptEntries, partToFullJson, messageToFullJson } from "../../session-db";
import { flagValue, parseTimeBound } from "../args";
import { printCommandHelp } from "../help";
import type { Subcommand } from "../types";

/** Opens the opencode database, or says why there is none to open. */
function openSessionDb(): SessionDB {
  const path = resolveOpencodeDbPath();
  if (!path) {
    console.error(
      "error: no opencode database found. The session commands inspect the\n" +
        "session history of the opencode host; other hosts (Claude Code, Cursor)\n" +
        "have no such database. Set OPENCODE_DB to point at an opencode.db file.",
    );
    process.exit(1);
  }
  return new SessionDB(path);
}

const list: Subcommand = {
  name: "list",
  summary: "JSONL timeline of a session's parts (one line per part)",
  usage: () => ({
    synopsis: "thatch session list -s <id> [--after T] [--before T]",
    flags: [
      { long: "--session", short: "-s", description: "Session id (required)." },
      { long: "--after", short: null, description: "Only parts after this time (ISO timestamp or epoch ms)." },
      { long: "--before", short: null, description: "Only parts before this time (ISO timestamp or epoch ms)." },
    ],
  }),
  async run(args) {
    const sessionID = flagValue(args, "-s", "--session");
    const after = flagValue(args, "--after");
    const before = flagValue(args, "--before");
    if (!sessionID) {
      console.error("error: session list requires -s/--session <session id>");
      process.exit(1);
    }
    const db = openSessionDb();
    try {
      const parts = db.listParts(
        sessionID,
        after ? parseTimeBound(after, "--after") : undefined,
        before ? parseTimeBound(before, "--before") : undefined,
      );
      for (const part of parts) console.log(JSON.stringify(partToTimelineEntry(part)));
    } finally {
      db.close();
    }
  },
};

const get: Subcommand = {
  name: "get",
  summary: "Full JSON of one part (tool parts include their output) or one message with all its parts",
  usage: () => ({
    synopsis: "thatch session get --id <part_id|msg_id>",
    flags: [{ long: "--id", short: null, description: "A part id (part_...) or message id (msg_...)." }],
  }),
  async run(args) {
    const db = openSessionDb();
    try {
      const id = flagValue(args, "--id");
      if (!id) {
        console.error("error: session get requires --id <part_id|msg_id>");
        process.exit(1);
      }
      if (id.startsWith("msg_")) {
        const message = db.getMessage(id);
        if (!message) {
          console.error(`error: no message "${id}" in ${db.path}`);
          process.exit(1);
        }
        console.log(JSON.stringify(messageToFullJson(message), null, 2));
      } else {
        const part = db.getPart(id);
        if (!part) {
          console.error(`error: no part "${id}" in ${db.path}`);
          process.exit(1);
        }
        console.log(JSON.stringify(partToFullJson(part), null, 2));
      }
    } finally {
      db.close();
    }
  },
};

const transcript: Subcommand = {
  name: "transcript",
  summary: "Full conversation as OpenAI chat-completions JSONL",
  usage: () => ({
    synopsis: "thatch session transcript -s <id>",
    flags: [{ long: "--session", short: "-s", description: "Session id (required)." }],
  }),
  async run(args) {
    const sessionID = flagValue(args, "-s", "--session");
    if (!sessionID) {
      console.error("error: session transcript requires -s/--session <session id>");
      process.exit(1);
    }
    const db = openSessionDb();
    try {
      for (const message of db.listMessages(sessionID)) {
        for (const entry of partToTranscriptEntries(message.role, message.parts)) {
          console.log(JSON.stringify(entry));
        }
      }
    } finally {
      db.close();
    }
  },
};

const search: Subcommand = {
  name: "search",
  summary: "JSONL of matching parts across sessions (decoded content)",
  usage: () => ({
    synopsis: "thatch session search <query> [--session <id>] [--regex] [--limit N]",
    flags: [
      { long: "--session", short: "-s", description: "Restrict the search to one session." },
      { long: "--regex", short: null, description: "Treat the query as a regular expression instead of a substring." },
      { long: "--limit", short: null, description: "Cap the number of matching parts." },
    ],
  }),
  async run(args) {
    // Positional = args not preceded by a value-taking flag. Values like
    // "50" or a session id don't start with "-", so predecessor checks
    // are the only reliable discriminator.
    const valueFlags = new Set(["-s", "--session", "--limit"]);
    const positional = args.filter((a, i) => !a.startsWith("-") && !valueFlags.has(args[i - 1] ?? ""));
    const query = positional[0];
    if (!query) {
      console.error("error: session search requires a query (substring, or regex with --regex)");
      process.exit(1);
    }
    const sessionID = flagValue(args, "-s", "--session");
    const limit = flagValue(args, "--limit");
    const db = openSessionDb();
    try {
      const matches = db.search(query, {
        regex: args.includes("--regex"),
        sessionID,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      // Titles let a cross-session result list be triaged without a
      // second lookup per hit. Sessions are cached - matches cluster.
      const titles = new Map<string, string | null>();
      for (const part of matches) {
        if (!titles.has(part.sessionId)) {
          titles.set(part.sessionId, db.getSession(part.sessionId)?.title ?? null);
        }
        const entry: Record<string, unknown> = {
          session_id: part.sessionId,
          session_title: titles.get(part.sessionId),
          ...partToTimelineEntry(part),
        };
        console.log(JSON.stringify(entry));
      }
    } finally {
      db.close();
    }
  },
};

const CHILDREN: Subcommand[] = [list, get, transcript, search];

export const session: Subcommand = {
  name: "session",
  summary: "Inspect opencode session history (list, get, transcript, search)",
  usage: () => ({ synopsis: "thatch session <sub>", flags: [] }),
  children: CHILDREN,
  async run(args, ctx) {
    const [sub, ...rest] = args;
    const child = sub ? CHILDREN.find((c) => c.name === sub) : undefined;
    if (!child) printCommandHelp(session);
    await child.run(rest, ctx);
  },
};
