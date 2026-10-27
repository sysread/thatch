import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENV_KNOBS, envKnobValue, renderEnvKnobs } from "../src/env-knobs";

// The registry claims to list every THATCH_* environment knob that exists
// in code. These tests enforce both directions of that claim against the
// actual source tree, so a new knob without a registry entry (or a deleted
// knob left in the registry) fails the quality gate.

const SRC_ROOT = join(import.meta.dir, "..");

/** All knob-bearing sources: every TypeScript file under src/ EXCEPT this
 *  one - the registry itself spells every knob name, so scanning it would
 *  make the deleted-knob direction of the drift check tautological - plus
 *  the bin/thatch CLI. */
function allSource(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && full !== join(SRC_ROOT, "src", "env-knobs.ts")) files.push(full);
    }
  };
  walk(join(SRC_ROOT, "src"));
  return [...files, join(SRC_ROOT, "bin", "thatch")]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

// Protocol strings, not knobs: they mark extraction payload boundaries,
// sub-agent ready tokens, and the instructions-file markers setup.ts writes.
const PROTOCOL_MARKERS = new Set([
  "THATCH_MARKER",
  "THATCH_BEGIN",
  "THATCH_END",
  "THATCH_BEGIN_MARKER",
  "THATCH_END_MARKER",
  "THATCH_COMPACT_READY",
]);

describe("ENV_KNOBS registry", () => {
  test("every registered knob name appears in the source tree", () => {
    const source = allSource();
    for (const knob of ENV_KNOBS) {
      expect(source.includes(knob.name), `${knob.name} is registered but never read in code`).toBe(true);
    }
  });

  test("every THATCH_ variable in the source tree is registered (except protocol markers)", () => {
    const source = allSource();
    const found = new Set(source.match(/THATCH_[A-Z0-9_]+/g) ?? []);
    for (const name of found) {
      if (PROTOCOL_MARKERS.has(name)) continue;
      expect(ENV_KNOBS.some((k) => k.name === name), `${name} exists in code but is missing from ENV_KNOBS`).toBe(true);
    }
  });

  test("knob names are unique", () => {
    expect(new Set(ENV_KNOBS.map((k) => k.name)).size).toBe(ENV_KNOBS.length);
  });

  test("every knob carries a one-sentence description and a default", () => {
    for (const knob of ENV_KNOBS) {
      expect(knob.description.length).toBeGreaterThan(0);
      expect(knob.description.endsWith(".")).toBe(true);
      expect(knob.default.length).toBeGreaterThan(0);
    }
  });
});

describe("renderEnvKnobs", () => {
  test("one line per knob plus the header, with effective values and defaults", () => {
    const env = { THATCH_RECALL_THRESHOLD: "0.7" };
    const out = renderEnvKnobs(env);
    const lines = out.split("\n");
    expect(lines[0]).toBe("environment:");
    expect(lines.length - 1).toBe(ENV_KNOBS.length);
    expect(out).toContain("THATCH_RECALL_THRESHOLD: 0.7 (default: 0.55)");
    expect(out).toContain("THATCH_DB_PATH: <unset>");
  });
});

describe("envKnobValue", () => {
  test("reads the passed environment; unset shows <unset>", () => {
    expect(envKnobValue("THATCH_DEBUG", {})).toBe("<unset>");
    expect(envKnobValue("THATCH_DEBUG", { THATCH_DEBUG: "chat" })).toBe("chat");
  });
});
