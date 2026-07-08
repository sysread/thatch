import { z } from "zod";
import { ThatchDB } from "./db";
import { BgeEmbeddingModel } from "./embeddings";
import { detectRepo } from "./git";
import { TOOL_DEFS, type CoreContext, type ToolDef } from "./tool-defs";
import { SidebandServer, sidebandSocketPath } from "./sideband";

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
const SERVER_VERSION = "0.1.2";

/**
 * MCP capabilities declared in the initialize response. Thatch is a tools-only
 * server — no resources, prompts, or subscriptions.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
};

// ---------------------------------------------------------------------------
// Tool index — builds validators and JSON Schema once at server startup
// ---------------------------------------------------------------------------

interface CompiledTool {
  def: ToolDef;
  validator: (input: unknown) => Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

function compileTools(): Map<string, CompiledTool> {
  const map = new Map<string, CompiledTool>();
  for (const def of TOOL_DEFS) {
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
 * stdin, writes responses to stdout. All diagnostics go to stderr — any stray
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
  const ctx: CoreContext = { db, model, defaultStore: repo };
  const tools = compileTools();

  // The sideband socket lets one-shot hook processes (flush-tools) ask the
  // warm MCP server to embed a prompt and search for matches — without
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

      // Notifications (no id) are fire-and-forget — no response expected.
      const isNotification = req.id === null || req.id === undefined;
      const res = await dispatch(req, tools, ctx);
      if (res === null || isNotification) continue;
      send(res);
    }
  }

  sideband.stop();
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
