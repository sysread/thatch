/**
 * The chat namespace: a window on the cross-session chat. Read-only
 * everywhere except `chat broadcast`, the one deliberate write path: it
 * voices the human user (sentinel sender) and delivers through the
 * ordinary poller, with no open-tab requirement at write time. A
 * namespace is a Subcommand whose run dispatches a child registry; each
 * child was a case of chatCommand's switch before the registry
 * replaced it.
 */
import {
  chatTailDiff,
  chatTailBacklog,
  filterChatTailRows,
  formatChatTailJsonl,
  createChatTailPretty,
  markdownBodyLines,
  CHAT_TAIL_DEFAULT_LIMIT,
  CHAT_STALE_MS,
  CHAT_MAX_BODY_CHARS,
  chatLiveness,
  humanAge,
  splitChatRoster,
  sortChatRoster,
  parseChatTimeBound,
  cliBroadcastFrame,
  sanitizeCliSenderName,
  matchesHostSessionID,
  buildChatRosterJsonRow,
  type ChatSessionRow,
  type ChatTailFilter,
  type ChatTailEvent,
} from "../../chat";
import { chatEnabled, loadConfig } from "../../config";
import { chatOpenTabs as chatOpenTabsProvider } from "../../tab-state";
import { flagValue, flagValues } from "../args";
import { printCommandHelp } from "../help";
import type { Subcommand } from "../types";

/** Column headers for the `chat list` roster, in display order. */
const CHAT_ROSTER_HEADER = ["NAME", "SESSION ID", "AGE", "STATUS", "PROJECT", "TOPIC"];

/**
 * Renders the `chat list` roster as three sections - Active, Recent, and
 * Stale - each an aligned-column table under a header row. Section headers
 * are bold, the Recent and Stale explainers are muted italic; rows use
 * green names, dim age, green/yellow/red status, and a muted italic topic.
 * The STATUS column carries the liveness verdict: open (tab open now),
 * recent (host alive, no open tab), active/idle (MCP rows), stale (host
 * presumed gone).
 * showRecent = false (the CLI default without `--recent`) collapses the
 * Recent section into a muted hidden-count note pointing at the flag.
 * Unlike the Stale hide - which the caller does by pre-filtering rows
 * before this function, dropping them silently - the recent hide needs
 * the rows in hand to count them, so it happens here as a note. An
 * all-recent roster therefore renders the note alone, with no section
 * header: there is no Recent section on the page to head, while the
 * stale hidden note rides under a header because its section IS
 * displayed;
 * staleCapMs bounds how old a stale row is displayed (null = no bound);
 * rows past the cap collapse into a muted hidden-count note so the reader
 * knows rows exist that the window left out.
 * now is the render's single clock sample: the split, every per-row
 * verdict, and the caller's pre-filter must agree, or a row aging past
 * the staleness boundary mid-render could land in two sections at once.
 * Color is applied only when stdout is an interactive terminal (and
 * NO_COLOR is unset), so piped output - grep, redirect, QA runners - stays
 * clean plain text.
 */
function formatChatRoster(sessions: ChatSessionRow[], staleCapMs: number | null = null, openTabs?: ReadonlySet<string>, showRecent = true, now = Date.now()): string {
  const colored = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const paint = (code: string, s: string) => (colored ? `\x1b[${code}m${s}\x1b[0m` : s);
  const { active, recent, stale, staleHidden } = splitChatRoster(sortChatRoster(sessions), now, staleCapMs, openTabs);
  const renderTable = (rows: ChatSessionRow[]) => {
    const cells = (r: ChatSessionRow) => [
      r.name,
      r.session_id,
      humanAge(r.last_seen),
      chatLiveness(r, now, openTabs),
      r.project ?? "unknown",
      r.topic ?? "",
    ];
    // Widths come from the PLAIN cell text; color is applied after padding
    // so zero-width escape codes never skew the alignment.
    const widths = CHAT_ROSTER_HEADER.map((h, i) => Math.max(h.length, ...rows.map((r) => cells(r)[i].length)));
    const align = (line: string[]) => line.map((c, i) => (i < line.length - 1 ? c.padEnd(widths[i]) : c));
    const header = align(CHAT_ROSTER_HEADER).map((h) => paint("1", h)).join("  ");
    const body = rows.map((r) => {
      const [name, sessionID, age, status, project, topic] = align(cells(r));
      // Green = present or reachable (open/active), yellow = alive host
      // without a tab (recent, wake not guaranteed), red = stale.
      const statusColor = status === "stale" ? "31" : status === "recent" ? "33" : "32";
      return [
        paint("32", name),
        paint("2", sessionID),
        paint("2", age),
        paint(statusColor, status),
        project,
        topic ? paint("3;90", topic) : "",
      ].join("  ").trimEnd();
    });
    return [header, ...body].join("\n");
  };
  const parts: string[] = [];
  if (active.length > 0) {
    parts.push([paint("1", "# Active Sessions"), renderTable(active)].join("\n"));
  }
  if (recent.length > 0) {
    if (showRecent) {
      const explainer = "These sessions have a fresh heartbeat but no open tab, so a wake may not reach them until their tab reopens; headless subordinates may still read mail on their own turns.";
      parts.push([paint("1", "# Recent Sessions"), paint("3;90", explainer), renderTable(recent)].join("\n"));
    } else {
      // Bare note, no section header: there is no Recent section on the
      // page, so a header would announce a section the view does not
      // render. The stale hidden note rides under a header because with
      // --stale its section IS rendered.
      parts.push(
        paint("3;90", `${recent.length} recent session${recent.length === 1 ? "" : "s"} hidden (alive, no open tab); --recent to show`),
      );
    }
  }
  if (stale.length > 0 || staleHidden > 0) {
    const lines = [paint("1", "# Stale Sessions")];
    if (stale.length > 0) {
      const explainer = `These sessions have missed their heartbeat for over ${Math.round(CHAT_STALE_MS / 1000)} seconds. Their harnesses may no longer be running (stopped, or the machine slept); mail waits until they resume.`;
      lines.push(paint("3;90", explainer), renderTable(stale));
    }
    if (staleHidden > 0) {
      lines.push(
        paint(
          "3;90",
          `${staleHidden} older stale session${staleHidden === 1 ? "" : "s"} hidden; --stale N widens the window to N days, --stale all shows everything.`,
        ),
      );
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/** Terminal width for `chat tail --pretty`: the real terminal when stdout
 *  is one, then COLUMNS, then 100 - the same ladder chat-pretty uses. */
function tailWidth(): number {
  if (process.stdout.isTTY && typeof process.stdout.columns === "number" && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  const columns = process.env.COLUMNS;
  if (columns !== undefined && /^\d+$/.test(columns)) return Number(columns);
  return 100;
}

/** Prints one tail event: pretty cards line by line, or the JSONL log. */
function printTailEvent(pretty: { render(event: ChatTailEvent): string[] } | null, event: ChatTailEvent): void {
  if (pretty) console.log(pretty.render(event).join("\n"));
  else console.log(formatChatTailJsonl(event));
}

const list: Subcommand = {
  name: "list",
  summary: "Registered chat sessions: name, session id, age, status, project, topic",
  usage: () => ({
    synopsis: "thatch chat list [--recent] [--stale N|all] [--json] [--host-id ID]...",
    flags: [
      { long: "--recent", short: null, description: "Also show Recent sessions (fresh heartbeat, no open tab)." },
      { long: "--stale", short: null, description: "Also show Stale sessions; N bounds the window to N days (default 1), all shows every stale one." },
      { long: "--json", short: null, description: "One JSON object per row (name, session_id, host_kind, project, topic, status, last_seen, unread) instead of the table." },
      { long: "--host-id", short: null, description: "Look up rows by the HOST session id a launcher already knows (repeatable; point query, staleness filter does not apply; JSON rows echo the id in host_id)." },
    ],
    notes: [
      "Default shows only open sessions (plus MCP rows, which read mail at their next prompt). Tab-less fresh sessions collapse into a hidden-count note; --recent shows them.",
    ],
  }),
  async run(args, ctx) {
    // --stale N bounds how old a stale row the roster displays, in days
    // (fractions allowed); the default of one day keeps long-dead
    // sessions from burying the fresh signal. --stale all restores the
    // unbounded view. A bad value dies loudly rather than silently
    // shrinking the roster.
    // Default: open sessions only (plus MCP rows, which read mail at
    // their next prompt - "open" is meaningless for them). --recent
    // opts into the Recent section (alive, no open tab). The two hidden
    // defaults work differently: --recent's leaves a muted count note
    // in the renderer (it needs the rows in hand to count them);
    // --stale's drops the rows silently in the pre-filter below, and
    // only the empty-roster message points at the flag. Unlike --stale
    // it takes no window value: recent rows are bounded by the heartbeat
    // window itself, so there is nothing to cap. The value is parsed by
    // hand (not flagValue) because bare --stale is meaningful.
    // --json swaps the table for the machine-readable roster: one JSON
    // object per row (GitHub issue #23). Same staleness/recent filters
    // as the text view; zero matching rows print zero lines.
    const jsonMode = args.includes("--json");
    // --host-id <id> is REPEATABLE: a lane orchestrator looks up all its
    // lanes in one call. Each id is matched internally (raw for
    // opencode rows, hashed for MCP rows) so the caller never learns
    // the hash scheme; a lookup is a POINT QUERY - it skips the
    // staleness pre-filter (a caller asking for a specific id wants
    // that row even when idle), and the JSON row echoes the caller's id
    // in host_id so a multi-id lookup is joinable. No match prints
    // nothing (JSON) or a diagnostic line (text).
    const hostIds = args.flatMap((a, i) => (a === "--host-id" ? [args[i + 1]] : []))
      .filter((v): v is string => v !== undefined && !v.startsWith("--"));
    const showRecent = args.includes("--recent");
    const showStale = args.includes("--stale");
    const staleIdx = args.indexOf("--stale");
    const rawNext = showStale ? args[staleIdx + 1] : undefined;
    // A token starting with "--" is a sibling flag (e.g. "--stale
    // --recent"), not --stale's value: --stale stays bare instead of
    // eating the flag.
    const staleNext = rawNext !== undefined && rawNext.startsWith("--") ? undefined : rawNext;
    let staleCapMs: number | null = 24 * 60 * 60 * 1000;
    if (staleNext !== undefined) {
      if (staleNext === "all") staleCapMs = null;
      else if (!/^\d+(\.\d+)?$/.test(staleNext) || Number(staleNext) <= 0) {
        console.error(`error: --stale expects a positive number of days or "all", got "${staleNext}"`);
        process.exit(1);
      } else staleCapMs = Number(staleNext) * 24 * 60 * 60 * 1000;
    }
    // The open-tab set is read once per invocation at render time: rows
    // with a tab render "open", fresh rows without one "recent".
    const openTabs = chatOpenTabsProvider(() => ctx.db.chatTabClosures())();
    // One clock sample per render: the pre-filter, the split, and every
    // per-row verdict must agree, or a row aging past the staleness
    // boundary mid-render could land in two sections at once.
    const now = Date.now();
    const registered = ctx.db.listChatSessions();

    // Lookup mode (--host-id): a point query over the whole roster,
    // bypassing the staleness pre-filter (see the comment above).
    if (hostIds.length > 0) {
      const echo = new Map<string, string>();
      const matched = registered.filter((r) => {
        const hit = hostIds.find((h) => matchesHostSessionID(r, h));
        if (hit) echo.set(r.session_id, hit);
        return hit !== undefined;
      });
      if (jsonMode) {
        for (const r of matched) {
          console.log(JSON.stringify(buildChatRosterJsonRow(r, chatLiveness(r, now, openTabs), ctx.db.unreadChatCount(r.session_id), echo.get(r.session_id))));
        }
        return;
      }
      if (matched.length === 0) {
        console.log(`No chat session matches the given --host-id (${hostIds.length} id${hostIds.length === 1 ? "" : "s"} given).`);
        return;
      }
      console.log(formatChatRoster(matched, showStale ? staleCapMs : null, openTabs, showRecent, now));
      return;
    }

    if (jsonMode) {
      const rows = showStale ? registered : registered.filter((r) => chatLiveness(r, now, openTabs) !== "stale");
      for (const r of rows) {
        console.log(JSON.stringify(buildChatRosterJsonRow(r, chatLiveness(r, now, openTabs), ctx.db.unreadChatCount(r.session_id))));
      }
      return;
    }

    // Stale rows are hidden here (not in the renderer) so the
    // emptiness check can tell an empty directory from a stale-only
    // one; recent rows are left in because formatChatRoster needs them
    // to render the hidden-count note.
    const sessions = registered.filter((r) => showStale || chatLiveness(r, now, openTabs) !== "stale");
    if (sessions.length === 0) {
      console.log(
        registered.length === 0
          ? "No sessions registered. Sessions join the directory automatically on their first idle (opencode), or via chat_register."
          : "No active sessions. (Stale sessions are hidden; run with --stale to include them.)",
      );
      return;
    }
    console.log(formatChatRoster(sessions, showStale ? staleCapMs : null, openTabs, showRecent, now));
  },
};

const tail: Subcommand = {
  name: "tail",
  summary: "Follow cross-session chat as a JSONL event log",
  usage: () => ({
    synopsis: "thatch chat tail [--once] [--pretty] [--limit N|all] [--match RE] [--from NAME] [--to NAME] [--since DT] [--until DT]",
    flags: [
      { long: "--once", short: null, description: "Print the backlog and exit instead of following." },
      { long: "--pretty", short: null, description: "Render each event as an email-style card (markdown bodies through glow when installed; color only on a terminal, NO_COLOR disables it)." },
      { long: "--limit", short: null, description: `Backlog size: N messages, or all (default: the last ${CHAT_TAIL_DEFAULT_LIMIT}).` },
      { long: "--match", short: null, description: "Filter message bodies by regular expression (repeatable, ANDed)." },
      { long: "--from", short: null, description: "Filter by sender name (substring)." },
      { long: "--to", short: null, description: "Filter by recipient name (substring)." },
      { long: "--since", short: null, description: "Start of the window (\"YYYY-MM-DD [HH:MM]\" local time)." },
      { long: "--until", short: null, description: "End of the window (\"YYYY-MM-DD [HH:MM]\" local time)." },
    ],
    notes: [
      "One line per event, \"sent\" and \"read\" as separate events linked by message id. Filters apply to follow mode too.",
    ],
  }),
  async run(args, ctx) {
    const onceOnly = args.includes("--once");
    // --pretty swaps the JSONL log for email-style cards (see
    // createChatTailPretty); the JSONL contract is untouched without it.
    const pretty = args.includes("--pretty")
      ? createChatTailPretty({
          width: tailWidth(),
          // The same color rule as the chat roster: a terminal and no
          // NO_COLOR. Piped pretty output stays plain so downstream
          // tools see text, not escape codes.
          color: process.stdout.isTTY === true && !process.env.NO_COLOR,
          renderBody: markdownBodyLines,
        })
      : null;
    // Parse and validate everything up front: a bad regex or date must
    // fail before any lines print, not mid-follow.
    const matches = flagValues(args, "--match").map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        console.error(`error: --match is not a valid regular expression: "${pattern}"`);
        process.exit(1);
      }
    });
    const limitArg = flagValue(args, "--limit");
    let limit: number | null = CHAT_TAIL_DEFAULT_LIMIT;
    if (limitArg !== undefined) {
      if (limitArg === "all") limit = null;
      else if (!/^\d+$/.test(limitArg)) {
        console.error(`error: --limit expects a positive integer or "all", got "${limitArg}"`);
        process.exit(1);
      } else limit = Number(limitArg);
      if (limit !== null && limit < 1) {
        console.error(`error: --limit expects a positive integer or "all", got "${limitArg}"`);
        process.exit(1);
      }
    }
    let sinceMs: number | null = null;
    let untilMs: number | null = null;
    try {
      const since = flagValue(args, "--since");
      const until = flagValue(args, "--until");
      if (since !== undefined) sinceMs = parseChatTimeBound(since, "--since");
      if (until !== undefined) untilMs = parseChatTimeBound(until, "--until");
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
    if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) {
      console.error("error: --since is not before --until; the window is empty");
      process.exit(1);
    }
    const fromName = flagValue(args, "--from");
    const toName = flagValue(args, "--to");
    const filter: ChatTailFilter = {
      matches,
      fromSubstr: fromName !== undefined ? [fromName] : [],
      toSubstr: toName !== undefined ? [toName] : [],
      sinceMs,
      untilMs,
    };

    // Diff state: one entry per seen message id holding its read_at, so
    // each poll emits only new messages and newly-read rows. The diff
    // and backlog logic lives in src/chat.ts (chatTailDiff,
    // chatTailBacklog), unit-tested there. The backlog seeds the state
    // from every feed row, so the limit hides lines, not history.
    let state: Map<number, string | null>;

    // Follow mode holds the handle open until Ctrl-C. The finally below
    // closes it on every exit path except the SIGINT handler's, which
    // is why the handler closes it itself: process.exit does not unwind
    // finally blocks (closing twice is harmless).
    try {
      // First pass: print the backlog, then follow unless
      // --once or the --until window has already closed (a closed
      // window has no future events to follow). The backlog fetch gets
      // the same friendly failure treatment as follow polls: a locked
      // or missing database should say so, not die with a stack trace.
      let backlog;
      try {
        backlog = chatTailBacklog(ctx.db.chatMessageFeed(), filter, limit);
      } catch (err) {
        console.error(`[thatch chat tail] feed query failed: ${err}`);
        console.error("The database may be locked or missing; exiting.");
        return;
      }
      state = backlog.state;
      if (backlog.elided > 0) {
        // The elision note goes to stderr so stdout stays pure JSONL
        // for pipes.
        console.error(
          `[thatch chat tail] showing last ${backlog.shown} of ${backlog.elided + backlog.shown} messages (--limit N, --limit all)`,
        );
      }
      for (const event of backlog.events) printTailEvent(pretty, event);
      if (onceOnly || (filter.untilMs !== null && filter.untilMs <= Date.now())) return;

      process.on("SIGINT", () => {
        ctx.db.close();
        process.exit(0);
      });
      for (;;) {
        await Bun.sleep(2000);
        try {
          // Follow polls re-filter the live feed: matching messages
          // surface as they arrive, non-matching ones stay invisible.
          for (const event of chatTailDiff(state, filterChatTailRows(ctx.db.chatMessageFeed(), filter)).events) {
            printTailEvent(pretty, event);
          }
        } catch (err) {
          // The surface's whole job is watching a shared, mutable file;
          // a feed failure should say so, not die with a stack trace.
          console.error(`[thatch chat tail] feed query failed: ${err}`);
          console.error("The database may be locked or missing; exiting.");
          return;
        }
        // The window check runs after the poll, so a message created
        // inside the window but landed during the final sleep is still
        // displayed; anything inserted after this poll has a created_at
        // past the bound and is filtered by the window anyway.
        if (filter.untilMs !== null && Date.now() >= filter.untilMs) return;
      }
    } finally {
      ctx.db.close();
      // The script tail also closes; closing twice is harmless and the
      // early-return paths need this one.
    }
  },
};

const broadcast: Subcommand = {
  name: "broadcast",
  summary: "Send a message from you (the human user, at a terminal) to every live chat session",
  usage: () => ({
    synopsis: "thatch chat broadcast <msg> [--project P]...",
    flags: [
      { long: "--project", short: null, description: "Narrow the audience to those projects (exact match; repeatable)." },
    ],
    notes: [
      "You are not in the chat: delivered bodies carry a note saying so, and recipients answer you in their own session, not in chat. Delivery is the ordinary poll: open sessions are woken, tab-less and MCP sessions read at their next prompt; stale opencode sessions are skipped and named.",
    ],
  }),
  async run(args, ctx) {
    // The one chat write path: the user speaking from a terminal. The
    // sender is a sentinel (never a registered session), delivery rides
    // the ordinary poller (waking open sessions; no tab requirement at
    // write time), and the fence note in the body tells recipients the
    // protocol. A typo'd flag must not go out to every session as
    // message text, so unknown `--` tokens die loudly instead of
    // joining the message.
    if (!chatEnabled(loadConfig(ctx.dbPath).config)) {
      console.error("error: cross-session chat is off (chat.enabled: false in the thatch config); nothing was sent.");
      process.exit(1);
    }
    const projects: string[] = [];
    const message: string[] = [];
    // End-of-flags: a bare `--` puts every later token in the message,
    // so a body that starts with `--` can still be sent.
    let afterDashDash = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (afterDashDash) {
        message.push(arg);
        continue;
      }
      if (arg === "--") {
        afterDashDash = true;
      } else if (arg === "--project") {
        const value = args[++i];
        // The sibling-flag rule (the --stale precedent): a token
        // starting with `--` is a flag, not this flag's value.
        if (value === undefined || value.startsWith("--")) {
          console.error("error: --project expects a value");
          process.exit(1);
        }
        if (!value.trim()) {
          console.error(`error: --project expects a project name, got "${value}"`);
          process.exit(1);
        }
        projects.push(value.trim());
      } else if (arg.startsWith("--project=")) {
        const value = arg.slice("--project=".length);
        if (!value.trim()) {
          console.error(`error: --project expects a project name, got "${value}"`);
          process.exit(1);
        }
        projects.push(value.trim());
      } else if (arg.startsWith("--")) {
        console.error(`error: unknown flag "${arg}" (only --project is supported; put -- before the message to send text that starts with --)`);
        process.exit(1);
      } else {
        message.push(arg);
      }
    }
    const body = message.join(" ").trim();
    if (!body) {
      console.error("usage: thatch chat broadcast <message> [--project P]...");
      process.exit(1);
    }
    // The cap check runs on the FRAMED body (the fence note rides in
    // every row), and the refusal reports the user's body count, not
    // the note's.
    if (cliBroadcastFrame(body).length > CHAT_MAX_BODY_CHARS) {
      console.error(`error: message too long: attempted ${body.length} characters (max ${CHAT_MAX_BODY_CHARS} including the broadcast note). Split it into several broadcasts.`);
      process.exit(1);
    }
    // Sender identity: git config first (human-friendly), then the OS
    // user; sanitizeCliSenderName strips anything NAME_CHARSET forbids.
    let rawName = process.env.USER ?? "";
    try {
      const gitName = Bun.spawnSync(["git", "config", "user.name"], { stdout: "pipe" }).stdout.toString().trim();
      if (gitName) rawName = gitName;
    } catch {
      // No git available or not a repo: the env fallback stands.
    }
    let result;
    try {
      result = ctx.db.broadcastChatMessageFromUser(cliBroadcastFrame(body), {
        projects: projects.length > 0 ? projects : undefined,
        senderName: sanitizeCliSenderName(rawName),
      });
    } catch (err) {
      console.error(`[thatch chat broadcast] failed: ${err}`);
      console.error("The database may be locked or missing; nothing was sent.");
      process.exit(1);
    }
    if (!result.ok) {
      console.error(`error: broadcast refused: ${result.error}`);
      process.exit(1);
    }
    // Per-recipient report. Liveness labels come from the post-write
    // roster (names are never reused, so the join by name is stable);
    // a concurrently vanished row just gets no label.
    const rowsByName = new Map(ctx.db.listChatSessions().map((r) => [r.name, r]));
    const openTabs = chatOpenTabsProvider(() => ctx.db.chatTabClosures())();
    const now = Date.now();
    const label = (r: { name: string }): string => {
      const row = rowsByName.get(r.name);
      if (!row) return "";
      if (row.host_kind === "mcp") return "mcp, reads at next prompt";
      return chatLiveness(row, now, openTabs) === "open" ? "open" : "no tab, reads at next prompt";
    };
    const audience = result.recipients.length + result.skipped.length + result.outOfScope.length;
    const scope = projects.length > 0 ? ` (projects: ${projects.join(", ")})` : "";
    console.log(`Broadcast from ${result.senderName} to ${result.recipients.length} of ${audience} registered sessions${scope}:`);
    for (const r of result.recipients) console.log(`  delivered: ${r.name} (${r.project ?? "no project"}) [${label(r)}]`);
    for (const s of result.skipped) console.log(`  skipped (${s.reason}): ${s.name} (${s.project ?? "no project"})`);
    for (const o of result.outOfScope) console.log(`  out of scope (project filter): ${o.name} (${o.project ?? "no project"})`);
    if (result.deduped > 0) console.log(`  duplicate suppressed for ${result.deduped} recipient${result.deduped === 1 ? "" : "s"} (an identical unread broadcast stands)`);
    if (result.parts > 1) console.log(`  sent as ${result.parts} parts per recipient (body exceeded the split length)`);
  },
};

const CHILDREN: Subcommand[] = [list, tail, broadcast];

export const chat: Subcommand = {
  name: "chat",
  summary: "Cross-session chat (list, tail, broadcast)",
  usage: () => ({ synopsis: "thatch chat <sub>", flags: [] }),
  children: CHILDREN,
  async run(args, ctx) {
    const [sub, ...rest] = args;
    const child = sub ? CHILDREN.find((c) => c.name === sub) : undefined;
    if (!child) printCommandHelp(chat);
    await child.run(rest, ctx);
  },
};
