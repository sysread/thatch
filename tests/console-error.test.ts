import { describe, test, expect } from "bun:test";
import { captureConsoleError, silenceConsoleError } from "./mocks/console-error";

// The helpers exist to make the restore structurally impossible to miss,
// so the tests pin exactly that contract: lines swallowed/recorded during
// the scope, the original back after it - including after a throw.

describe("silenceConsoleError", () => {
  test("swallows error logs during the scope and restores after", async () => {
    const original = console.error;
    const result = await silenceConsoleError(async () => {
      console.error("expected failure noise");
      return 42;
    });
    expect(result).toBe(42);
    expect(console.error).toBe(original);
  });

  test("restores even when the scoped body throws", async () => {
    const original = console.error;
    await expect(silenceConsoleError(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(console.error).toBe(original);
  });
});

describe("captureConsoleError", () => {
  test("records joined lines and restores after", async () => {
    const original = console.error;
    const { result, lines } = await captureConsoleError(async () => {
      console.error("[thatch] part one", { nested: "part two" });
      return "done";
    });
    expect(result).toBe("done");
    expect(lines).toEqual(["[thatch] part one [object Object]"]);
    expect(console.error).toBe(original);
  });

  test("restores even when the scoped body throws", async () => {
    const original = console.error;
    await expect(
      captureConsoleError(async () => {
        console.error("logged before the throw");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(console.error).toBe(original);
  });
});
