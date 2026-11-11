import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The committed Claude Code marketplace manifest. The repo IS the
 * marketplace (`claude plugin marketplace add sysread/thatch` fetches this
 * file), and its single plugin entry sources the npm package - the
 * one-release-train design: the npm release is the plugin release. These
 * tests guard the shape `claude plugin validate` enforces and the fields
 * the README's two-line install resolves against.
 */
const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", ".claude-plugin", "marketplace.json"), "utf8"),
) as {
  name: string;
  owner: { name: string; url?: string };
  description: string;
  plugins: Array<Record<string, unknown>>;
};

describe("the committed Claude Code marketplace manifest", () => {
  test("carries the required marketplace fields", () => {
    expect(manifest.name).toBe("thatch");
    expect(manifest.owner.name).toBeTruthy();
    expect(manifest.description).toBeTruthy();
    expect(manifest.plugins).toHaveLength(1);
  });

  test("the plugin entry resolves the npm package (one release train)", () => {
    const [entry] = manifest.plugins;
    // `/plugin install thatch` resolves the ENTRY name; the npm source
    // fetches the published @jeffober/thatch package.
    expect(entry.name).toBe("thatch");
    expect(entry.source).toEqual({ source: "npm", package: "@jeffober/thatch" });
  });

  test("declares no version and no components (the package's manifest governs)", () => {
    const [entry] = manifest.plugins;
    // The fetched package's plugin.json sets the version (an entry version
    // would only draw a validate warning), and component fields belong to
    // the package's own manifest, not the marketplace entry.
    expect(entry.version).toBeUndefined();
    expect(entry.mcpServers).toBeUndefined();
    expect(entry.hooks).toBeUndefined();
    expect(entry.commands).toBeUndefined();
    expect(entry.skills).toBeUndefined();
  });
});
