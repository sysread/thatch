import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../tests/mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";

/** Seeds one inbox row for the given recipient through a second connection. */
function seedMail(dbDir: string, toSession: string, body: string): void {
  const raw = new Database(join(dbDir, "uc117.db"));
  try {
    raw.run("INSERT INTO chat_messages (from_session, to_session, body) VALUES (?, ?, ?)", [
      "ses_seeder",
      toSession,
      body,
    ]);
  } finally {
    raw.close();
  }
}

/**
 * UC-117: the chat `as` identity fallback is directory-bound.
 *
 * Automatable: yes - the chat tools execute against a temp-dir SQLite
 * database with no host process. Without binding, any MCP conversation
 * that knew a session's display name could read its mail (the retired
 * docs/plans known-bugs snapshot, "Chat on Cursor", kept in git history).
 * The fallback now accepts only same-project claims;
 * a refused claim teaches re-registration, which doubles as the Cursor
 * escape hatch when the server's project resolution is wrong.
 */

const useCase: UseCase = {
  name: "UC-117-chat-identity-directory-binding",
  preconditions: [
    "- No prerequisites beyond the source tree; the chat store runs on a temp-dir database.",
  ].join("\n"),
  steps: [
    "1. Register an identity in project alpha through chat_register (MCP path, no host context).",
    "2. From a project-beta context, pass `as` with the alpha identity's name: confirm refusal naming both projects.",
    "3. From a project-alpha context, pass `as` with the same name: confirm it resolves.",
    "4. chat_register with the cross-project `as`: confirm a fresh identity is registered instead of an 'already registered' confirmation.",
    "5. Before any mail is read, chat_status names no last-read message; after chat_read drains, chat_status reports the newest read message (id, sender, read time).",
  ].join("\n"),
  expected: [
    "- Cross-project `as` claims are refused with an error naming both projects and teaching re-registration.",
    "- Same-project `as` claims resolve as before.",
    "- A cross-project chat_register claim registers a fresh identity instead of confirming the existing one (no row leak).",
    "- chat_status's last-read line appears only after mail was read, and names the newest read message's id, sender, and read time.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const host = { sessionID: "ses_uc117", agent: "build" };

    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc117-"));
    const db = new ThatchDB(join(dbDir, "uc117.db"));
    try {
      const alpha: CoreContext = {
        db,
        model: new MockEmbeddingModel(),
        defaultStore: "acme/alpha",
      };
      const beta: CoreContext = {
        db,
        model: new MockEmbeddingModel(),
        defaultStore: "acme/beta",
      };

      // Step 1: an alpha identity exists.
      const registered = (await findTool("chat_register").execute({}, alpha, host)) as string;
      const alphaName = (registered.match(/\[registered\] (.+)/) ?? [])[1];
      if (!alphaName) {
        console.log(`  FAIL: could not read the registered name: ${registered}`);
        return "FAIL";
      }

      // Step 2: a beta caller claiming the alpha identity is refused.
      const refused = (await findTool("chat_status").execute({ as: alphaName }, beta, undefined)) as string;
      if (!refused.includes("registered to another project") || !refused.includes("acme/alpha") || !refused.includes("acme/beta")) {
        console.log(`  FAIL: cross-project claim should be refused naming both projects: ${refused}`);
        return "FAIL";
      }

      // Step 3: the same claim from alpha resolves.
      const ok = (await findTool("chat_status").execute({ as: alphaName }, alpha, undefined)) as string;
      if (!ok.includes("[chat] registered as") || ok.includes("another project")) {
        console.log(`  FAIL: same-project claim should resolve: ${ok}`);
        return "FAIL";
      }

      // Step 4: the reclaim path neither leaks nor confirms cross project.
      // No host context: the reclaim path is MCP-only (`as` is ignored on
      // opencode, where the host supplies identity).
      const fresh = (await findTool("chat_register").execute({ as: alphaName }, beta, undefined)) as string;
      if (!fresh.includes("belongs to another project") || !fresh.includes("[registered]")) {
        console.log(`  FAIL: cross-project register should mint a fresh identity: ${fresh}`);
        return "FAIL";
      }
      if (fresh.includes("You were already registered")) {
        console.log("  FAIL: cross-project register confirmed the claimed row (leak)");
        return "FAIL";
      }

      // Step 5: chat_status read-state. Mail is seeded directly in the DB
      // (the feature under probe is the status read-out, not the send
      // path); the alpha identity is bound to the ses_uc117 host session.
      const statusTool = findTool("chat_status");
      const beforeRead = (await statusTool.execute({}, alpha, host)) as string;
      if (beforeRead.includes("Last message read")) {
        console.log(`  FAIL: last-read line present with no read mail: ${beforeRead}`);
        return "FAIL";
      }
      seedMail(dbDir, host.sessionID, "read-state probe");
      await findTool("chat_read").execute({}, alpha, host);
      const afterRead = (await statusTool.execute({}, alpha, host)) as string;
      if (!afterRead.includes("Last message read: #") || !afterRead.includes("at ")) {
        console.log(`  FAIL: last-read line missing after a drain: ${afterRead}`);
        return "FAIL";
      }
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }

    return "PASS";
  },
};

registerUseCase(useCase);
