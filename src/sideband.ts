import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";

/**
 * Deterministic socket path from the DB path. Both the MCP server and hook
 * processes resolve the same DB path (from THATCH_DB_PATH or the default
 * under XDG_CONFIG_HOME), so they independently arrive at the same socket
 * path without any out-of-band coordination.
 */
export function sidebandSocketPath(dbPath: string): string {
  const hash = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  return join(tmpdir(), `thatch-${hash}.sock`);
}

export interface SidebandMatch {
  label: string;
  score: number;
  store: string;
}

interface MatchRequest {
  method: "match";
  text: string;
  stores: string[];
  threshold: number;
  limit: number;
}

interface MatchResponse {
  ok: boolean;
  matches?: SidebandMatch[];
  error?: string;
}

/**
 * Serves embedding + semantic search requests over a Unix domain socket.
 * The MCP server (long-lived, warm model) runs this so that one-shot hook
 * processes can ask "does this prompt match any memories?" without loading
 * the ~34 MB model themselves.
 *
 * The protocol is newline-delimited JSON: one request per connection, one
 * response per connection. Requests are `{"method":"match","text":"...",
 * "stores":[...],"threshold":N,"limit":N}`. Responses are `{"ok":true,
 * "matches":[...]}` or `{"ok":false,"error":"..."}`.
 */
export class SidebandServer {
  #server: Server | null = null;
  #path: string;
  #model: EmbeddingModel;
  #db: ThatchDB;

  constructor(path: string, model: EmbeddingModel, db: ThatchDB) {
    this.#path = path;
    this.#model = model;
    this.#db = db;
  }

  /** Opens the socket. Cleans up any stale socket file from a crashed server. */
  start(): void {
    try {
      unlinkSync(this.#path);
    } catch {
      // No stale socket — expected on first run.
    }

    this.#server = createServer((socket) => {
      this.#handleConnection(socket);
    });

    this.#server.listen(this.#path);
  }

  /** Closes the socket and removes the socket file. */
  stop(): void {
    this.#server?.close();
    this.#server = null;
    try {
      unlinkSync(this.#path);
    } catch {
      // Already gone.
    }
  }

  get path(): string {
    return this.#path;
  }

  #handleConnection(socket: Socket): void {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;

      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      this.#handleRequest(line, socket);
    });
    socket.on("error", () => {
      // Client disconnected abruptly — nothing to do.
    });
  }

  async #handleRequest(line: string, socket: Socket): Promise<void> {
    let req: MatchRequest;
    try {
      req = JSON.parse(line);
    } catch {
      this.#respond(socket, { ok: false, error: "Invalid JSON" });
      return;
    }

    if (req.method !== "match") {
      this.#respond(socket, { ok: false, error: `Unknown method: ${req.method}` });
      return;
    }

    try {
      const embedding = await this.#model.queryEmbed(req.text);
      const results = this.#db.search(req.stores, embedding, { limit: req.limit });
      const matches: SidebandMatch[] = results
        .filter((r) => r._score >= req.threshold)
        .map((r) => ({
          label: r.label,
          score: Math.round(r._score * 1000) / 1000,
          store: r.store,
        }));
      this.#respond(socket, { ok: true, matches });
    } catch (err: any) {
      this.#respond(socket, { ok: false, error: String(err?.message ?? err) });
    }
  }

  #respond(socket: Socket, res: MatchResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(res) + "\n");
    }
  }
}

/**
 * Connect to the sideband server and request semantic matches for a prompt.
 * Returns null on any failure (server not running, stale socket, timeout) —
 * callers must treat null as "skip the recall nudge" and fall back gracefully.
 */
export function sidebandMatch(
  socketPath: string,
  text: string,
  stores: string[],
  threshold: number,
  limit: number,
  timeoutMs = 2000,
): Promise<SidebandMatch[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: SidebandMatch[] | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const socket = connect(socketPath);
    const req = JSON.stringify({ method: "match", text, stores, threshold, limit }) + "\n";
    let buf = "";

    const timer = setTimeout(() => {
      socket.destroy();
      done(null);
    }, timeoutMs);

    socket.on("error", () => {
      clearTimeout(timer);
      // Stale socket file left by a crashed server — clean it up so the next
      // connection attempt doesn't hit ECONNREFUSED again.
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone or never existed.
      }
      done(null);
    });

    socket.on("connect", () => {
      socket.write(req);
    });

    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;

      clearTimeout(timer);
      try {
        const res = JSON.parse(buf.slice(0, nl)) as MatchResponse;
        done(res.ok ? (res.matches ?? []) : null);
      } catch {
        done(null);
      }
      socket.destroy();
    });
  });
}
