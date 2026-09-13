import { Database } from "bun:sqlite";
import { registerUseCase, startServe, type QaContext, type ServeHandle, type UseCase } from "../runner";
import { ThatchDB } from "../../../src/db";

/**
 * UC-100: Two-session chat delivery through a live opencode server.
 *
 * The chat poller only delivers to sessions its own process hosts, and an
 * `opencode run` one-shot dies at turn end - so no `opencode run`-based use
 * case can observe a real wake. This use case starts a long-lived
 * `opencode serve` on the fixture and drives two SDK-created sessions over
 * HTTP: the poller in the serve process must wake the recipient session
 * (synthetic nudge part), the recipient's model must read the mail, and a
 * second canary must wake the first session the same way.
 *
 * Automatable: yes - the only model-driven steps are two trivial warmup
 * turns and the recipient's read turn; every send is a deterministic store
 * call from the harness.
 */

/** Poll `fn` every 2s until it returns truthy; throw with `desc` on timeout. */
async function waitFor(desc: string, deadlineMs: number, fn: () => Promise<unknown> | unknown): Promise<void> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`UC-100 timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function listTextParts(client: ServeHandle["client"], sessionID: string): Promise<string[]> {
  const { data } = await client.session.messages({ path: { id: sessionID } });
  const parts = (data ?? []).flatMap((m) => m.parts);
  return parts.filter((p) => p.type === "text").map((p) => p.text);
}

const useCase: UseCase = {
  name: "UC-100-two-session-chat",
  preconditions: [
    "- opencode binary on PATH and VENICE_API_KEY set (the recipient session runs real model turns).",
  ].join("\n"),
  steps: [
    "1. Start `opencode serve` on the fixture; create two sessions (alpha, bravo) via the SDK.",
    "2. Run one trivial turn in each so the plugin's session-status map sees them as hosted.",
    "3. Register both sessions through the real store (registration semantics are UC-097's scope).",
    "4. Send a canary from alpha to bravo through the store; poll chat_messages until delivered_at and read_at are stamped (the poller wakes bravo; bravo's model calls chat_read).",
    "5. Register a third identity (fake MCP session 'charlie') and mail alpha; poll alpha's session log for the wake-nudge text part.",
  ].join("\n"),
  expected: [
    "- The serve process's poller wakes a hosted, idle session within a few poll cycles: the canary row gains delivered_at, then read_at once bravo's model drains the inbox.",
    "- A real session's message log shows the synthetic wake-nudge text part ('[thatch] Chat:') when mail addressed to it arrives from another registration.",
    "- The fake MCP sender identity can send mail through the store (senders only need a directory row), and the recipient is woken by its own host process.",
  ].join("\n"),

  async run(ctx: QaContext) {
    const handle = await startServe(ctx);
    try {
      const client = handle.client;

      // Step 1: two independent sessions, both hosted by the serve process.
      const sA = (await client.session.create({ body: { title: "uc-100 alpha" } })).data?.id;
      const sB = (await client.session.create({ body: { title: "uc-100 bravo" } })).data?.id;
      if (!sA || !sB) {
        console.log("  FAIL: session.create returned no id");
        return "FAIL";
      }

      // Step 2: the poller's hosted set is built from session-status
      // events, which only flow after a session has run a turn. One
      // trivial turn each makes both deliverable.
      await client.session.prompt({ path: { id: sA }, body: { parts: [{ type: "text", text: "Reply with exactly: ok" }] } });
      await client.session.prompt({ path: { id: sB }, body: { parts: [{ type: "text", text: "Reply with exactly: ok" }] } });

      // Step 3: register through the real store. The project column is
      // null here - the poller selects by hosted session IDs, so project
      // scoping only affects the CLI/hook surfaces (UC-099's scope).
      const db = new ThatchDB(ctx.env.THATCH_DB_PATH);
      const regA = db.registerChatSession(sA, "alpha", null, null, "opencode");
      const regB = db.registerChatSession(sB, "bravo", null, null, "opencode");
      if (!regA.ok || !regB.ok) {
        console.log(`  FAIL: registration failed - ${(!regA.ok && regA.error) || (!regB.ok && regB.error)}`);
        return "FAIL";
      }

      // Step 4: canary alpha -> bravo through the real store, then poll
      // for the delivery stamp (poller wake) and the read stamp (bravo's
      // model turn calling chat_read).
      const canary = "UC-100 canary message. Acknowledge by calling chat_read, then reply to alpha with the single word ack.";
      const sent = db.sendChatMessage(sA, "bravo", canary);
      if (!sent.ok) {
        console.log(`  FAIL: send failed - ${sent.error}`);
        return "FAIL";
      }

      const sqlite = new Database(ctx.env.THATCH_DB_PATH, { readonly: true });
      // send() returns the resolved recipient, not the row id; look the
      // row up by body (unique canary text).
      const rowFor = (body: string) => () =>
        sqlite.query("SELECT delivered_at, read_at FROM chat_messages WHERE body = ?").get(body) as
          | { delivered_at: string | null; read_at: string | null }
          | null;

      await waitFor("canary delivered to bravo (delivered_at stamped)", 120_000, () => rowFor(canary)()?.delivered_at);
      await waitFor("bravo read the canary (read_at stamped)", 240_000, () => rowFor(canary)()?.read_at);
      console.log("  canary delivered and read by bravo");

      // Step 5: deterministic second wake - a fake MCP identity mails
      // alpha; the poller must wake the real alpha session (promptAsync
      // synthetic part), independent of any model decision.
      db.registerChatSession("uc100-charlie", "charlie", null, null, "mcp");
      const mail2 = "UC-100 second canary for alpha.";
      const sent2 = db.sendChatMessage("uc100-charlie", "alpha", mail2);
      if (!sent2.ok) {
        console.log(`  FAIL: second send failed - ${sent2.error}`);
        return "FAIL";
      }
      await waitFor(
        "alpha woken by charlie's mail (nudge text part in alpha's session log)",
        240_000,
        async () => (await listTextParts(client, sA)).some((t) => t.includes("[thatch] Chat:")),
      );
      console.log("  alpha woken by the poller (nudge part present)");
      return "PASS";
    } finally {
      handle.stop();
    }
  },
};

registerUseCase(useCase);
