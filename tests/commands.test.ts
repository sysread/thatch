import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOpencodeCommands, removeWrapUpCommandFiles, claudeCommandDefs, COMMANDS_ARTIFACTS_DIR, opencodeCommandDefs } from "../src/commands";

// The artifacts/commands templates are the source of truth for command
// bodies. Two invariants keep them honest: every placeholder in every
// artifact resolves at load (the loader throws, but this test catches
// resolution failures as a named assertion), and the artifact set exactly
// covers the command set - a template with no command, or a command with no
// template, means the registry and the artifacts have drifted.
describe("command artifacts", () => {
  test("every command template's placeholders resolve", () => {
    for (const file of readdirSync(COMMANDS_ARTIFACTS_DIR)) {
      if (!file.endsWith(".md")) continue;
      const name = file.replace(/\.md$/, "");
      const raw = readFileSync(join(COMMANDS_ARTIFACTS_DIR, file), "utf8");
      const unresolved = raw.match(/\$\{(?!TOOL:|CORE:|COUCHING:|CHECKLIST)[A-Z_]*(?::[a-zA-Z_]+)?\}/);
      expect(unresolved, `${name}.md has an unresolvable placeholder`).toBeNull();
    }
  });

  test("artifact set matches the command set (wrap-ups aside)", () => {
    const artifacts = new Set(readdirSync(COMMANDS_ARTIFACTS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")));
    const commands = new Set(opencodeCommandDefs().map((d) => d.name));
    for (const name of commands) {
      expect(artifacts.has(name), `command ${name} has no artifacts/commands/${name}.md`).toBe(true);
    }
    // The two wrap-up artifacts have no file-installed command def: the
    // wrap-ups register in code (CommandEditor), and their bodies load
    // through wrapUpCommandContent, not the install set.
    const wrapUps = new Set(["compact", "exit"]);
    for (const name of artifacts) {
      expect(
        commands.has(name) || wrapUps.has(name),
        `artifact ${name}.md has no command (stale template)`,
      ).toBe(true);
    }
  });
});


// The pre-drop -> post-drop upgrade path: pre-drop installs wrote wrap-up
// command FILES; the wrap-ups now register in code and only the action
// files install. The stale files must be removed (a file and a registered
// command with the same name collide), and the removal must tolerate a
// missing dir.

function fakeConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), "thatch-cmds-"));
  return home;
}

describe("removeWrapUpCommandFiles", () => {
  test("removes wrap-up files left by a pre-drop install, keeps action files", () => {
    const configHome = fakeConfigHome();
    installOpencodeCommands(configHome); // action files only
    const dir = join(configHome, "opencode", "command", "thatch");
    // Simulate the pre-drop leftovers: wrap-up files the current install
    // never writes but must clean (they collide with the registered
    // wrap-up commands).
    writeFileSync(join(dir, "compact.md"), "stale");
    writeFileSync(join(dir, "exit.md"), "stale");
    expect(existsSync(join(dir, "compact.md"))).toBe(true);
    expect(existsSync(join(dir, "exit.md"))).toBe(true);

    removeWrapUpCommandFiles(configHome);
    expect(existsSync(join(dir, "compact.md"))).toBe(false);
    expect(existsSync(join(dir, "exit.md"))).toBe(false);
    const remaining = opencodeCommandDefs().map((d) => existsSync(join(dir, `${d.name}.md`)));
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every(Boolean)).toBe(true);
  });

  test("is idempotent and tolerates a missing directory", () => {
    const configHome = fakeConfigHome();
    removeWrapUpCommandFiles(configHome);
    removeWrapUpCommandFiles(configHome);
    // A malformed entry (a directory where a file should be) must not throw.
    const dir = join(configHome, "opencode", "command", "thatch");
    mkdirSync(join(dir, "compact.md"), { recursive: true });
    expect(() => removeWrapUpCommandFiles(configHome)).not.toThrow();
  });

  test("the install set never contains the wrap-up names", () => {
    // Guard the invariant the removal exists to protect: registering
    // thatch/compact in code while compact.md is on disk is the collision.
    const names = opencodeCommandDefs().map((d) => d.name);
    expect(names).not.toContain("compact");
    expect(names).not.toContain("exit");
  });
});

describe("whois command", () => {
  test("opencode-only: in the opencode set, excluded from Claude Code's, description stays a quoted YAML scalar", () => {
    const opencode = opencodeCommandDefs().find((d) => d.name === "whois");
    expect(opencode).toBeDefined();
    // The description contains ": " - it must be rendered quoted or the
    // frontmatter is invalid YAML (the yamlQuote gotcha).
    expect(opencode!.content).toMatch(/^---\ndescription: "/);
    expect(opencode!.content).toContain("thatch_chat_status");
    expect(opencode!.content).toContain("thatch_chat_list");

    // Claude Code's set has no session identity for the self-report, so
    // whois must not leak into it (or into the MCP prompt surface).
    const claudeNames = claudeCommandDefs().map((d) => d.name);
    expect(claudeNames).not.toContain("whois");
  });
});

describe("review-mode commands (peer-review, self-review)", () => {
  test("shared across hosts: both sets carry them, couching the review pipeline with mode rules", () => {
    const opencode = opencodeCommandDefs();
    const peer = opencode.find((d) => d.name === "peer-review");
    const self = opencode.find((d) => d.name === "self-review");
    expect(peer).toBeDefined();
    expect(self).toBeDefined();

    // Both couch the same machinery: the coordinator skill when present,
    // the inline specialist procedure when not, and the target coming
    // from the user message or the MCP Focus: line.
    for (const def of [peer!, self!]) {
      expect(def.content).toContain("thatch-code-review");
      expect(def.content).toContain("thatch-review-synthesizer");
      expect(def.content).toContain("Focus: line");
      expect(def.content).toContain("mode rules");
    }

    // The two modes carry different policy: peer-review is org-velocity and
    // forbids future-change findings; self-review is reputation-weighted
    // and iterates rounds.
    expect(peer!.content).toContain("org velocity");
    expect(peer!.content).toContain("Never report findings of the form");
    expect(self!.content).toContain("reputation");
    expect(self!.content).toContain("drift guard at ten rounds");
    expect(self!.content).not.toContain("org velocity");

    // The post-synthesis adjudication is peer-mode only: self-review stays
    // an automatic chat loop with no user verdicts by default, so the
    // adjudicate skill must never leak into its command body.
    expect(peer!.content).toContain("thatch-review-adjudicate");
    expect(self!.content).not.toContain("thatch-review-adjudicate");

    // Claude Code's set carries both (they need no session identity), with
    // the memory-walk tool in MCP spelling and no opencode spelling.
    const claudePeer = claudeCommandDefs().find((d) => d.name === "peer-review")!;
    const claudeSelf = claudeCommandDefs().find((d) => d.name === "self-review")!;
    expect(claudePeer).toBeDefined();
    expect(claudeSelf).toBeDefined();
    expect(claudePeer.content).toContain("mcp__thatch__memory_recall");
    expect(claudePeer.content).not.toContain("thatch_memory_recall");
  });
});
