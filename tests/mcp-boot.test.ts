import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Characterization test for the MCP server boot path. No test booted
// runMcpServer as a real subprocess before this one (unit coverage stopped
// at compileTools/compilePrompts/teardown), so this pins the boot and
// dispatch contract - initialize, tools/list, a tool round trip, clean
// exit on stdin close - BEFORE the embedding-model construction site
// becomes the daemon resolver (docs/plans/embedding-daemon.md,
// "Precondition: characterization test before the swap").
//
// THATCH_EMBED_DAEMON=off pins the LOCAL model path: the resolver must
// never probe, spawn, or connect when the knob is off.

const REPO_ROOT = join(import.meta.dir, "..");

interface SpawnedServer {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
  close: () => void;
}

function bootServer(args: string[], env: Record<string, string>): SpawnedServer {
  const proc = Bun.spawn([join(REPO_ROOT, "bin", "thatch"), "mcp", ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idSeq = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const id = idSeq++;
    proc.stdin.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    proc.stdin.flush();
    const poll = async (): Promise<Record<string, any>> => {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server closed before answering ${method} (id ${id})`);
      buf += dec.decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
      }
      return poll();
    };
    return poll();
  };
  return {
    proc,
    request,
    close: () => {
      reader.cancel().catch(() => {});
      proc.kill();
    },
  };
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
    } finally {
      server.close();
      await server.proc.exited;
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
      server.close();
      await server.proc.exited;
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60000);
});
