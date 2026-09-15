import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugLog, debugEnabled } from "../src/debug";

describe("debugEnabled", () => {
  test("off when THATCH_DEBUG is unset or empty", () => {
    expect(debugEnabled(undefined, "chat:startup")).toBe(false);
    expect(debugEnabled("", "chat:startup")).toBe(false);
  });

  test("1, all, and * enable every tag", () => {
    for (const spec of ["1", "all", "*", " 1 "]) {
      expect(debugEnabled(spec, "chat:startup")).toBe(true);
      expect(debugEnabled(spec, "watch:poll")).toBe(true);
    }
  });

  test("a filter matches the whole tag or the feature part", () => {
    expect(debugEnabled("chat", "chat:startup")).toBe(true);
    expect(debugEnabled("chat", "chat:poll")).toBe(true);
    expect(debugEnabled("chat:startup", "chat:startup")).toBe(true);
    expect(debugEnabled("chat:startup", "chat:poll")).toBe(false);
    expect(debugEnabled("chat", "watch:poll")).toBe(false);
  });

  test("a bare feature tag and a trailing-colon spec follow the feature-part rule", () => {
    // A tag with no aspect matches its own name; "chat:" as a spec is the
    // literal tag "chat:", which nothing is named, and its feature part is
    // "chat:" too (split happens on the tag, not the spec).
    expect(debugEnabled("chat", "chat")).toBe(true);
    expect(debugEnabled("chat:", "chat:startup")).toBe(false);
    expect(debugEnabled("chat:", "chat")).toBe(false);
  });

  test("comma-separated filters are OR'd and whitespace-tolerant", () => {
    expect(debugEnabled("watch, chat:startup", "chat:startup")).toBe(true);
    expect(debugEnabled("watch, chat:startup", "watch:poll")).toBe(true);
    expect(debugEnabled("watch, chat:startup", "chat:poll")).toBe(false);
  });
});

describe("createDebugLog", () => {
  test("writes tagged, timestamped lines to debug.log beside the db", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-debug-"));
    const log = createDebugLog(join(dir, "thatch.db"), "1");
    log("chat:startup", "hello");
    log("watch:poll", "tick");
    const lines = readFileSync(join(dir, "debug.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[chat:startup\] hello$/);
    expect(lines[1]).toMatch(/\[watch:poll\] tick$/);
  });

  test("writes nothing when disabled or filtered out", () => {
    const dir = mkdtempSync(join(tmpdir(), "thatch-debug-"));
    createDebugLog(join(dir, "thatch.db"), undefined)("chat:startup", "no");
    createDebugLog(join(dir, "thatch.db"), "watch")("chat:startup", "no");
    expect(existsSync(join(dir, "debug.log"))).toBe(false);
  });

  test("never throws when the directory does not exist", () => {
    const log = createDebugLog("/nonexistent/thatch-debug-dir/thatch.db", "1");
    expect(() => log("chat:startup", "dropped")).not.toThrow();
  });
});
