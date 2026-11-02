import { registerUseCase, type UseCase, type QaContext } from "../runner";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../../../src/db";
import { MockEmbeddingModel } from "../../../tests/mocks/embeddings";
import { TOOL_DEFS, type CoreContext } from "../../../src/tool-defs";
import { compileTools } from "../../../src/mcp";
import { saveConfig } from "../../../src/config";

/**
 * UC-129: fuzzy "Did you mean" suggestions on tool error paths.
 *
 * Automatable: the suggestion layer is pure functions (src/fuzzy.ts) plus
 * tool-level wiring. A typo'd memory label ("Pull Request Sumary") should
 * name the close label; a garbage label must get NO suggestion (git-strict:
 * never a fallback guess); a typo'd parameter name ("labels") that survives
 * the deep-passthrough host validation should be named to the caller; a
 * typo'd config_set section or field must be rejected with a suggestion
 * and write nothing.
 */

const useCase: UseCase = {
  name: "UC-129-fuzzy-did-you-mean",
  preconditions: [
    "- No prerequisites beyond the source tree; memory, chat, and config all run on a temp-dir database.",
  ].join("\n"),
  steps: [
    '1. Save a memory labeled "Pull Request Summary", then call `memory_show` with the near-miss label "Pull Request Sumary".',
    '2. Call `memory_show` with the garbage label "zzz qqq completely unrelated" and confirm no suggestion line appears.',
    '3. Call `memory_remember` with args `{ labels: "Some Label", cotnent: "body" }` delivered through the real compiled validator (both keys typo\'d).',
    '4. Register two sessions, then call `chat_send` with a one-character typo of the peer\'s name.',
    '5. Call `config_set` with the typo\'d section `{ notifcations: { mode: "voice" } }` (raw args: unknown keys reach execute) and confirm the config file is byte-identical afterwards.',
    '6. Call `config_set` with the typo\'d field `{ chat: { enabld: false } }` (raw args, the production v2 shape) and confirm the config file is byte-identical afterwards.',
  ].join("\n"),
  expected: [
    "- Step 1: the reply should name the close label: `Did you mean \"Pull Request Summary\"?`.",
    "- Step 2: the miss has no `Did you mean` line at all.",
    "- Step 3: the reply should name the misnamed content key: `You passed 'cotnent'; did you mean 'content'?`; nothing is saved. (The label key is not saved under a derived label here - the content guard fires first, so no [note] appears.)",
    "- Step 4: the send fails with `No registered session named` plus a `Did you mean` line naming the peer.",
    "- Step 5: the call errors naming the unknown section with a suggestion for 'notifications', and the config file is unchanged.",
    "- Step 6: the call errors naming the unknown chat field with a suggestion for 'enabled', and the config file is unchanged.",
  ].join("\n"),

  async run(_ctx: QaContext) {
    const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;
    const dbDir = mkdtempSync(join(tmpdir(), "thatch-uc129-"));
    const db = new ThatchDB(join(dbDir, "uc129.db"));
    try {
      const coreCtx: CoreContext = { db, model: new MockEmbeddingModel(), defaultStore: "uc129-test" };

      // Step 1: near-miss label -> suggestion.
      await findTool("memory_remember").execute({ label: "Pull Request Summary", content: "body" }, coreCtx);
      const r1 = await findTool("memory_show").execute({ label: "Pull Request Sumary" }, coreCtx);
      if (!r1.includes('Did you mean "Pull Request Summary"?')) {
        console.log(`  FAIL: step 1 should suggest the near-miss label, got: ${r1}`);
        return "FAIL";
      }

      // Step 2: garbage label -> no suggestion line.
      const r2 = await findTool("memory_show").execute({ label: "zzz qqq completely unrelated" }, coreCtx);
      if (!r2.includes("No memory") || r2.includes("Did you mean")) {
        console.log(`  FAIL: step 2 should stay silent for a garbage label, got: ${r2}`);
        return "FAIL";
      }

      // Step 3: near-miss param keys reach the guards through the real
      // compiled validator (the production delivery shape).
      const entriesBeforeStep3 = db.listEntries("uc129-test").length;
      const remember = findTool("memory_remember");
      const compiled = compileTools();
      const parsed = compiled.get("memory_remember")!.validator({ labels: "Some Label", cotnent: "body" });
      const r3 = await remember.execute(parsed, coreCtx);
      if (!r3.includes("You passed 'cotnent'; did you mean 'content'?")) {
        console.log(`  FAIL: step 3 should name the misnamed content key, got: ${r3}`);
        return "FAIL";
      }
      if (db.listEntries("uc129-test").length !== entriesBeforeStep3) {
        console.log("  FAIL: step 3 must not save anything");
        return "FAIL";
      }

      // Step 4: chat_send near-name typo -> suggestion.
      const host = { sessionID: "ses_uc129", agent: "build" };
      await findTool("chat_register").execute({}, coreCtx, host);
      const peer = await findTool("chat_register").execute({}, coreCtx, { sessionID: "ses_uc129_peer", agent: "build" });
      const peerName = (String(peer).match(/\[registered\] (.+)/) ?? [])[1]!;
      const r4 = await findTool("chat_send").execute({ to: peerName.slice(0, -1), body: "hi" }, coreCtx, host);
      if (!r4.includes("No registered session named") || !r4.includes("Did you mean")) {
        console.log(`  FAIL: step 4 should suggest the near-miss recipient, got: ${r4}`);
        return "FAIL";
      }

      // Step 5: config_set typo'd section -> error + suggestion + no write.
      const dbPath = join(dbDir, "uc129.db");
      saveConfig({ notifications: { mode: "banner" } }, dbPath);
      const before = readFileSync(join(dbDir, "config.json"), "utf8");
      const r5 = await findTool("config_set").execute(
        { notifcations: { mode: "voice" } } as Record<string, unknown>,
        coreCtx,
      );
      if (!r5.includes("Unknown config_set section 'notifcations'") || !r5.includes('Did you mean "notifications"?')) {
        console.log(`  FAIL: step 5 should reject the typo'd section with a suggestion, got: ${r5}`);
        return "FAIL";
      }
      if (!existsSync(join(dbDir, "config.json")) || readFileSync(join(dbDir, "config.json"), "utf8") !== before) {
        console.log("  FAIL: step 5 must not touch the config file");
        return "FAIL";
      }

      // Step 6: config_set typo'd FIELD -> error + suggestion + no write.
      const r6 = await findTool("config_set").execute(
        { chat: { enabld: false } } as Record<string, unknown>,
        coreCtx,
      );
      if (!r6.includes("Unknown chat field 'enabld'") || !r6.includes('Did you mean "enabled"?')) {
        console.log(`  FAIL: step 6 should reject the typo'd field with a suggestion, got: ${r6}`);
        return "FAIL";
      }
      if (readFileSync(join(dbDir, "config.json"), "utf8") !== before) {
        console.log("  FAIL: step 6 must not touch the config file");
        return "FAIL";
      }

      return "PASS";
    } finally {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
};

registerUseCase(useCase);
