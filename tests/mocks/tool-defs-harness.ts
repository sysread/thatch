/**
 * Shared per-test fixtures for the tool-defs test parts (the former
 * tests/tool-defs.test.ts, split by topic): a scratch ThatchDB on a
 * per-test tempdir, the mock embedding model, and the CoreContext that
 * tool execute functions take. The parts import the fixture bindings
 * from here instead of rebuilding them per file.
 *
 * Call setupToolDefsHarness() ONCE at the top level of each test file
 * that needs the fixtures. The call registers the beforeEach/afterEach
 * pair in the CALLING file's root suite: bun evaluates a helper module
 * once per process run, so hooks at this module's top level would only
 * ever attach to the first test file that imports it (the rest would
 * silently run against the previous file's closed DB). The exported
 * fixture bindings are live: every test sees the state its own
 * beforeEach created.
 */

import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThatchDB } from "../../src/db";
import { MockEmbeddingModel } from "./embeddings";
import type { CoreContext } from "../../src/tool-defs";

export let dbPath: string;
let dbDir: string;
export let db: ThatchDB;
export let model: MockEmbeddingModel;
export let ctx: CoreContext;
export const defaultStore = "test-owner/test-repo";

// Open-tab fixture for the roster/chat_send surfaces. null = "every
// registered session has a tab" (preserves the open-class pins); a test
// replaces it with an explicit set to exercise the open/recent split.
// The variable lives in this module so the ctx.openTabs closure below
// reads the value a test set; imported bindings are read-only, so test
// files assign it through setOpenTabsFixture instead of directly.
let openTabsFixture: ReadonlySet<string> | null;

export function setOpenTabsFixture(fixture: ReadonlySet<string> | null) {
  openTabsFixture = fixture;
}

export function setupToolDefsHarness(): void {
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "thatch-mcp-test-"));
    dbPath = join(dbDir, "test.db");
    db = new ThatchDB(dbPath);
    model = new MockEmbeddingModel();
    openTabsFixture = null;
    ctx = { db, model, defaultStore, openTabs: () => openTabsFixture ?? new Set(db.listChatSessions().map((r) => r.session_id)) };
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });
}
