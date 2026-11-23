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

  test("declares no version (the package's manifest governs)", () => {
    const [entry] = manifest.plugins;
    // The fetched package's plugin.json sets the version (an entry version
    // would only draw a validate warning).
    expect(entry.version).toBeUndefined();
  });

  test("mirrors the generated plugin.json's mcpServers (the Discover summary)", () => {
    const [entry] = manifest.plugins;
    // /plugin's Discover view renders a remote entry's own component
    // fields and shows "Component summary not available for remote plugin"
    // when it declares none. An entry's mcpServers never applies when the
    // package has its own plugin.json, so this mirror is display-only;
    // scripts/prepack.ts verifies it against the generated manifest.
    expect(entry.mcpServers).toEqual({
      thatch: {
        type: "stdio",
        command: "bun",
        args: ["${CLAUDE_PLUGIN_ROOT}/bin/thatch", "mcp", "--bundled"],
      },
    });
  });

  test("declares no commands, agents, skills, or hooks (the plugin ships none as components)", () => {
    const [entry] = manifest.plugins;
    // The mod loads from the default hooks/hooks.json location and the
    // shared skills install via `thatch setup`; entry component fields
    // would merge into the package's plugin.json at install against
    // trees the package does not ship. prepack guards this too.
    expect(entry.commands).toBeUndefined();
    expect(entry.agents).toBeUndefined();
    expect(entry.skills).toBeUndefined();
    expect(entry.hooks).toBeUndefined();
  });
});
