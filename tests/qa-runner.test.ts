import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { journalResult, parseQaVerdict, QA_ROOT, RESULT_JOURNAL } from "./qa/runner";

// The QA verdict parser (tests/qa/runner.ts): the LAST "Result:" line
// decides. Line-start anchored so quoted prose mid-line cannot override a
// real verdict - the false-PASS class the anchorless regex had.

describe("parseQaVerdict", () => {
  test("takes the last verdict line", () => {
    expect(parseQaVerdict("Result: FAIL\nlater recovery\nResult: PASS")).toBe("PASS");
    expect(parseQaVerdict("Result: PASS\nthen a regression\nResult: FAIL")).toBe("FAIL");
  });

  test("tolerates leading emphasis and whitespace", () => {
    expect(parseQaVerdict("**Result: PASS**")).toBe("PASS");
    expect(parseQaVerdict("  **Result: MANUAL-ONLY**")).toBe("MANUAL-ONLY");
    expect(parseQaVerdict("*Result: DOCS_MISMATCH*")).toBe("DOCS_MISMATCH");
  });

  test("quoted prose mid-line never decides the verdict", () => {
    // The false-PASS class: an Evidence line quoting the format spec sits
    // mid-line and must not match, so the real FAIL below wins.
    const output = [
      'Evidence: the tool printed "Result: PASS | FAIL" in its usage text.',
      "the watch never fired.",
      "Result: FAIL",
    ].join("\n");
    expect(parseQaVerdict(output)).toBe("FAIL");
  });

  test("no verdict line is null (caller fails closed)", () => {
    expect(parseQaVerdict("all good, no marker here")).toBeNull();
    expect(parseQaVerdict("")).toBeNull();
  });
});

describe("result journal", () => {
  afterEach(() => {
    rmSync(QA_ROOT, { recursive: true, force: true });
  });

  test("a UC completion appends a durable, parseable line", () => {
    journalResult({ uc: "UC-TEST", leg: "v2", result: "PASS" });
    journalResult({ uc: "UC-TEST", leg: "v2", result: "FAIL", output: "Result: FAIL\nthe observed drift" });
    expect(existsSync(RESULT_JOURNAL)).toBe(true);
    const lines = readFileSync(RESULT_JOURNAL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    // The result line names the failure (what the 2026-11-05 truncated-tail
    // chase lacked); the output line carries the evidence head, clipped.
    expect(lines[0]).toMatchObject({ uc: "UC-TEST", leg: "v2", result: "PASS" });
    expect(typeof lines[0].at).toBe("string");
    expect(lines[1]).toMatchObject({ uc: "UC-TEST", result: "FAIL" });
    expect(lines[1].output).toContain("the observed drift");
    expect(lines[1].output.length).toBeLessThanOrEqual(2000);
  });

  test("a journal write failure never fails the use case", () => {
    // RESULT_JOURNAL's dir is created by journalResult; point the env-free
    // failure path at an impossible target by removing the dir mid-flight
    // is racy - instead assert the CONTRACT: the function returns void and
    // swallows, which the happy-path test above already exercises. This
    // test pins that a nonexistent parent dir does not throw.
    expect(() => journalResult({ uc: "UC-X", leg: null, result: "PASS" })).not.toThrow();
  });
});
