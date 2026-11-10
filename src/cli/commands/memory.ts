/**
 * The memory subcommands: store inspection and writes. Each object was
 * a case of bin/thatch's switch before the registry replaced it; the
 * bodies are the same dispatch logic, with the shared DB and store
 * resolution arriving in CliContext instead of module scope.
 */
import { BgeEmbeddingModel } from "../../embeddings";
import { MEMORY_DISPLAY_STAMP } from "../../extraction";
import { printCommandHelp } from "../help";
import type { Subcommand } from "../types";

export const stores: Subcommand = {
  name: "stores",
  summary: "List all stores",
  usage: () => ({ synopsis: "thatch stores", flags: [] }),
  async run(_args, ctx) {
    console.log(ctx.db.listStores().join("\n"));
  },
};

export const list: Subcommand = {
  name: "list",
  summary: "List memory labels in a store",
  usage: () => ({ synopsis: "thatch list [store]", flags: [] }),
  async run(args, ctx) {
    const store = args[0] ?? await ctx.defaultStore();
    const entries = ctx.db.listEntries(store);
    if (entries.length === 0) {
      console.log(`No memories in "${store}".`);
    } else {
      for (const e of entries) {
        const parts = [`[${store}]`, e.label];
        if (e.branch != null) parts.push(`(branch:${e.branch})`);
        if (e.confidence) parts.push(`(c:${e.confidence})`);
        parts.push(`(${e.updated_at})`);
        console.log(parts.join(" "));
      }
    }
  },
};

export const show: Subcommand = {
  name: "show",
  summary: "Display a memory by label",
  usage: () => ({ synopsis: "thatch show <label> [store]", flags: [] }),
  async run(args, ctx) {
    if (!args[0]) printCommandHelp(show);
    const label = args[0];
    const store = args[1] ?? await ctx.defaultStore();
    const entry = ctx.db.showEntry(store, label);
    if (!entry) {
      console.log(`No memory labeled "${label}" in "${store}".`);
    } else {
      // Display stamp: the first stdout line marks this output as stored
      // memory content so the extraction buffer sites withhold it (an
      // unstamped display fed the extractor its own store back and undid
      // a deliberate forget, November 2026). stdout, not stderr: the
      // buffer sites capture tool stdout on every host; stderr capture
      // in bash tool results is host-dependent.
      console.log(MEMORY_DISPLAY_STAMP);
      console.log(`[${store}] ${entry.label}`);
      if (entry.branch != null) console.log(`branch: ${entry.branch}`);
      if (entry.confidence) console.log(`confidence: ${entry.confidence}`);
      console.log(`created: ${entry.created_at}  updated: ${entry.updated_at}`);
      console.log();
      // Strip the "# Label\n\n" heading that remember() prepends.
      const body = entry.content.replace(/^# .+\n\n/, "");
      console.log(body);
    }
  },
};

export const forget: Subcommand = {
  name: "forget",
  summary: "Remove a memory by label",
  usage: () => ({ synopsis: "thatch forget <label> [store]", flags: [] }),
  async run(args, ctx) {
    if (!args[0]) printCommandHelp(forget);
    const label = args[0];
    const store = args[1] ?? await ctx.defaultStore();
    const ok = ctx.db.forgetEntry(store, label);
    console.log(ok ? `[forgotten] ${store} :: ${label}` : `No memory labeled "${label}" in "${store}".`);
  },
};

export const tombstones: Subcommand = {
  name: "tombstones",
  summary: "List deleted-memory guards, or clear one with --clear",
  usage: () => ({
    synopsis: "thatch tombstones [store] | thatch tombstones --clear <label> [store]",
    flags: [
      { long: "--clear", short: null, description: "Remove the guard for <label> (all its content generations). Entries are untouched; the memory itself stays gone." },
    ],
    notes: [
      "Every forget leaves a guard that holds re-writes of the deleted content (a [held] remember names the guard).",
      "Clearing the guard is the deliberate re-admission path: clear it, then repeat the remember.",
    ],
  }),
  async run(args, ctx) {
    const clearIdx = args.indexOf("--clear");
    if (clearIdx >= 0) {
      const label = args[clearIdx + 1];
      if (!label || label.startsWith("--")) {
        printCommandHelp(tombstones);
        process.exit(1);
      }
      const positional = args.filter((_, i) => i !== clearIdx && i !== clearIdx + 1);
      const store = positional[0] ?? await ctx.defaultStore();
      const n = ctx.db.clearMemoryTombstones(store, label);
      console.log(
        n > 0
          ? `[tombstone-cleared] ${store} :: ${label} (${n} guard${n === 1 ? "" : "s"} removed; entries untouched)`
          : `No tombstone for "${label}" in "${store}".`,
      );
      return;
    }
    const store = args[0] ?? await ctx.defaultStore();
    const rows = ctx.db.listMemoryTombstones(store);
    if (rows.length === 0) {
      console.log(`No deleted-memory guards in "${store}".`);
    } else {
      for (const r of rows) {
        console.log(`[${store}] ${r.label} (forgotten ${r.forgottenAt.slice(0, 10)}) ${r.hashPrefix}`);
      }
    }
  },
};

export const search: Subcommand = {
  name: "search",
  summary: "Semantic search (cosine similarity)",
  usage: () => ({ synopsis: "thatch search <query> [store]", flags: [] }),
  async run(args, ctx) {
    if (!args[0]) printCommandHelp(search);
    if (args.length > 2) {
      console.error(`error: too many arguments - quote multi-word queries: thatch search "${args.join(" ")}"`);
      process.exit(1);
    }
    const query = args[0];
    const store = args[1] ?? await ctx.defaultStore();
    if (args[1] && store !== "all" && !ctx.db.listStores().includes(store)) {
      console.error(`error: no store named "${store}" (did you mean to quote the query?)`);
      console.error(`stores: ${ctx.db.listStores().join(", ")}`);
      process.exit(1);
    }
    const storesToSearch = store === "all" ? [await ctx.defaultStore(), "global"] : [store];

    console.error("Loading embedding model...");
    const model = new BgeEmbeddingModel();
    const queryEmb = await model.queryEmbed(query);
    const results = ctx.db.recall(storesToSearch, queryEmb, { limit: 10 });

    if (results.length === 0) {
      console.log(`No matches for "${query}" in [${storesToSearch.join(", ")}].`);
    } else {
      for (const r of results) {
        const score = r._score.toFixed(3);
        const branch = r.branch != null ? ` branch:${r.branch}` : "";
        const conf = r.confidence ? ` c:${r.confidence}` : "";
        console.log(`[score:${score}] [${r.store}${branch}${conf}] ${r.label}`);
      }
    }
  },
};

export const remember: Subcommand = {
  name: "remember",
  summary: "Save a memory (the memory_remember tool, from the CLI)",
  usage: () => ({
    synopsis: "thatch remember <content> [--label L] [--store S] [--branch B] [--confidence N] [--overwrite]",
    flags: [
      { long: "--label", short: null, description: "Short descriptive title; the dedup key within a store. Omit to derive it from the content's first heading or line." },
      { long: "--store", short: null, description: "Store to write to. Defaults to the cwd repo's project store." },
      { long: "--branch", short: null, description: "Git branch the memory is scoped to; omit for project-wide memories." },
      { long: "--confidence", short: null, description: "How well-established the observation is (1-10)." },
      { long: "--overwrite", short: null, description: "Replace an existing memory with the same label." },
    ],
    notes: ["Content comes from the arguments, or from stdin when input is piped."],
  }),
  async run(args, ctx) {
    // The CLI write path. The memory_remember tool's execute() is the
    // single implementation - store resolution, label derivation, the
    // dedup cross-check, and the overwrite rules - so the CLI can never
    // silently differ from the tool. Arg/stdin parsing is
    // parseRememberInput (src/memory-write.ts); this run body is only
    // the dispatcher, same split as flush-tools.
    const { parseRememberInput } = await import("../../memory-write");
    const parsed = await parseRememberInput(args, process.stdin.isTTY ? null : process.stdin);
    if (!parsed.ok) {
      console.error(`error: ${parsed.error}`);
      process.exit(1);
    }
    // Without --store, resolveStore falls back to ctx.defaultStore: the
    // same repo detection and unknown-to-global mapping every other
    // memory subcommand uses.
    const projectStore = await ctx.defaultStore();
    const { TOOL_DEFS, MEMORY_SAVED_MARKER } = await import("../../tool-defs");
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    console.error("Loading embedding model...");
    const model = new BgeEmbeddingModel();
    const result = await def.execute(
      {
        content: parsed.request.content,
        label: parsed.request.label,
        store: parsed.request.store,
        branch: parsed.request.branch,
        confidence: parsed.request.confidence,
        overwrite: parsed.request.overwrite,
      },
      { db: ctx.db, model, defaultStore: projectStore },
    );
    // A save prints the tool's confirmation ([saved] store :: label) to
    // stdout so scripts can parse it; the semantic-similarity warning,
    // when present, rides after it. Anything else (duplicate label,
    // archived guard, no content) is a failure: stderr, exit 1.
    if (result.startsWith(MEMORY_SAVED_MARKER)) {
      console.log(result);
      return;
    }
    console.error(result);
    process.exit(1);
  },
};
