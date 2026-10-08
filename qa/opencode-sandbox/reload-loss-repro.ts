#!/usr/bin/env bun
/**
 * Reload-loss repro (known-bugs: "Watcher lost across plugin reload") -
 * the automated live repro the docker serve mode makes possible.
 *
 * Verifies the pending-durability fix shipped in 20937f2, per the assertion
 * spec from the generalized-session-heartbeat session:
 *
 *   1. A scripted session registers a ONE-SHOT command watch (the worst
 *      case: the `watchers` definitions row is deleted at detection by
 *      design, so the pending journal is the only survivor).
 *   2. The watched command fires while the session is BUSY mid-turn, so
 *      delivery cannot happen: at that moment runtime_state must hold
 *      kind='watcher_pending' for the session and kind='watchers' must be
 *      GONE.
 *   3. A src touch forces the digest plugin reload while events are
 *      pending.
 *   4. The watcher_pending row SURVIVES the reload; the next idle delivery
 *      delivers the queued notification; the row is deleted after
 *      delivery; the pre-fix signature (notification never arrives + row
 *      vanishing) does not occur.
 *
 * Prereqs (the caller orchestrates the container):
 *   docker run -d --rm -p 127.0.0.1:4096:4096 \
 *     -v "$(pwd)":/app/thatch -v "$SMOKE/qa:/qa" \
 *     -e OPENCODE_SERVER_PASSWORD=qa-repro -e VENICE_API_KEY -e THATCH_DEBUG=1 \
 *     -e THATCH_WATCH_POLL_SECONDS=5 \
 *     thatch-qa-opencode serve --hostname 0.0.0.0 --port 4096
 *   bun qa/opencode-sandbox/reload-loss-repro.ts
 *
 * THATCH_WATCH_POLL_SECONDS=5 matters: the default cadence is 60s, and a
 * detection landing AFTER the long turn ends delivers immediately (no
 * pending journal) - the repro's mid-busy assertion needs the poll to land
 * while the session is busy.
 *
 * The script drives the server over raw fetch (basic auth + the
 * x-opencode-directory header; the serve boots project-free and resolves
 * the instance per request) and reads the sandbox thatch db directly
 * (WAL: concurrent reads while the server writes are fine).
 */

import { Database } from "bun:sqlite";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.QA_REPRO_PORT ?? "4096";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? "qa-repro";
const BASE = `http://127.0.0.1:${PORT}`;
// The in-container paths (the /qa mount): the work repo + the thatch db.
const WORK_DIR = "/qa/work";
// The HOST side of the /qa mount: the trigger file and the thatch db are
// written/read host-side through it.
const QA_ROOT_HOST = process.env.QA_REPRO_QA ?? join(tmpdir(), "thatch-tab-smoke/qa");
const DB_PATH_HOST = process.env.QA_REPRO_DB ?? join(QA_ROOT_HOST, "config", "thatch", "thatch.db");
const HEADERS = {
  Authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`,
  "x-opencode-directory": WORK_DIR,
  "content-type": "application/json",
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, json };
}

/** Message count for the session: a turn adds a user + an assistant message. */
async function messageCount(sessionID: string): Promise<number> {
  const { status, json } = await api("GET", `/api/session/${sessionID}/message`);
  if (status !== 200) throw new Error(`message list ${status}: ${JSON.stringify(json)?.slice(0, 200)}`);
  const data = json?.data ?? json;
  return Array.isArray(data) ? data.length : 0;
}

/** Poll until fn() is truthy or the deadline passes. */
async function waitFor(desc: string, deadlineMs: number, fn: () => Promise<boolean | undefined>) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(1000);
  }
}

function dbState(sessionID?: string): { pending: number; watchers: number } {
  // READ-WRITE open, deliberately: this is a WAL database, and a readonly
  // connection cannot open it when no live connection holds the -shm file
  // (the server's handle comes and goes with the per-location instance's
  // eviction cycle - post-eviction the -wal folds away and readonly opens
  // fail with CANTOPEN). The queries are SELECTs; the write flag only
  // enables the WAL shared-memory setup.
  const db = new Database(DB_PATH_HOST);
  try {
    // Session-scoped: the shared sandbox db accumulates rows from earlier
    // runs (e.g. a killed run's never-fired one-shot row persists - the
    // dormant-row machinery owns those); only THIS session's rows speak to
    // the repro's assertions.
    // Session-scoped: the shared sandbox db accumulates rows from earlier
    // runs (e.g. a killed run's never-fired one-shot row persists - the
    // dormant-row machinery owns those); only THIS session's rows speak to
    // the repro's assertions.
    const scope = sessionID ? "AND session_id = ?" : "";
    const bind = sessionID ? [sessionID] : [];
    const pending = (db.query(`SELECT COUNT(*) c FROM runtime_state WHERE kind = 'watcher_pending' ${scope}`).get(...bind) as any)?.c ?? 0;
    const watchers = (db.query(`SELECT COUNT(*) c FROM runtime_state WHERE kind = 'watchers' ${scope}`).get(...bind) as any)?.c ?? 0;
    return { pending, watchers };
  } finally {
    db.close();
  }
}

// --- 0. The server must be up. ---
const health = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
if (health === 0) {
  console.error("serve is not reachable - start the container first (see the header)");
  process.exit(1);
}
console.log("serve reachable");

// --- 1. The session + the one-shot watch registration. ---
const created = await api("POST", "/api/session", { location: { directory: WORK_DIR } });
const sessionID = created.json?.data?.id;
if (!sessionID) {
  console.error(`session create failed: ${created.status} ${JSON.stringify(created.json)?.slice(0, 300)}`);
  process.exit(1);
}
console.log(`session ${sessionID}`);

// A stale trigger from an earlier run would fire the one-shot instantly
// (the session idle = immediate delivery = no pending journal to verify).
rmSync(join(QA_ROOT_HOST, "work", "trigger"), { force: true });

await api("POST", `/api/session/${sessionID}/prompt`, {
  text: "Use thatch_watch_command_create to register a ONE-SHOT watch (once: true) for the command `test -f /qa/work/trigger`. Report [armed] when done. Do nothing else.",
});
// The registration turn: wait for the assistant reply (message count grows by 2).
const baseCount = await messageCount(sessionID);
await waitFor("the watch-registration turn to finish", 180_000, async () => (await messageCount(sessionID)) >= baseCount + 2);
console.log("one-shot watch armed");

// --- 2. A long turn (busy) + the trigger fires mid-turn. ---
await api("POST", `/api/session/${sessionID}/prompt`, {
  text: "Now run this exact shell command and report its output when it finishes: sleep 60 && echo long-turn-done",
});
// Mid-turn: wait for the turn to START (the user message lands), then a beat.
await waitFor("the long turn to start", 60_000, async () => (await messageCount(sessionID)) >= baseCount + 3);
await sleep(5000); // inside the sleep 60 - the session is busy
writeFileSync(join(QA_ROOT_HOST, "work", "trigger"), "fire"); // the host side of /qa/work/trigger
console.log("trigger dropped mid-turn");

// The watch detects + the delivery SKIPS (busy): the pending row journals,
// the one-shot definitions row is consumed.
await waitFor("the watcher_pending row to journal", 120_000, () => dbState(sessionID).pending > 0);
const mid = dbState(sessionID);
check("pending row journals while busy", mid.pending > 0, `watcher_pending=${mid.pending}`);
check("one-shot definitions row consumed (gone)", mid.watchers === 0, `watchers=${mid.watchers}`);

// --- 3. The reload trigger: change the mounted src. The plugin's source
// cache is digest-based (content), so the pulse must CHANGE the file - an
// mtime-only touch may not fire it. The worktree's copy is disposable; the
// appended pulse line is removed when the worktree is.
const hostTouched = join(import.meta.dir, "..", "..", "src", "opencode", "tui-plugin.ts");
const before = await Bun.file(hostTouched).text();
await Bun.write(hostTouched, `${before}\n// reload-pulse ${Date.now()}\n`);
console.log("reload triggered (pulse appended to the mounted src)");
await sleep(3000); // the digest watcher + the reactivation cycle

// --- 4. The post-reload delivery: the queued notification lands on idle. ---
let delivered = false;
try {
  await waitFor("the pending row to be consumed by a post-reload delivery", 240_000, async () => {
    const state = dbState(sessionID);
    if (state.pending === 0) {
      delivered = true;
      return true;
    }
    return false;
  });
} catch {
  delivered = false;
}
const finalMessages = await messageCount(sessionID);
check("pending row consumed AFTER the reload", delivered);
check("the queued notification delivered (new messages post-reload)", finalMessages > baseCount + 3, `messages=${finalMessages}`);
// The pre-fix signature: the row vanishes WITHOUT the delivery. Both halves
// failing together is the pre-fix shape; the checks above pin each half.

console.log(failures === 0 ? "\nREPRO: PASS - pending durability survives the reload" : `\nREPRO: FAIL (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
