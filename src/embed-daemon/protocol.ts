/**
 * The embed daemon's wire contract: newline-delimited JSON messages over a
 * Unix socket, pure code with no I/O. Shared by the daemon process body
 * (daemon.ts), the client (client.ts), and the doctor's probe.
 *
 * The daemon serves RAW EMBEDS only - not the sideband's db-backed match
 * methods. Issue #26's open question was what may move into a shared
 * daemon; the answer here is "embeddings only". Session state (store
 * detection, branch scope, chat identity) stays per session by
 * construction: the DB stays per-process access to the shared file, and
 * only the model moves into the daemon.
 *
 * Connection lifecycle, stated once and inherited everywhere: a connection
 * is connect, hello, its response, AT MOST ONE embed, close. Hello is the
 * per-connection preamble, not a request on equal footing with embed (the
 * doctor's probe is hello-close with no embed). The one-request shape
 * matches the sideband's framing (newline-delimited JSON, one logical
 * exchange per connection); the sideband's rationale for it is not recorded
 * in git history, so none is invented here.
 *
 * Vector length is opaque to the protocol: the DB discriminates spaces by
 * dimension, and THATCH_MODEL may select a different-dimension model, so
 * the codec validates no dimension count.
 */

export type HelloRequest = { method: "hello" };
export type EmbedRequest = { method: "embed"; kind: "query" | "passage"; text: string };
export type DaemonRequest = HelloRequest | EmbedRequest;

export type HelloResponse = { ok: true; model: string; version: string; pid: number };
export type EmbedResponse = { ok: true; vector: number[]; model: string; version: string; pid: number };
export type ErrorResponse = { ok: false; error: string };
export type DaemonResponse = HelloResponse | EmbedResponse | ErrorResponse;

/** Raised for any line that is not a valid message of the expected kind. */
export class DaemonProtocolError extends Error {}

export function encodeMessage(msg: DaemonRequest | DaemonResponse): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Parses one request line. Throws DaemonProtocolError on bad JSON, an
 * unknown method, a missing hello/embed shape, or an embed without a
 * query/passage kind and string text.
 */
export function decodeRequest(line: string): DaemonRequest {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new DaemonProtocolError("Invalid JSON");
  }
  if (raw?.method === "hello") return { method: "hello" };
  if (raw?.method === "embed") {
    if ((raw.kind === "query" || raw.kind === "passage") && typeof raw.text === "string") {
      return { method: "embed", kind: raw.kind, text: raw.text };
    }
    throw new DaemonProtocolError("embed requires kind (query|passage) and text");
  }
  throw new DaemonProtocolError(`Unknown method: ${raw?.method ?? "<none>"}`);
}

/**
 * Parses one response line. Throws DaemonProtocolError on bad JSON or an
 * unknown shape; vector length is opaque (no dimension validation).
 */
export function decodeResponse(line: string): DaemonResponse {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new DaemonProtocolError("Invalid JSON");
  }
  if (raw?.ok === false && typeof raw.error === "string") {
    return { ok: false, error: raw.error };
  }
  if (raw?.ok === true && typeof raw.model === "string" && typeof raw.version === "string" && typeof raw.pid === "number") {
    if (Array.isArray(raw.vector)) {
      return { ok: true, vector: raw.vector, model: raw.model, version: raw.version, pid: raw.pid };
    }
    return { ok: true, model: raw.model, version: raw.version, pid: raw.pid };
  }
  throw new DaemonProtocolError("Malformed daemon response");
}
