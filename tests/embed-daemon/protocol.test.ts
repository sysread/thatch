import { describe, test, expect } from "bun:test";
import {
  DaemonProtocolError,
  decodeRequest,
  decodeResponse,
  encodeMessage,
} from "../../src/embed-daemon/protocol";

describe("embed-daemon protocol", () => {
  test("request codec roundtrips hello and embed shapes", () => {
    const hello = decodeRequest(encodeMessage({ method: "hello" }).trim());
    expect(hello).toEqual({ method: "hello" });

    const embed = decodeRequest(encodeMessage({ method: "embed", kind: "query", text: "hello world" }).trim());
    expect(embed).toEqual({ method: "embed", kind: "query", text: "hello world" });
  });

  test("bad JSON and unknown methods raise protocol errors", () => {
    expect(() => decodeRequest("not json")).toThrow(DaemonProtocolError);
    expect(() => decodeRequest(JSON.stringify({ method: "match", text: "x" }))).toThrow(DaemonProtocolError);
    expect(() => decodeRequest(JSON.stringify({ method: "embed", kind: "sideways", text: "x" }))).toThrow(DaemonProtocolError);
    expect(() => decodeRequest(JSON.stringify({ method: "embed", text: "no kind" }))).toThrow(DaemonProtocolError);
  });

  test("response codec roundtrips hello, embed, and error shapes", () => {
    const hello = decodeResponse(encodeMessage({ ok: true, model: "mock", version: "0.4.3", pid: 42 }).trim());
    expect(hello).toEqual({ ok: true, model: "mock", version: "0.4.3", pid: 42 });

    const embed = decodeResponse(encodeMessage({ ok: true, vector: [1, 2, 3], model: "mock", version: "0.4.3", pid: 42 }).trim());
    expect(embed).toEqual({ ok: true, vector: [1, 2, 3], model: "mock", version: "0.4.3", pid: 42 });

    const err = decodeResponse(encodeMessage({ ok: false, error: "boom" }).trim());
    expect(err).toEqual({ ok: false, error: "boom" });
  });

  test("vector length is opaque to the codec", () => {
    // THATCH_MODEL may select a different-dimension model; the DB
    // discriminates spaces by dimension - no 384 validation here.
    const res = decodeResponse(encodeMessage({ ok: true, vector: [1], model: "m", version: "0", pid: 1 }).trim());
    expect(res).toEqual({ ok: true, vector: [1], model: "m", version: "0", pid: 1 });
  });

  test("malformed responses raise protocol errors", () => {
    expect(() => decodeResponse("garbage")).toThrow(DaemonProtocolError);
    expect(() => decodeResponse(JSON.stringify({ ok: true, model: "m" }))).toThrow(DaemonProtocolError);
  });
});
