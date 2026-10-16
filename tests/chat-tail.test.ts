import { describe, test, expect } from "bun:test";
import { chatTailDiff, formatChatTailJsonl, parseChatTimeBound, filterChatTailRows, chatTailBacklog, createChatTailPretty, createMarkdownBodyRenderer, markdownBodyLines, wrapChatBody, type ChatTailRow, type ChatTailFilter, type ChatTailEvent } from "../src/chat";

/** Shared ChatTailRow factory for the tail test blocks: a direct message
 *  from alice to bob, with every field overridable. */
const tailRow = (over: Partial<ChatTailRow> & { id: number }): ChatTailRow => ({
  from: "alice",
  to: "bob",
  fromTopic: null,
  toTopic: null,
  viaBroadcast: false,
  body: "hello",
  created_at: "2026-09-12T10:00:00Z",
  read_at: null,
  ...over,
});

/** The no-op filter: every constraint absent. */
const tailNoFilter = (): ChatTailFilter => ({ matches: [], fromSubstr: [], toSubstr: [], sinceMs: null, untilMs: null });

describe("chat tail diff", () => {
  const row = tailRow;

  test("new rows emit sent events; broadcast rows keep their recipient and set the flag", () => {
    const { events, state } = chatTailDiff(new Map(), [
      row({ id: 1 }),
      row({ id: 2, viaBroadcast: true, to: "carol", body: "rise up" }),
      row({ id: 3, from: null, to: "bob", body: "from a departed sender" }),
    ]);
    expect(events.map((e) => e.event)).toEqual(["sent", "sent", "sent"]);
    expect(events[0]).toMatchObject({ id: 1, from: "alice", to: "bob", broadcast: false });
    expect(events[1]).toMatchObject({ id: 2, to: "carol", broadcast: true });
    expect(events[2]).toMatchObject({ from: "unknown" });
    expect([...state.keys()]).toEqual([1, 2, 3]);
  });

  test("topics ride through to sent and read events", () => {
    // First poll: both rows are new (row 2 unread), so both emit sent.
    const first = chatTailDiff(new Map(), [
      row({ id: 1, fromTopic: "watching CI", toTopic: "plotting rebase" }),
      row({ id: 2, fromTopic: "watching CI" }),
    ]);
    expect(first.events[0]).toMatchObject({ event: "sent", from: "alice", from_topic: "watching CI", to: "bob", to_topic: "plotting rebase" });
    // Second poll: row 2's read stamp appears (null -> set) and emits a
    // read event, with the sender's topic riding along for the annotation.
    const second = chatTailDiff(first.state, [
      row({ id: 2, fromTopic: "watching CI", read_at: "2026-09-12T10:02:00Z" }),
    ]);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ event: "read", id: 2, reader: "bob", from: "alice", from_topic: "watching CI" });
  });

  test("a row's read_at appearing emits a read event exactly once", () => {
    const state = new Map([[7, null]]);
    const first = chatTailDiff(state, [row({ id: 7, read_at: "2026-09-12T10:01:00Z" })]);
    expect(first.events).toEqual([
      { event: "read", at: "2026-09-12T10:01:00Z", id: 7, reader: "bob", reader_topic: null, from: "alice", from_topic: null },
    ]);
    // The second poll over the same state is silent.
    expect(chatTailDiff(first.state, [row({ id: 7, read_at: "2026-09-12T10:01:00Z" })]).events).toEqual([]);
  });

  test("a message inserted and read between polls emits only its sent line", () => {
    const { events } = chatTailDiff(new Map(), [row({ id: 5, read_at: "2026-09-12T10:01:00Z" })]);
    expect(events.map((e) => e.event)).toEqual(["sent"]);
  });

  test("JSONL rendering: one JSON object per event, sent and read distinct, linked by id", () => {
    const { events } = chatTailDiff(new Map(), [row({ id: 9, body: "multi\nline **markdown** \u001b[31mred\u001b[0m" })]);
    const line = formatChatTailJsonl(events[0]);
    // Exactly one line, parseable, body untouched (no rendering, no ANSI
    // stripping, no local time): a log is for jq and grep.
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      event: "sent", at: "2026-09-12T10:00:00Z", id: 9, from: "alice", from_topic: null,
      to: "bob", to_topic: null, broadcast: false, body: "multi\nline **markdown** \u001b[31mred\u001b[0m",
    });
    const read = chatTailDiff(new Map([[9, null]]), [row({ id: 9, read_at: "2026-09-12T10:05:00Z" })]).events[0];
    expect(JSON.parse(formatChatTailJsonl(read))).toEqual({
      event: "read", at: "2026-09-12T10:05:00Z", id: 9, reader: "bob", reader_topic: null, from: "alice", from_topic: null,
    });
  });
});

describe("chat tail time bounds", () => {
  test("date-only parses as local midnight; HH:MM parses in local time", () => {
    const midnight = new Date(parseChatTimeBound("2026-09-13", "--since"));
    expect([midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), midnight.getHours(), midnight.getMinutes()]).toEqual([2026, 8, 13, 0, 0]);
    const withTime = new Date(parseChatTimeBound("2026-09-13 14:30", "--until"));
    expect([withTime.getFullYear(), withTime.getMonth(), withTime.getDate(), withTime.getHours(), withTime.getMinutes()]).toEqual([2026, 8, 13, 14, 30]);
    // A T separator is accepted alongside the space form.
    const tForm = new Date(parseChatTimeBound("2026-09-13T09:05", "--since"));
    expect([tForm.getHours(), tForm.getMinutes()]).toEqual([9, 5]);
  });

  test("malformed and impossible values are rejected", () => {
    for (const bad of ["", "not-a-date", "2026-9-13", "2026-13-01", "2026-09-31", "2026-02-29", "2026-09-13 25:99", "2026-09-13T10:70", "2026-09-13 10:00:00"]) {
      expect(() => parseChatTimeBound(bad, "--since")).toThrow();
    }
  });
});

describe("chat tail row filter", () => {
  const row = tailRow;
  const noFilter = tailNoFilter;

  test("match regexes AND together and test the body only", () => {
    const filter = { ...noFilter(), matches: [/rebase/i, /payments/] };
    // Both patterns must hit, regardless of case.
    expect(filterChatTailRows([row({ id: 1, body: "Rebase the payments module" })], filter)).toHaveLength(1);
    // One match short of AND leaves the row out - even when the missing
    // pattern's word appears in a participant name instead of the body.
    expect(filterChatTailRows([row({ id: 2, body: "rebasing the module", from: "payments-watcher" })], filter)).toHaveLength(0);
  });

  test("from/to substrings match rendered names case-insensitively", () => {
    const filter = { ...noFilter(), fromSubstr: ["AL"], toSubstr: ["bo"] };
    expect(filterChatTailRows([row({ id: 1, from: "Al Go Rithm", to: "Bob" })], filter)).toHaveLength(1);
    expect(filterChatTailRows([row({ id: 2, from: "Marlowe", to: "Bob" })], filter)).toHaveLength(0);
    expect(filterChatTailRows([row({ id: 3, from: "Al Go Rithm", to: "Carol" })], filter)).toHaveLength(0);
  });

  test("since/until form a half-open window on created_at", () => {
    // Boundary rows are built from the same local clock the parser uses,
    // so the expected in/out split is fixed per row in any timezone: id 1
    // is one second before --since (out), 2 lands exactly on --since
    // (inclusive), 3 inside, 4 exactly on --until (exclusive), 5 after.
    const sinceMs = parseChatTimeBound("2026-09-12 09:30", "--since");
    const untilMs = parseChatTimeBound("2026-09-12 10:00", "--until");
    const filter = { ...noFilter(), sinceMs, untilMs };
    const rows = [
      row({ id: 1, created_at: new Date(sinceMs - 1000).toISOString() }),
      row({ id: 2, created_at: new Date(sinceMs).toISOString() }),
      row({ id: 3, created_at: new Date(sinceMs + 60_000).toISOString() }),
      row({ id: 4, created_at: new Date(untilMs).toISOString() }),
      row({ id: 5, created_at: new Date(untilMs + 60_000).toISOString() }),
    ];
    expect(filterChatTailRows(rows, filter).map((r) => r.id)).toEqual([2, 3]);
  });

  test("absent bounds keep every row that passes the other filters", () => {
    expect(filterChatTailRows([row({ id: 1 })], noFilter())).toHaveLength(1);
  });

  test("broadcast rows match their real recipient; departed participants match their rendered strings", () => {
    // Fan-out rows carry the real recipient, so --to <name> finds them.
    expect(filterChatTailRows([row({ id: 1, viaBroadcast: true, to: "beta" })], { ...noFilter(), toSubstr: ["beta"] })).toHaveLength(1);
    expect(filterChatTailRows([row({ id: 1, viaBroadcast: true, to: "beta" })], { ...noFilter(), toSubstr: ["broadcast"] })).toHaveLength(0);
    // A departed sender matches its unknown-departed rendering,
    // because messageFeed already renders names through
    // renderChatParticipant before the filter sees the row.
    const departed = { ...noFilter(), fromSubstr: ["departed"] };
    expect(filterChatTailRows([row({ id: 2, from: "unknown (ses_mortal1, departed)" })], departed)).toHaveLength(1);
  });
});

describe("chat tail backlog", () => {
  const row = tailRow;
  const noFilter = tailNoFilter;
  const feed = () => [
    row({ id: 1, body: "one" }),
    row({ id: 2, body: "two" }),
    row({ id: 3, body: "three" }),
    row({ id: 4, body: "four" }),
    row({ id: 5, body: "five" }),
  ];

  test("limit renders the last N rows and counts the elided rest", () => {
    const { events, state, elided } = chatTailBacklog(feed(), noFilter(), 2);
    expect(events.map((e) => (e.event === "sent" ? e.body : null))).toEqual(["four", "five"]);
    expect(elided).toBe(3);
    // The diff state covers every filtered row, not just the rendered ones.
    expect([...state.keys()]).toEqual([1, 2, 3, 4, 5]);
  });

  test("a null limit keeps everything and elides nothing", () => {
    const { events, elided } = chatTailBacklog(feed(), noFilter(), null);
    expect(events).toHaveLength(5);
    expect(elided).toBe(0);
  });

  test("already-read messages emit their read event in the snapshot, in time order", () => {
    // A snapshot is a log, not a diff: a message read before the tail
    // started still shows both events. Reads sort by their own timestamp
    // (here row 1's read lands after row 2's send), and reads of messages
    // the limit hid stay hidden with them.
    const rows = [
      row({ id: 1, body: "one", created_at: "2026-09-12T10:00:00Z", read_at: "2026-09-12T10:02:00Z" }),
      row({ id: 2, body: "two", created_at: "2026-09-12T10:01:00Z" }),
      row({ id: 3, body: "three", created_at: "2026-09-12T10:03:00Z", read_at: "2026-09-12T10:03:30Z" }),
    ];
    const { events, shown, elided } = chatTailBacklog(rows, noFilter(), null);
    expect(events.map((e) => `${e.event}:${e.id}`)).toEqual(["sent:1", "sent:2", "read:1", "sent:3", "read:3"]);
    // shown/elided count messages, not lines: 5 events, 3 messages.
    expect(shown).toBe(3);
    expect(elided).toBe(0);
    const limited = chatTailBacklog(rows, noFilter(), 1);
    expect(limited.events.map((e) => `${e.event}:${e.id}`)).toEqual(["sent:3", "read:3"]);
    expect(limited.shown).toBe(1);
    expect(limited.elided).toBe(2);
    // Same-second tie: a message read within the second it was sent, and
    // another message sent in that same second. Sent lines come first so
    // a read never precedes the send it refers to.
    const tied = chatTailBacklog(
      [
        row({ id: 1, created_at: "2026-09-12T10:00:00Z", read_at: "2026-09-12T10:00:00Z" }),
        row({ id: 2, created_at: "2026-09-12T10:00:00Z" }),
      ],
      noFilter(),
      null,
    );
    expect(tied.events.map((e) => `${e.event}:${e.id}`)).toEqual(["sent:1", "sent:2", "read:1"]);
  });

  test("filters shrink the feed before the limit applies", () => {
    const filter = { ...noFilter(), matches: [/t/] };
    // "two" and "three" are the only bodies containing "t"; limit 1 keeps
    // the LAST matching row, and the elided count is relative to the
    // filtered feed, not the raw one.
    const { events, elided } = chatTailBacklog(feed(), filter, 1);
    expect(events.map((e) => (e.event === "sent" ? e.body : null))).toEqual(["three"]);
    expect(elided).toBe(1);
  });

  test("state seeds from every feed row, matching or not", () => {
    // A non-matching row is still in the diff state: its filter outcome
    // can flip mid-follow for legacy rows (a rename or unregister changes
    // their rendered names), and it must never resurface as a sent event.
    const { state } = chatTailBacklog(feed(), { ...noFilter(), matches: [/t/] }, null);
    expect([...state.keys()]).toEqual([1, 2, 3, 4, 5]);
  });

  test("a rendered-name flip in follow mode resurfaces no sent events", () => {
    // Only a legacy row (no snapshot) can flip its rendered name: a peer's
    // unregister re-renders its whole history as "unknown
    // (... departed)". Backlog time: the peer is alive and its rows do
    // not match --from unknown, so nothing renders. Poll time: the peer
    // is gone, the same rows now match the filter - and none may re-emit
    // as sent, because the backlog state already knows every id.
    const backlogRows = [
      tailRow({ id: 1, from: "Brute", body: "old one" }),
      tailRow({ id: 2, from: "Brute", body: "old two" }),
    ];
    const { state } = chatTailBacklog(backlogRows, { ...tailNoFilter(), fromSubstr: ["unknown"] }, null);
    expect([...state.keys()]).toEqual([1, 2]);
    const flippedPoll = [
      tailRow({ id: 1, from: "unknown (ses_brute12, departed)", body: "old one" }),
      tailRow({ id: 2, from: "unknown (ses_brute12, departed)", body: "old two" }),
    ];
    const poll = filterChatTailRows(flippedPoll, { ...tailNoFilter(), fromSubstr: ["unknown"] });
    expect(poll.map((r) => r.id)).toEqual([1, 2]);
    expect(chatTailDiff(state, poll).events).toEqual([]);
  });

  test("follow diffs over the seeded state re-emit no sent events", () => {
    const rows = feed();
    const { state } = chatTailBacklog(rows, noFilter(), 2);
    // Re-polling the same feed after every inbox drains must not re-emit
    // the elided history as sent - the limit hid lines, not rows - but
    // read transitions on those rows are news and do fire.
    const events = chatTailDiff(state, rows.map((r) => ({ ...r, read_at: "2026-09-12T11:00:00Z" }))).events;
    expect(events.map((e) => e.event)).toEqual(["read", "read", "read", "read", "read"]);
  });

  test("a new matching row in follow mode emits, a non-matching one does not", () => {
    const { state } = chatTailBacklog(feed(), { ...noFilter(), matches: [/hit/] }, null);
    const poll = filterChatTailRows(
      [row({ id: 9, body: "no match" }), row({ id: 10, body: "direct hit" })],
      { matches: [/hit/], fromSubstr: [], toSubstr: [], sinceMs: null, untilMs: null },
    );
    const events = chatTailDiff(state, poll).events;
    expect(events.map((e) => (e.event === "sent" ? e.body : null))).toEqual(["direct hit"]);
  });
});

describe("chat tail pretty rendering", () => {
  const sent = (over: Partial<Extract<ChatTailEvent, { event: "sent" }>> & { id: number }): Extract<ChatTailEvent, { event: "sent" }> => ({
    event: "sent",
    at: "2026-09-12T10:00:00Z",
    from: "alice",
    from_topic: null,
    to: "bob",
    to_topic: null,
    broadcast: false,
    body: "hello",
    ...over,
  });
  const read = (over: Partial<Extract<ChatTailEvent, { event: "read" }>> & { id: number }): Extract<ChatTailEvent, { event: "read" }> => ({
    event: "read",
    at: "2026-09-12T10:05:00Z",
    reader: "bob",
    reader_topic: null,
    from: "alice",
    from_topic: null,
    ...over,
  });
  const plain = (width = 100) => createChatTailPretty({ width, color: false });

  // The expected Date-field string, built independently of the renderer:
  // the UTC event time shown in the terminal's local zone, "%a %b %d %H:%M".
  const expectedLocal = (at: string): string => {
    const d = new Date(at);
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${day} ${month} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  test("a sent card renders pine-style headers with the topic as subject, no rule before the first card", () => {
    const lines = plain().render(sent({ id: 1, from_topic: "watching CI" }));
    expect(lines).toEqual([
      "     To: bob",
      "   From: alice",
      "Subject: watching CI",
      `   Date: ${expectedLocal("2026-09-12T10:00:00Z")}`,
      "",
      "hello",
      "",
    ]);
  });

  test("a rule separates cards: the second card opens with a full-width rule and blank line", () => {
    const r = plain(40);
    r.render(sent({ id: 1 }));
    const second = r.render(sent({ id: 2, body: "again" }));
    expect(second.slice(0, 3)).toEqual(["\u2500".repeat(40), "", "     To: bob"]);
  });

  test("a broadcast renders the bullhorn in To:, keeping the real recipient in the event only", () => {
    const lines = plain().render(sent({ id: 1, broadcast: true, to: "carol" }));
    expect(lines[0]).toBe("     To: \u{1F4E3}");
  });

  test("the subject falls back to the recipient's topic, then to (no subject)", () => {
    expect(plain().render(sent({ id: 1, from_topic: null, to_topic: "plotting rebase" }))[2]).toBe("Subject: plotting rebase");
    expect(plain().render(sent({ id: 2 }))[2]).toBe("Subject: (no subject)");
  });

  test("a read receipt is a one-line card citing the message's subject and body head", () => {
    const r = plain();
    r.render(sent({ id: 7, from_topic: "watching CI", body: "CI is green\nsecond line" }));
    const lines = r.render(read({ id: 7 }));
    expect(lines).toEqual([
      "\u2500".repeat(100),
      "",
      `${expectedLocal("2026-09-12T10:05:00Z")} bob read alice's message (re watching CI: CI is green)`,
      "",
    ]);
  });

  test("a receipt for a message outside the render window omits the citation", () => {
    const r = plain();
    r.render(sent({ id: 1 }));
    const lines = r.render(read({ id: 404 }));
    expect(lines).toEqual(["\u2500".repeat(100), "", `${expectedLocal("2026-09-12T10:05:00Z")} bob read alice's message`, ""]);
  });

  test("a long receipt subject is clipped with an ellipsis", () => {
    const r = plain();
    r.render(sent({ id: 8, from_topic: "w".repeat(30), body: "hello" }));
    const line = r.render(read({ id: 8 }))[2];
    // 25 cells of clipped subject plus the ellipsis, then the body head.
    expect(line).toBe(`${expectedLocal("2026-09-12T10:05:00Z")} bob read alice's message (re ${"w".repeat(25)}\u2026: hello)`);
  });

  test("color mode wraps labels inverted and values green; the rule is green", () => {
    const r = createChatTailPretty({ width: 40, color: true });
    const lines = r.render(sent({ id: 1, from_topic: "watching CI" }));
    expect(lines[0]).toBe(`     \x1b[102;30mTo:\x1b[0m \x1b[92mbob\x1b[0m`);
    expect(lines[1]).toBe(`   \x1b[102;30mFrom:\x1b[0m \x1b[92malice\x1b[0m`);
    expect(lines[2]).toBe(`\x1b[102;30mSubject:\x1b[0m \x1b[92mwatching CI\x1b[0m`);
    const sep = r.render(sent({ id: 2 }))[0];
    expect(sep).toBe(`\x1b[92m${"\u2500".repeat(40)}\x1b[0m`);
  });

  test("a colored receipt keeps names green inside the bright-black status line", () => {
    const r = createChatTailPretty({ width: 100, color: true });
    r.render(sent({ id: 7, from_topic: "watching CI" }));
    const line = r.render(read({ id: 7 }))[2];
    expect(line.startsWith(`\x1b[90;3m${expectedLocal("2026-09-12T10:05:00Z")} \x1b[0m\x1b[92mbob\x1b[0m\x1b[90;3m read \x1b[0m`)).toBe(true);
  });

  test("plain rendering emits no ANSI anywhere", () => {
    const r = plain();
    const out = [...r.render(sent({ id: 1, body: "**bold** markdown stays as written" })), ...r.render(read({ id: 1 }))].join("\n");
    expect(out.includes("\x1b")).toBe(false);
  });
});

describe("chat tail body wrapping", () => {
  test("long lines wrap to the width; short lines pass through; paragraphs split on newlines", () => {
    const long = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    const lines = wrapChatBody(`short\n${long}`, 20);
    expect(lines[0]).toBe("short");
    expect(lines.slice(1).every((l) => l.length <= 20)).toBe(true);
    expect(lines.slice(1).join(" ")).toBe(long);
  });

  test("a single word longer than the width stays on its own line", () => {
    expect(wrapChatBody("x".repeat(30), 10)).toEqual(["x".repeat(30)]);
  });

  test("the color path italicizes each wrapped line", () => {
    expect(wrapChatBody("hello world", 5, true)).toEqual(["\x1b[3mhello\x1b[0m", "\x1b[3mworld\x1b[0m"]);
  });
});

describe("chat tail markdown body rendering", () => {
  test("with glow installed, markdown bodies render (markup consumed, plain mode emits no ANSI)", () => {
    if (Bun.which("glow") === null) return; // glow is optional; the chain moves on
    const lines = markdownBodyLines("**hold off** on deploys", 100, false);
    expect(lines.join("\n")).toContain("hold off on deploys");
    expect(lines.join("\n").includes("**")).toBe(false);
    expect(lines.join("\n").includes("\x1b")).toBe(false);
  });

  test("with gum installed (and glow absent), gum format takes the middle step", () => {
    const gum = Bun.which("gum");
    if (gum === null) return; // gum is optional; the plain wrap covers the rest
    const lines = createMarkdownBodyRenderer({ glow: null, gum })("**hold off** on deploys", 100, false);
    expect(lines.join("\n")).toContain("hold off on deploys");
    expect(lines.join("\n").includes("**")).toBe(false);
    expect(lines.join("\n").includes("\x1b")).toBe(false);
  });

  test("color mode rides CLICOLOR_FORCE through the non-TTY stdout (gum path)", () => {
    const gum = Bun.which("gum");
    if (gum === null) return;
    const out = createMarkdownBodyRenderer({ glow: null, gum })("**bold** move", 100, true).join("\n");
    // The SGR codes split the words, so assert words and styling apart.
    expect(out.includes("bold")).toBe(true);
    expect(out.includes("move")).toBe(true);
    expect(out.includes("**")).toBe(false);
    expect(out.includes("\x1b[")).toBe(true);
  });

  test("with neither renderer available, the body falls back to the plain word wrap", () => {
    expect(createMarkdownBodyRenderer({ glow: null, gum: null })("wrap me because this line is much longer than ten cells", 10, false)).toEqual(
      wrapChatBody("wrap me because this line is much longer than ten cells", 10, false),
    );
  });
});
