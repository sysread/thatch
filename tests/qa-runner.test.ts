import { describe, test, expect } from "bun:test";
import { parseQaVerdict } from "./qa/runner";

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
