import { describe, test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootStdioJsonRpcClient } from "./helpers/stdio-client";
// Characterization test for the MCP server boot path. No test booted
// runMcpServer as a real subprocess before this one (unit coverage stopped
// at compileTools/compilePrompts/teardown), so this pins the boot and
// dispatch contract - initialize, tools/list, a tool round trip, clean
// exit on stdin close - that the daemon resolver swap
// (docs/plans/embedding-daemon.md, "Precondition: characterization test
// before the swap") had to keep working.
//
// THATCH_EMBED_DAEMON=off pins the LOCAL model path: the resolver must
// never probe, spawn, or connect when the knob is off.

const REPO_ROOT = join(import.meta.dir, "..");

function bootServer(args: string[], env: Record<string, string>) {
  return bootStdioJsonRpcClient([join(REPO_ROOT, "bin", "thatch"), "mcp", ...args], env);
}

function sandboxEnv(sandbox: string): Record<string, string> {
  return {
    THATCH_DB_PATH: join(sandbox, "thatch.db"),
    THATCH_QUEUE_DIR: join(sandbox, "queue"),
    THATCH_MODEL: "mock",
    THATCH_EMBED_DAEMON: "off",
    THATCH_NO_NOTIFY: "1",
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    HOME: join(sandbox, "home"),
    CLAUDE_PROJECT_DIR: join(sandbox, "project"),
    PATH: process.env.PATH ?? "",
  };
}

describe("MCP server boot (characterization)", () => {
  test("boots over stdio, answers initialize, lists tools, dispatches a tool round trip", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "thatch-mcp-boot-"));
    // Bundled mode: no startup behavior seeding (which embeds), no sideband,
    // no auto-refresh - the boot contract under test is mode-independent, and
    // this keeps the test hermetic (no model download).
    const server = bootServer(["--bundled"], sandboxEnv(sandbox));
    try {
      const init = await server.request("initialize", {});
      expect(init.result?.serverInfo?.name).toBe("thatch");

      const list = await server.request("tools/list", {});
      const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(names).toContain("memory_list");

      // A tool round trip on a tool that does not embed: the dispatch path
      // (validation, execute, text content) works end to end.
      const call = await server.request("tools/call", { name: "memory_list", arguments: {} });
      expect(call.result?.isError).toBe(false);
      expect(typeof call.result?.content?.[0]?.text).toBe("string");

      // The pinned "clean exit on stdin close": end the server's stdin and
      // await a zero exit code.
      server.proc.stdin.end();
      expect(await server.proc.exited).toBe(0);
    } finally {
      await server.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60000);

  test("standalone boot embeds locally with the mock model (daemon knob off)", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "thatch-mcp-boot-"));
    // Standalone mode: startup behavior seeding runs, so the boot itself
    // embeds - with the knob off and THATCH_MODEL=mock every embed takes the
    // local mock path, no download, no daemon. The round trip below proves
    // the local embed path end to end through the real server process.
    const server = bootServer([], sandboxEnv(sandbox));
    try {
      await server.request("initialize", {});

      const remember = await server.request("tools/call", {
        name: "memory_remember",
        arguments: { content: "the loader anchors the parser cache", label: "loader-anchors-parser" },
      });
      const rememberText = remember.result?.content?.[0]?.text ?? "";
      expect(remember.result?.isError).toBe(false);
      expect(rememberText).toContain("[saved]");

      const list = await server.request("tools/call", { name: "memory_list", arguments: {} });
      const listText = list.result?.content?.[0]?.text ?? "";
      expect(list.result?.isError).toBe(false);
      expect(listText).toContain("loader-anchors-parser");
    } finally {
      await server.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60000);

  test("boots with a poisoned PATH (a broken bun first on it)", async () => {
    // The hermeticity regression: a shell personalization can put a
    // node:sqlite-less bun FIRST on the ambient PATH, and the spawned
    // shim resolves `bun` by PATH name. The harness pins the child's
    // PATH to the runner's own runtime directory, so the boot must
    // survive the poison; before the fix this test died with "No such
    // built-in module: node:sqlite".
    const sandbox = mkdtempSync(join(tmpdir(), "thatch-mcp-boot-"));
    const brokenBun = join(sandbox, "broken-bun");
    mkdirSync(brokenBun, { recursive: true });
    writeFileSync(join(brokenBun, "bun"), "#!/bin/sh\necho 'Bun v0.0-broken, no node:sqlite' >&2\nexit 1\n");
    chmodSync(join(brokenBun, "bun"), 0o755);
    const env = sandboxEnv(sandbox);
    const server = bootStdioJsonRpcClient(
      [join(REPO_ROOT, "bin", "thatch"), "mcp", "--bundled"],
      // Broken bun FIRST: the poison must lose to the runner's runtime.
      { ...env, PATH: `${brokenBun}:${env.PATH!}` },
    );
    try {
      const init = await server.request("initialize", {});
      expect(init.result?.serverInfo?.name).toBe("thatch");
    } finally {
      await server.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60000);
});
