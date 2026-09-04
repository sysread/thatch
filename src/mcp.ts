import { resolve } from "node:path";
import { z } from "zod";
import { ThatchDB } from "./db";
import { BgeEmbeddingModel } from "./embeddings";
import { detectRepo } from "./git";
import { checkSetup, setupClaudeCode, setupCursor } from "./setup";
import { TOOL_DEFS, type CoreContext, type ToolDef } from "./tool-defs";
import { SidebandServer, sidebandSocketPath } from "./sideband";
import { peekQueue, consumeQueue, resetMissedCount } from "./extract-queue";
import { buildExtractionPayload } from "./extraction";
import { seedDefaultBehaviors } from "./seed-behaviors";
import { writeVersionFile, removeVersionFile, startVersionChecker, stopVersionChecker, getVersionChecker } from "./version-check";
import pkg from "../package.json";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// MCP protocol constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "thatch";
const SERVER_VERSION = pkg.version;

/**
 * MCP capabilities declared in the initialize response. Thatch is a tools-only
 * server - no resources, prompts, or subscriptions.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
};

// ---------------------------------------------------------------------------
// Tool index - builds validators and JSON Schema once at server startup
// ---------------------------------------------------------------------------

interface CompiledTool {
  def: ToolDef;
  validator: (input: unknown) => Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

export function compileTools(): Map<string, CompiledTool> {
  const map = new Map<string, CompiledTool>();
  for (const def of TOOL_DEFS) {
    // opencode-only tools depend on host capabilities MCP servers don't
    // have (e.g. session identity via HostToolContext) - never expose them.
    if (def.opencodeOnly) continue;
    const schema = z.object(def.args);
    map.set(def.name, {
      def,
      validator: (input: unknown) => schema.parse(input) as Record<string, unknown>,
      inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

/**
 * Runs the thatch MCP server over stdio. Reads newline-delimited JSON-RPC from
 * stdin, writes responses to stdout. All diagnostics go to stderr - any stray
 * output on stdout corrupts the protocol.
 *
 * Repo identity is resolved from CLAUDE_PROJECT_DIR (set by Claude Code for
 * stdio servers) or the current working directory as a fallback. The embedding
 * model loads lazily on the first tool call that needs it, so the server
 * starts instantly and only pays the ~34 MB download cost when a memory is
 * actually written or recalled.
 *
 * A Unix domain socket sideband is opened at startup so that one-shot hook
 * processes (thatch flush-tools) can ask the warm MCP server to embed a
 * prompt and search for matches without loading the model themselves.
 */
export async function runMcpServer(): Promise<void> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const repo = await detectRepo(projectDir);

  const home = process.env.HOME ?? "/tmp";
  const configHome = process.env.XDG_CONFIG_HOME ?? `${home}/.config`;
  const dbPath = process.env.THATCH_DB_PATH ?? `${configHome}/thatch/thatch.db`;
  const modelName = process.env.THATCH_MODEL ?? "Xenova/bge-small-en-v1.5";

  const db = new ThatchDB(dbPath);
  const model = new BgeEmbeddingModel(modelName);

  await seedDefaultBehaviors(db, model);

  // Extraction payload provider: peeks the file-backed queue and returns the
  // serialized JSON payload. Called by the get_extraction_payload tool when a
  // sub-agent needs to fetch the parent's queued interactions. Returns null
  // when no interactions are queued.
  const extractionPayloadProvider = (sessionID: string): string | null => {
    const interactions = peekQueue(sessionID);
    if (interactions.length === 0) return null;
    return buildExtractionPayload(interactions, repo);
  };

  // Drain a session's file-backed queue and reset its missed-nudge counter.
  // Called by extraction_done when a sub-agent passes the parent's session_id.
  // Without this, the MCP path's appendBatch self-detection would drain the
  // sub-agent's (empty) queue instead of the parent's.
  const drainExtractionQueue = (sessionID: string): void => {
    resetMissedCount(sessionID);
    consumeQueue(sessionID);
  };

  const ctx: CoreContext = {
    db,
    model,
    defaultStore: repo,
    extractionPayloadProvider,
    drainExtractionQueue,
  };
  const tools = compileTools();

  // Check whether `thatch setup` was run for the current host. If not, or if
  // markers are broken, surface a warning on the first tools/call response so
  // the agent can tell the user to run setup. Also emit to stderr for
  // visibility in host debug logs.
  let setupWarning: string | null = null;
  const setupStatus = checkSetup(projectDir);
  if (setupStatus && setupStatus.status !== "installed") {
    setupWarning = setupStatus.message;
    console.error(`[thatch] ${setupWarning}`);
  }

  // Version warning: surfaced once on the first tools/call response. The
  // primary delivery channel is flush-tools (fires on every prompt), so this
  // is a backup. Combines npm update-available and version-skew warnings.
  let versionWarning: string | null = null;
  const checker = getVersionChecker();
  if (checker) {
    const updateMsg = checker.getUpdateWarning();
    if (updateMsg) {
      versionWarning = updateMsg;
      console.error(`[thatch] ${updateMsg}`);
    }
  }

  // Auto-refresh: if setup was previously run (markers exist), re-run the
  // install functions to update skills, instructions, and hooks that may have
  // drifted since the last `thatch setup`. All operations are idempotent --
  // they only write when content differs. This keeps MCP-host installations
  // up to date without requiring the user to manually re-run setup after
  // upgrading thatch. The MCP config itself is also re-written, but it
  // writes the same command that's already running, so it's a no-op in
  // practice.
  if (setupStatus && setupStatus.status === "installed") {
    const thatchBin = resolve(process.argv[1] ?? process.execPath);
    const isGlobal = setupStatus.scope === "global";
    try {
      if (setupStatus.host === "claude") {
        setupClaudeCode(thatchBin, isGlobal, projectDir);
      } else if (setupStatus.host === "cursor") {
        setupCursor(thatchBin, isGlobal, projectDir);
      }
    } catch (err) {
      // Auto-refresh is best-effort. A failure here does not affect the
      // MCP server's ability to serve tool calls -- it just means skills
      // or instructions may be stale until the user re-runs setup.
      console.error(`[thatch] auto-refresh of skills/instructions failed: ${err}`);
    }
  }

  // The sideband socket lets one-shot hook processes (flush-tools) ask the
  // warm MCP server to embed a prompt and search for matches - without
  // loading the ~34 MB model themselves. If the socket can't be opened
  // (permissions, tmpdir issues), the MCP server still works; only the
  // prompt-aware recall nudge degrades.
  const sockPath = sidebandSocketPath(dbPath);
  const sideband = new SidebandServer(sockPath, model, db);
  try {
    sideband.start();
  } catch (err) {
    console.error(`[thatch] sideband socket failed: ${err}`);
  }

  // Stamp the running version so hook processes (flush-tools) can detect
  // version skew after an upgrade. The hook reads this file on every
  // UserPromptSubmit and compares it to its own package.json version.
  writeVersionFile(dbPath);

  // Start background npm update polling. The checker caches the latest
  // version to a file so hook processes can read it without making network
  // requests. Never blocks tool calls.
  startVersionChecker(dbPath);

  // Read stdin line by line. Each line is a complete JSON-RPC message.
  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk as unknown as ArrayBuffer);

    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
        continue;
      }

      // Notifications (no id) are fire-and-forget - no response expected.
      const isNotification = req.id === null || req.id === undefined;
      const res = await dispatch(req, tools, ctx);
      if (res === null || isNotification) continue;

      // Surface the setup warning on the first tools/call response so the
      // agent sees it and can notify the user. Cleared after one surfacing.
      if (setupWarning && req.method === "tools/call" && !res.error) {
        const content = res.result?.content;
        if (Array.isArray(content) && content[0]?.text != null) {
          content[0].text = `[thatch] ${setupWarning}\n\n${content[0].text}`;
        }
        setupWarning = null;
      }

      // Surface the version warning once per session on the first tools/call.
      // The primary delivery channel is flush-tools (fires on every prompt),
      // so this is a backup for when hooks are missing or fail. Cleared after
      // one surfacing.
      if (versionWarning && req.method === "tools/call" && !res.error) {
        const content = res.result?.content;
        if (Array.isArray(content) && content[0]?.text != null) {
          content[0].text = `[thatch] ${versionWarning}\n\n${content[0].text}`;
        }
        versionWarning = null;
      }

      send(res);
    }
  }

  sideband.stop();
  stopVersionChecker();
  removeVersionFile(dbPath);
  db.close();
}

/**
 * Dispatches a single JSON-RPC request to the appropriate handler. Returns
 * a response object, or null for notifications (which require no response).
 */
async function dispatch(
  req: JsonRpcRequest,
  tools: Map<string, CompiledTool>,
  ctx: CoreContext,
): Promise<JsonRpcResponse | null> {
  const { id, method } = req;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: CAPABILITIES,
        });

      case "notifications/initialized":
        // Client acknowledges our capabilities. No response needed.
        return null;

      case "tools/list":
        return ok(id, {
          tools: [...tools.values()].map((t) => ({
            name: t.def.name,
            description: t.def.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = req.params?.name;
        const args = req.params?.arguments ?? {};

        const compiled = tools.get(name);
        if (!compiled) {
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
          });
        }

        let validated: Record<string, unknown>;
        try {
          validated = compiled.validator(args);
        } catch (err: any) {
          const msg = err.issues
            ? err.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")
            : String(err?.message ?? err);
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: `Invalid arguments: ${msg}` }],
          });
        }

        try {
          const text = await compiled.def.execute(validated, ctx);
          return ok(id, {
            isError: false,
            content: [{ type: "text", text }],
          });
        } catch (err: any) {
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: `Tool error: ${err?.message ?? err}` }],
          });
        }
      }

      case "ping":
        return ok(id, {});

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INTERNAL_ERROR, message: err?.message ?? "Internal error" },
    };
  }
}

function ok(id: number | string | null, result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function send(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}
