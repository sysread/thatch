import { beforeAll, afterAll } from "bun:test";
import { checkEnv, printCleanupNotice } from "./runner";

/**
 * QA use-case suite entry point. Individual use case files in tests/qa/
 * import registerUseCase from ./runner and register themselves at module
 * load. This file handles global setup and teardown.
 *
 * Run with: mise run qa
 * Dry run:  mise run qa-dry-run
 *
 * Requires VENICE_API_KEY in the environment.
 */

beforeAll(() => {
  checkEnv();
});

afterAll(() => {
  printCleanupNotice();
});

// Importing the use case files triggers their registerUseCase calls.
// Bun discovers all *.test.ts files in tests/qa/ automatically.
