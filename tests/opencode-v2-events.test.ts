import { describe, test, expect } from "bun:test";
import { eventMatchesInstance, flattenToolContent, mapSessionContextMessages, translateEvent } from "../src/opencode/v2";
import { PROJECT_DIR, SESSION_DIR } from "./mocks/opencode-v2-harness";

// Pure v2 mapping functions: no mocked context, no env, no db. The three
// adapter-describe tests at the bottom run plain functions and live here
// for the same reason (their describe name is kept so test identities,
// as printed by the runner, are unchanged).

describe("translateEvent session.created parentID", () => {
  test("maps the parent link from info.parentID (v2 payload shape)", () => {
    // v2 publishes the v1-compat payload { sessionID, info: SessionInfo };
    // the task tool dispatches sub-agents with a parentID, and the runtime's
    // childToParent map reads properties.info.parentID.
    const [event] = translateEvent({
      type: "session.created",
      data: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_parent" } },
    });
    expect(event.type).toBe("session.created");
    expect(event.properties.info.id).toBe("ses_child");
    expect(event.properties.info.parentID).toBe("ses_parent");
  });

  test("falls back to a top-level parentID", () => {
    const [event] = translateEvent({
      type: "session.created",
      data: { sessionID: "ses_child", parentID: "ses_parent" },
    });
    expect(event.properties.info.parentID).toBe("ses_parent");
  });
});

describe("opencode v2 adapter", () => {
  test("flattenToolContent passes strings through and joins text parts", async () => {
    expect(flattenToolContent("plain output")).toBe("plain output");
    expect(
      flattenToolContent([{ type: "text", text: "line one" }, { type: "file", uri: "file:///x" }, { type: "text", text: "line two" }]),
    ).toBe("line one\nline two");
    expect(flattenToolContent([{ type: "file", uri: "file:///x" }])).toBe("");
    expect(flattenToolContent(undefined)).toBe("");
    expect(flattenToolContent(42)).toBe("");
  });

  test("mapSessionContextMessages maps v2 message kinds into the v1 shape", () => {
    const mapped = mapSessionContextMessages([
      { type: "user", text: "hello" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "tool", name: "read" },
          { type: "text", text: "the answer" },
        ],
        error: { type: "MessageAbortedError", message: "aborted" },
      },
      { type: "synthetic" },
    ]);
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toEqual({ info: { role: "user" }, parts: [{ type: "text", text: "hello", synthetic: false }] });
    expect(mapped[1].info.role).toBe("assistant");
    // Reasoning parts are skipped; tool parts keep the tool name (other
    // consumers may want it - the alert classifier reads roles and errors,
    // not tool names); the message-level error name rides info.
    expect(mapped[1].info.error).toBe("MessageAbortedError");
    expect(mapped[1].parts).toEqual([
      { type: "tool", tool: "read" },
      { type: "text", text: "the answer" },
    ]);
    expect(mapped[2].parts).toEqual([{ type: "text", text: "", synthetic: true }]);
  });

  test("child-session events pass the directory filter on below-root launches", async () => {
    // The child is created in the project directory; when the instance
    // directory differs (opencode launched below the project root), the
    // child's events must still reach the runtime - its idle event is what
    // drives the extraction cleanup.
    expect(eventMatchesInstance(PROJECT_DIR, "v2-test-child", SESSION_DIR, new Set(["v2-test-child"]))).toBe(true);
    expect(eventMatchesInstance(SESSION_DIR, undefined, SESSION_DIR, new Set())).toBe(true);
    expect(eventMatchesInstance(PROJECT_DIR, "ses_other", SESSION_DIR, new Set(["v2-test-child"]))).toBe(false);
    expect(eventMatchesInstance(undefined, undefined, SESSION_DIR, new Set())).toBe(false);
  });
});
