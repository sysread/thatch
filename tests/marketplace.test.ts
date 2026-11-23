import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The committed Claude Code marketplace manifest. The repo IS the
 * marketplace (`claude plugin marketplace add sysread/thatch` fetches this
 * file), and its single plugin entry sources a GIT branch of this repo -
 * plugin-release, the CI-generated tree of the prepack output (the
 * publish.yml plugin-branch job commits it at every tag). The entry is
 * pinned to the branch, so installs clone the repo instead of running
 * npm's tarball-URL pack (the npm 12 EALLOWREMOTE gate; see
 * docs/user/setup.md). These tests guard the shape `claude plugin
 * validate` enforces and the fields the README's two-line install
 * resolves against.
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

  test("the plugin entry resolves the plugin-release branch (git source, no npm)", () => {
    const [entry] = manifest.plugins;
    // `/plugin install thatch` resolves the ENTRY name; the github source
    // clones sysread/thatch at the plugin-release branch, which carries the
    // prepack-generated plugin tree.
    expect(entry.name).toBe("thatch");
    expect(entry.source).toEqual({ source: "github", repo: "sysread/thatch", ref: "plugin-release" });
  });

  test("declares no version (the branch's plugin.json manifest governs)", () => {
    const [entry] = manifest.plugins;
    // The generated plugin.json on the branch sets the version (an entry
    // version would only draw a validate warning).
    expect(entry.version).toBeUndefined();
  });

  test("mirrors the generated plugin.json's mcpServers (the Discover summary)", () => {
    const [entry] = manifest.plugins;
    // /plugin's Discover view renders a remote entry's own component
    // fields and shows "Component summary not available for remote plugin"
    // when it declares none. On a git source the entry's components meet
    // the branch manifest's own under the strict-conflict rule, so the
    // mirror carries strict: true to stay legal; scripts/prepack.ts
    // verifies it against the generated manifest.
    expect(entry.strict).toBe(true);
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
