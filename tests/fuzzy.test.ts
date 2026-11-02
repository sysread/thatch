import { describe, test, expect } from "bun:test";
import { damerauLevenshtein, didYouMean, didYouMeanLine, nearMissParam } from "../src/fuzzy";

// Weights mirror git's help.c levenshtein call: swap 0, substitute 2,
// insert 1, delete 3. The tests pin each weight individually so a weight
// change is a deliberate act, not an accident.

describe("damerauLevenshtein", () => {
  test("identical strings cost 0", () => {
    expect(damerauLevenshtein("status", "status")).toBe(0);
  });

  test("adjacent transposition is free (git's dominant-typo weight)", () => {
    expect(damerauLevenshtein("stauts", "status")).toBe(0);
    expect(damerauLevenshtein("teh", "the")).toBe(0);
  });

  test("substitution costs 2", () => {
    expect(damerauLevenshtein("cat", "bat")).toBe(2);
  });

  test("insertion costs 1", () => {
    expect(damerauLevenshtein("cat", "cats")).toBe(1);
  });

  test("deletion costs 3", () => {
    expect(damerauLevenshtein("cats", "cat")).toBe(3);
  });

  test("restricted (optimal string alignment): no transposition chains", () => {
    // "bca" -> "abc" needs chained transpositions; the restricted
    // algorithm (like git's levenshtein.c) cannot transpose a substring
    // twice and pays a costlier edit path instead.
    expect(damerauLevenshtein("bca", "abc")).toBe(4);
  });

  test("empty operands", () => {
    expect(damerauLevenshtein("", "abc")).toBe(3);
    expect(damerauLevenshtein("abc", "")).toBe(9);
    expect(damerauLevenshtein("", "")).toBe(0);
  });
});

describe("didYouMean", () => {
  test("returns nothing when nothing is close (git-strict, never a fallback guess)", () => {
    const candidates = ["Pull Request Summary", "Deployment Config", "Release Notes"];
    expect(didYouMean("completely unrelated garbage text", candidates)).toEqual([]);
  });

  test("suggests a near-miss label", () => {
    expect(didYouMean("Pull Request Sumary", ["Pull Request Summary", "Deployment Config"])).toEqual([
      "Pull Request Summary",
    ]);
  });

  test("suggests a transposed-typo label at cost 0", () => {
    expect(didYouMean("stauts", ["status", "other"])).toEqual(["status"]);
  });

  test("caps suggestions at 3", () => {
    // Five candidates each one insertion away from "status".
    const candidates = ["status1", "status2", "status3", "status4", "status5"];
    const hits = didYouMean("status", candidates);
    expect(hits.length).toBe(3);
  });

  test("scores multi-word labels token-aware: a one-word typo suggests the label", () => {
    const hits = didYouMean(
      "memory show lbel",
      ["Label For Memory Shows", "Something Entirely Different Here"],
    );
    expect(hits).toContain("Label For Memory Shows");
    expect(hits).not.toContain("Something Entirely Different Here");
  });

  test("punctuation and case differences do not defeat token matching", () => {
    const hits = didYouMean("pull-request: sumary", ["Pull Request Summary"]);
    expect(hits).toEqual(["Pull Request Summary"]);
  });

  test("does not suggest the query itself", () => {
    expect(didYouMean("status", ["status"])).toEqual([]);
  });
});

describe("didYouMeanLine", () => {
  test("empty when nothing is close", () => {
    expect(didYouMeanLine("zzzzqqqq", ["unrelated"])).toBe("");
  });

  test("single candidate uses the git-style 'Did you mean X?' phrasing", () => {
    expect(didYouMeanLine("stauts", ["status"])).toBe('Did you mean "status"?');
  });

  test("multiple candidates use git's verbatim one-of-these phrasing", () => {
    const line = didYouMeanLine("status1", ["status1a", "status1b", "status1c"]);
    expect(line).toMatch(/^Did you mean one of these: /);
    expect(line).toContain('"status1a"');
  });
});

describe("nearMissParam", () => {
  test("returns the misnamed key for a misspelled parameter with a string value", () => {
    expect(nearMissParam({ labels: "Some Label" }, ["label"])).toBe("labels");
  });

  test("ignores keys that are not near misses", () => {
    expect(nearMissParam({ id: "nope" }, ["label"])).toBeNull();
  });

  test("ignores keys whose value is not a non-empty string", () => {
    expect(nearMissParam({ labels: 42 }, ["label"])).toBeNull();
    expect(nearMissParam({ labels: "   " }, ["label"])).toBeNull();
  });

  test("ignores expected keys themselves", () => {
    expect(nearMissParam({ label: "x", store: "s" }, ["label", "store"])).toBeNull();
  });
});
