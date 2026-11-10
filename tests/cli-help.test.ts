// The shared CLI help renderer (src/cli/help.ts): uniform two-column
// pages built from Subcommand/SubUsage data - no hand-maintained padding.
// Covers the arg-parsing helpers moved verbatim from bin/thatch.
import { describe, test, expect } from "bun:test";
import { renderGlobal, renderCommand } from "../src/cli/help";
import type { FlagSpec, Subcommand, SubUsage } from "../src/cli/types";
import { flagValue, flagValues } from "../src/cli/args";

function fakeCmd(name: string, summary: string, usage: SubUsage, children?: Subcommand[]): Subcommand {
  return { name, summary, usage: () => usage, run: async () => {}, children };
}

describe("renderGlobal", () => {
  test("opens with USAGE and lists every registered subcommand with its summary", () => {
    const out = renderGlobal([
      fakeCmd("stores", "List all stores", { synopsis: "thatch stores", flags: [] }),
      fakeCmd("show", "Display a memory by label", { synopsis: "thatch show <label> [store]", flags: [] }),
    ]);
    expect(out).toInclude("USAGE");
    expect(out).toInclude("thatch stores");
    expect(out).toInclude("List all stores");
    expect(out).toInclude("thatch show");
    expect(out).toInclude("Display a memory by label");
  });

  test("presents the version and help forms alongside the subcommands", () => {
    const out = renderGlobal([fakeCmd("stores", "List all stores", { synopsis: "thatch stores", flags: [] })]);
    expect(out).toInclude("thatch --version, -v");
    expect(out).toInclude("Print version and exit");
    expect(out).toInclude("thatch -h, --help");
    expect(out).toInclude("thatch help [sub]");
  });

  test("keeps the store-default footer", () => {
    const out = renderGlobal([]);
    expect(out).toInclude("Stores default to the repo detected from git remote");
  });
});

describe("renderCommand", () => {
  test("shows the synopsis and the summary paragraph", () => {
    const cmd = fakeCmd("show", "Display a memory by label", {
      synopsis: "thatch show <label> [store]",
      flags: [],
    });
    const out = renderCommand(cmd);
    expect(out).toInclude("USAGE");
    expect(out).toInclude("thatch show <label> [store]");
    expect(out).toInclude("Display a memory by label");
  });

  test("renders flag pairs, long-only, and short-only forms in one aligned table", () => {
    const flags: FlagSpec[] = [
      { long: "--store", short: "-s", description: "Store to use" },
      { long: "--json", short: null, description: "JSON output" },
      { long: null, short: "-v", description: "Verbose" },
    ];
    const out = renderCommand(fakeCmd("x", "summary", { synopsis: "thatch x", flags }));
    expect(out).toInclude("FLAGS");
    expect(out).toInclude("--store, -s");
    expect(out).toInclude("--json");
    expect(out).toInclude("-v");
  });

  test("omits the FLAGS section when the command has no flags", () => {
    const out = renderCommand(fakeCmd("stores", "List all stores", { synopsis: "thatch stores", flags: [] }));
    expect(out).not.toInclude("FLAGS");
  });

  test("renders note paragraphs after the flags", () => {
    const out = renderCommand(
      fakeCmd("remember", "Save a memory", {
        synopsis: "thatch remember <content>",
        flags: [{ long: "--label", short: "-l", description: "Label" }],
        notes: ["Content as arguments or piped on stdin."],
      }),
    );
    const flagsIdx = out.indexOf("FLAGS");
    const notesIdx = out.indexOf("Content as arguments or piped on stdin.");
    expect(flagsIdx).toBeGreaterThan(-1);
    expect(notesIdx).toBeGreaterThan(flagsIdx);
  });

  test("a namespace lists its children", () => {
    const chat = fakeCmd("chat", "Cross-session chat", { synopsis: "thatch chat <sub>", flags: [] }, [
      fakeCmd("list", "Registered chat sessions", { synopsis: "thatch chat list", flags: [] }),
      fakeCmd("tail", "Follow cross-session chat", { synopsis: "thatch chat tail", flags: [] }),
    ]);
    const out = renderCommand(chat);
    expect(out).toInclude("SUBCOMMANDS");
    expect(out).toInclude("list");
    expect(out).toInclude("Registered chat sessions");
    expect(out).toInclude("tail");
  });

  test("wraps a long description with a hanging indent under the description column", () => {
    const long = "This description runs well past the render width so the renderer must break it across lines.";
    const flags: FlagSpec[] = [
      { long: "--store", short: null, description: long },
    ];
    const out = renderCommand(fakeCmd("x", "summary", { synopsis: "thatch x", flags }));
    const lines = out.split("\n");
    const firstDescLine = lines.findIndex((l) => l.includes("This description"));
    expect(firstDescLine).toBeGreaterThan(-1);
    const cont = lines[firstDescLine + 1];
    // The continuation aligns under the description column ("  " + form
    // width + two spaces), and the broken text continues there.
    expect(cont.startsWith("        ")).toBe(true);
  });
});

describe("arg helpers", () => {
  test("flagValue reads the space form and the = form", () => {
    expect(flagValue(["-s", "abc"], "-s", "--session")).toBe("abc");
    expect(flagValue(["--session=abc"], "-s", "--session")).toBe("abc");
    expect(flagValue(["--other"], "-s", "--session")).toBeUndefined();
  });

  test("flagValues collects every occurrence", () => {
    expect(flagValues(["--match", "a", "--match=b", "--match", "c"], "--match")).toEqual(["a", "b", "c"]);
  });
});
