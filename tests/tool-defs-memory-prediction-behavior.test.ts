// The memory, prediction, and behavior tool execute functions, plus the
// formatAge prose helper they render.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { TOOL_DEFS, formatAge, MEMORY_SAVED_MARKER, MEMORY_FORGOTTEN_MARKER } from "../src/tool-defs";
import { setupToolDefsHarness, ctx, db, model, dbPath, defaultStore } from "./mocks/tool-defs-harness";

setupToolDefsHarness();

describe("tool-defs execute functions", () => {
  test("memory_remember saves and returns confirmation", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ label: "Test", content: "Content" }, ctx);
    expect(result).toContain("[saved]");
    expect(result).toContain("Test");
  });

  test("memory_remember derives label from leading heading when label omitted", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute(
      { content: "# Derived heading\n\nBody text here." }, ctx,
    );
    expect(result).toContain("[saved]");
    expect(result).toContain("Derived heading");
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const entry = await show.execute({ label: "Derived heading" }, ctx);
    // The heading becomes the label header and is not duplicated in content.
    expect(entry).toContain("Body text here.");
    expect(entry).not.toContain("# Derived heading\n\n# Derived heading");
  });

  test("memory_remember derives label from first line without a heading", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute(
      { content: "First line stands in as the label\n\nMore body." }, ctx,
    );
    expect(result).toContain("[saved]");
    expect(result).toContain("First line stands in as the label");
  });

  test("memory_remember heading-only content keeps the entry non-empty", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ content: "# Solo heading" }, ctx);
    expect(result).toContain("[saved]");
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const entry = await show.execute({ label: "Solo heading" }, ctx);
    // The heading text doubles as the body so the entry is never empty:
    // stored content is the label header followed by the body text.
    expect(entry).toContain("# Solo heading\n\nSolo heading");
  });

  test("memory_remember truncates a derived label to 80 characters", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const longLine = "x".repeat(120);
    const result = await def.execute({ content: longLine }, ctx);
    expect(result).toContain("[saved]");
    expect(result).toContain("x".repeat(80));
    expect(result).not.toContain("x".repeat(81));
  });

  test("memory_remember overwrite on a derived label upserts instead of duplicating", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const content = "# Derived overwrite\n\nbody";
    await def.execute({ content }, ctx);
    const again = await def.execute({ content, overwrite: true }, ctx);
    expect(again).toContain("[saved]");
    const list = await TOOL_DEFS.find((t) => t.name === "memory_list")!.execute({}, ctx);
    expect(list.split("\n").filter((l) => l.includes("Derived overwrite")).length).toBe(1);
  });

  test("memory_remember without content returns guidance instead of throwing", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ label: "Orphan" }, ctx);
    expect(result).toContain("content parameter");
  });

  test("memory_remember with an empty args object returns guidance and saves nothing", async () => {
    // Simulates the production failure class: a misnamed content key (e.g.
    // "text") is stripped by schema validation, so execute sees {}. The
    // schema-optional content lets this reach the teaching message instead
    // of dying at the host with "Missing key".
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("content parameter");
    expect(db.listEntries(defaultStore).length).toBe(0);
  });

  test("memory_remember success output is built from the shared save marker", async () => {
    // The runtime hook gates extraction draining on MEMORY_SAVED_MARKER.
    // Asserting via the constant (not a literal) catches someone editing
    // the output string away from the constant, which would silently
    // stall the buffer drain.
    const def = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const result = await def.execute({ label: "Marker check", content: "body" }, ctx);
    expect(result.startsWith(MEMORY_SAVED_MARKER)).toBe(true);
  });

  test("memory_show without a label returns guidance instead of crashing", async () => {
    // Without the guard, an empty args object reaches db.slugify as an
    // undefined label and crashes on label.trim() - a TypeError, not a
    // teachable error.
    const def = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("No label provided");
    expect(result).toContain("memory_list");
  });

  test("memory_forget without a label returns guidance instead of crashing", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "memory_forget")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("No label provided");
    expect(result).toContain("memory_list");
  });

  test("empty or whitespace labels on show and forget return guidance", async () => {
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const forget = TOOL_DEFS.find((t) => t.name === "memory_forget")!;
    expect(await show.execute({ label: "   " }, ctx)).toContain("No label provided");
    expect(await forget.execute({ label: "" }, ctx)).toContain("No label provided");
  });

  test("memory_forget success output is built from the shared forgotten marker", async () => {
    await TOOL_DEFS.find((t) => t.name === "memory_remember")!
      .execute({ label: "Doomed", content: "body" }, ctx);
    const forget = TOOL_DEFS.find((t) => t.name === "memory_forget")!;
    const result = await forget.execute({ label: "Doomed" }, ctx);
    expect(result.startsWith(MEMORY_FORGOTTEN_MARKER)).toBe(true);
  });

  test("misnamed keys are stripped by validation and routed to the teaching guards", async () => {
    // The production shape: { text: "..." } instead of content, or { id: "..." }
    // instead of label. z.object strips unknown keys, so the parsed args are
    // empty and execute's guards teach the right shape.
    const { z } = await import("zod");
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const parsedRemember = z.object(remember.args).parse({ text: "hello" });
    expect(await remember.execute(parsedRemember, ctx)).toContain("content parameter");
    const parsedShow = z.object(show.args).parse({ id: "some-label" });
    expect(await show.execute(parsedShow, ctx)).toContain("No label provided");
    expect(db.listEntries(defaultStore).length).toBe(0);
  });

  test("memory_recall returns matches", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Alpha", content: "Alpha content" }, ctx);
    const result = await recall.execute({ query: "Alpha" }, ctx);
    expect(result).not.toBe("No matching memories found.");
  });

  test("memory_recall output carries the point-in-time caveat and age prose", async () => {
    // Wording-specific assertions are intentional: the caveat is a fixed
    // contract string (its lines are concatenated, so rewrapping the source
    // must not rewrap the rendered output these assertions pin).
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Caveat Me", content: "Caveat content" }, ctx);
    const result = await recall.execute({ query: "Caveat" }, ctx);
    expect(result).toContain("point-in-time record");
    expect(result).toContain("not a source of truth");
    expect(result).toContain("memory_remember");
    expect(result).toContain("This memory was last updated");
  });

  test("age prose keys on updated_at, not last_recalled_at", async () => {
    // Regression guard for the branch's core read-side claim: a memory
    // recalled moments ago but last written 47 days ago must render the
    // write-side age. Swapping the argument for last_recalled_at would
    // render "just now" and fail here.
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    await remember.execute({ label: "Backdated", content: "Old claim" }, ctx);
    const raw = new Database(dbPath);
    raw.run("UPDATE entries SET updated_at = ? WHERE store = ? AND label = ?", [
      new Date(Date.now() - 47 * 86_400_000).toISOString(),
      defaultStore,
      "Backdated",
    ]);
    raw.close();
    const result = await show.execute({ label: "Backdated" }, ctx);
    expect(result).toContain("47 days ago");
    expect(result).not.toContain("just now");
  });

  test("memory_show output carries the caveat; memory_list does not", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const list = TOOL_DEFS.find((t) => t.name === "memory_list")!;
    await remember.execute({ label: "Caveat Show", content: "Caveat content" }, ctx);
    const shown = await show.execute({ label: "Caveat Show" }, ctx);
    expect(shown).toContain("point-in-time record");
    expect(shown).toContain("This memory was last updated");
    const listed = await list.execute({}, ctx);
    expect(listed).not.toContain("point-in-time record");
  });

  test("memory_recall without results carries no caveat", async () => {
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    const result = await recall.execute(
      { query: "nothing matches here", store: "empty-store" }, ctx,
    );
    expect(result).toBe("No matching memories found.");
  });

  test("store_list includes global", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "store_list")!;
    const result = await def.execute({}, ctx);
    expect(result).toContain("global");
  });

  test("find_duplicates returns no candidates for clean store", async () => {
    const def = TOOL_DEFS.find((t) => t.name === "find_duplicates")!;
    const result = await def.execute({ threshold: 0.9 }, ctx);
    expect(result).toContain("No duplicate candidates");
  });

  test("memory_remember returns error updating archived entry without archived param", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    await remember.execute({ label: "ArchTest", content: "Orig", archived: true }, ctx);
    const result = await remember.execute({
      label: "ArchTest", content: "Updated", overwrite: true,
    }, ctx);
    expect(result).toContain("archived");
  });

  test("memory_remember retains archived status when updating", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    await remember.execute({ label: "ArchTest", content: "Orig", archived: true }, ctx);
    await remember.execute({
      label: "ArchTest", content: "Updated", overwrite: true, archived: true,
    }, ctx);
    const show = TOOL_DEFS.find((t) => t.name === "memory_show")!;
    const entry = await show.execute({ label: "ArchTest" }, ctx);
    expect(entry).toContain("archived:true");
  });

  test("memory_recall excludes archived by default", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Active", content: "Active content" }, ctx);
    await remember.execute({ label: "Archived", content: "Archived content", archived: true }, ctx);
    const result = await recall.execute({ query: "content" }, ctx);
    expect(result).toContain("Active");
    expect(result).not.toContain("Archived");
  });

  test("memory_recall includeArchived surfaces archived", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const recall = TOOL_DEFS.find((t) => t.name === "memory_recall")!;
    await remember.execute({ label: "Active", content: "Active content" }, ctx);
    await remember.execute({ label: "Archived", content: "Archived content", archived: true }, ctx);
    const result = await recall.execute({ query: "content", includeArchived: true }, ctx);
    expect(result).toContain("Archived");
  });

  test("memory_list shows archived status", async () => {
    const remember = TOOL_DEFS.find((t) => t.name === "memory_remember")!;
    const list = TOOL_DEFS.find((t) => t.name === "memory_list")!;
    await remember.execute({ label: "Normal", content: "Content" }, ctx);
    await remember.execute({ label: "Old", content: "Old", archived: true }, ctx);
    const result = await list.execute({}, ctx);
    expect(result).not.toContain("Normal (archived)");
    expect(result).toContain("Old (archived)");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const ago = (days: number): string =>
    new Date(now.getTime() - days * 86_400_000).toISOString();

  test("renders boundary buckets in human-readable prose", () => {
    expect(formatAge(new Date(now.getTime() - 30_000).toISOString(), now)).toBe("just now");
    expect(formatAge(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago");
    expect(formatAge(new Date(now.getTime() - 3 * 3_600_000).toISOString(), now)).toBe("3 hours ago");
    expect(formatAge(new Date(now.getTime() - 47 * 86_400_000).toISOString(), now)).toBe("47 days ago");
    expect(formatAge(new Date(now.getTime() - 90 * 86_400_000).toISOString(), now)).toBe("3 months ago");
    expect(formatAge(ago(800), now)).toBe("2 years ago");
  });

  test("the month bucket covers the whole year gap - never '0 years ago'", () => {
    // months = floor(days/30) reaches 12 at day 360 while
    // years = floor(days/365) stays 0 until day 365; the month gate must
    // be keyed on days so the window renders as months, not zero years.
    expect(formatAge(ago(360), now)).toBe("12 months ago");
    expect(formatAge(ago(364), now)).toBe("12 months ago");
    expect(formatAge(ago(365), now)).toBe("1 year ago");
  });

  test("handles malformed input like the house sibling humanAge", () => {
    expect(formatAge("not-a-date", now)).toBe("unknown age");
  });

  test("uses singular for one unit", () => {
    expect(formatAge(new Date(now.getTime() - 60_000).toISOString(), now)).toBe("1 minute ago");
    expect(formatAge(ago(1), now)).toBe("1 day ago");
  });
});

// ---------------------------------------------------------------------------
// Prediction tool execute functions
// ---------------------------------------------------------------------------

describe("prediction tool execute functions", () => {
  const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

  test("prediction_update create seeds at p0 with 0 evidence", async () => {
    const result = await findTool("prediction_update").execute({
      matcher: "reviewing a PR with tech debt",
      prediction: "flag tech debt before reviewing the diff",
      signal: "create",
      rationale: "user asked to surface debt early",
    }, ctx);
    expect(result).toContain("[created]");
    expect(result).toContain("reviewing a PR with tech debt");

    // prediction_list should show it at p0 with 0 evidence
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("[0.50 conf, 0 tests]");
  });

  test("prediction_update confirm applies signal immediately on new prediction", async () => {
    const result = await findTool("prediction_update").execute({
      matcher: "writing error handling",
      prediction: "handle errors before happy paths",
      signal: "confirm",
      rationale: "user confirmed this preference",
    }, ctx);
    expect(result).toContain("[created + confirm]");
    // confidence = (1 + 5*0.5) / (1 + 0 + 5) = 0.583
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("[0.58 conf, 1 tests]");
  });

  test("prediction_update disconfirm on existing prediction lowers confidence", async () => {
    // Create + confirm first
    const created = await findTool("prediction_update").execute({
      matcher: "writing tests",
      prediction: "always write tests first",
      signal: "confirm",
      rationale: "user likes TDD",
    }, ctx);
    expect(created).toContain("(1/0)"); // 1 confirm, 0 disconfirm

    // Now disconfirm with same matcher text (dedup finds it)
    const result = await findTool("prediction_update").execute({
      matcher: "writing tests",
      prediction: "always write tests first",
      signal: "disconfirm",
      rationale: "user said not always",
    }, ctx);
    expect(result).toContain("[disconfirm]");
    expect(result).toContain("(1/1)"); // 1 confirm, 1 disconfirm
  });

  test("prediction_update create on existing prediction links without disconfirming", async () => {
    // Create a prediction with confirm
    const confirmed = await findTool("prediction_update").execute({
      matcher: "choosing variable names",
      prediction: "prefer descriptive names over short ones",
      signal: "confirm",
      rationale: "user prefers clarity",
    }, ctx);
    expect(confirmed).toContain("(1/0)"); // 1 confirm, 0 disconfirm

    // Call with signal=create and a DIFFERENT matcher that links to the same prediction
    const result = await findTool("prediction_update").execute({
      matcher: "choosing variable names in a function",
      prediction: "prefer descriptive names over short ones",
      signal: "create",
      rationale: "observed again in a new context",
    }, ctx);
    // Should link the new matcher, not disconfirm
    expect(result).toContain("[linked]");
    // Confidence should NOT have changed: still 1 confirm, 0 disconfirm
    expect(result).toContain("(1/0)");

    // prediction_list should show two matchers linked to the same prediction
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("choosing variable names");
    expect(list).toContain("choosing variable names in a function");
    // Provenance should have confirm + create, NOT disconfirm
    expect(list).toContain("confirm:");
    expect(list).toContain("create:");
    expect(list).not.toContain("disconfirm:");
  });

  test("prediction_update cross-store duplicate reinforces in its home store", async () => {
    // The preference already lives in global (the right home for a
    // user-wide preference). A later call that defaults to the project
    // store must reinforce the global row, not create a second copy that
    // the auto-fire (which scans both stores) would surface twice.
    await findTool("prediction_update").execute({
      matcher: "choosing how to report tool activity",
      prediction: "prefer toast notifications over in-chat messages",
      signal: "create",
      rationale: "user praised the toast pattern",
      store: "global",
    }, ctx);

    const result = await findTool("prediction_update").execute({
      matcher: "choosing how to report tool activity",
      prediction: "prefer toast notifications over in-chat messages",
      signal: "create",
      rationale: "observed again, defaulting to the project store",
    }, ctx);

    expect(result).toContain("global");
    expect(result).not.toContain("[created]");

    // Exactly one copy across the stores the auto-fire scans.
    const list = await findTool("prediction_list").execute({}, ctx);
    const occurrences = list.split("prefer toast notifications over in-chat messages").length - 1;
    expect(occurrences).toBe(1);
  });

  test("prediction_update with unknown default store falls back to global", async () => {
    const unknownCtx = { ...ctx, defaultStore: "unknown" };
    const result = await findTool("prediction_update").execute({
      matcher: "choosing a commit style",
      prediction: "prefer terse commit titles",
      signal: "create",
      rationale: "user stated the preference",
    }, unknownCtx);

    // The row must not land in a store no auto-fire scan can see.
    expect(result).toContain("[created] global ::");
    const list = await findTool("prediction_list").execute({}, unknownCtx);
    expect(list).toContain("prefer terse commit titles");
  });

  test("prediction_query returns matching predictions with 0-evidence verb", async () => {
    await findTool("prediction_update").execute({
      matcher: "deciding on test coverage",
      prediction: "aim for 90 percent coverage",
      signal: "create",
      rationale: "user stated preference",
    }, ctx);

    // Query with the same matcher text (MockEmbeddingModel: identical text → cosine 1.0)
    const result = await findTool("prediction_query").execute({
      context: "deciding on test coverage",
    }, ctx);
    expect(result).toContain("you may prefer"); // 0-evidence verb
    expect(result).toContain("aim for 90 percent coverage");
  });

  test("prediction_query returns no predictions for unrelated context", async () => {
    await findTool("prediction_update").execute({
      matcher: "database indexing strategy",
      prediction: "use composite indexes",
      signal: "create",
      rationale: "user said",
    }, ctx);

    const result = await findTool("prediction_query").execute({
      context: "designing a UI layout",
    }, ctx);
    expect(result).toContain("No matching predictions");
  });

  test("prediction_delete removes a prediction", async () => {
    await findTool("prediction_update").execute({
      matcher: "choosing a framework",
      prediction: "prefer minimal dependencies",
      signal: "create",
      rationale: "user said",
    }, ctx);

    const result = await findTool("prediction_delete").execute({
      statement: "prefer minimal dependencies",
    }, ctx);
    expect(result).toContain("[deleted]");

    // prediction_list should be empty now
    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("No predictions");
  });

  test("prediction_delete returns not-found for unknown statement", async () => {
    const result = await findTool("prediction_delete").execute({
      statement: "this prediction does not exist at all",
    }, ctx);
    expect(result).toContain("No prediction matching");
  });

  test("prediction_mark_checked records a verdict and the pair stops surfacing", async () => {
    const text = "prefer minimal dependencies";
    const embed = await model.passageEmbed(text);
    const idA = db.createPrediction(defaultStore, text, "first wording", embed, model.name);
    const idB = db.createPrediction(defaultStore, "keep the dependency list small", "reworded later", embed, model.name);

    // Identical embeddings -> cosine 1.0 -> one candidate pair.
    expect(db.findPredictionDuplicates(defaultStore).length).toBe(1);

    // Reversed argument order: the pair row is canonical (sorted ids), so
    // this must still suppress the pair.
    const result = await findTool("prediction_mark_checked").execute({
      id_a: idB,
      id_b: idA,
      status: "distinct",
    }, ctx);
    expect(result).toContain("[marked distinct]");
    expect(db.findPredictionDuplicates(defaultStore)).toEqual([]);
  });

  test("prediction_list includes provenance entries", async () => {
    await findTool("prediction_update").execute({
      matcher: "reviewing code",
      prediction: "check for null references",
      signal: "confirm",
      rationale: "user emphasized null safety",
    }, ctx);

    const list = await findTool("prediction_list").execute({}, ctx);
    expect(list).toContain("provenance:");
    expect(list).toContain("confirm:");
    expect(list).toContain("null safety");
  });
});

// ---------------------------------------------------------------------------
// Behavior tool execute functions
// ---------------------------------------------------------------------------

describe("behavior tool execute functions", () => {
  const findTool = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

  test("behavior_codify seeds at p0 with 0 evidence", async () => {
    const result = await findTool("behavior_codify").execute({
      situation: "about to commit changes to the thatch repo",
      behavior: "run mise run check before committing",
      rationale: "never commit code that fails the quality gate",
    }, ctx);
    expect(result).toContain("[codified]");
    expect(result).toContain("run mise run check before committing");

    const list = await findTool("behavior_list").execute({}, ctx);
    expect(list).toContain("[0.50 conf, 0 tests]");
  });

  test("behavior_codify links to existing behavior without duplicate", async () => {
    // Codify first
    const first = await findTool("behavior_codify").execute({
      situation: "investigating a new codebase",
      behavior: "use sub-agents to explore in parallel",
      rationale: "saves context window space",
    }, ctx);
    expect(first).toContain("[codified]");

    // Codify with a different situation that links to the same behavior
    const result = await findTool("behavior_codify").execute({
      situation: "starting a new ticket in an unfamiliar area",
      behavior: "use sub-agents to explore in parallel",
      rationale: "same discipline, new context",
    }, ctx);
    expect(result).toContain("[linked]");
    expect(result).toContain("(0/0)"); // confidence unchanged

    // behavior_list should show two matchers linked to the same behavior
    const list = await findTool("behavior_list").execute({}, ctx);
    expect(list).toContain("investigating a new codebase");
    expect(list).toContain("starting a new ticket in an unfamiliar area");
  });

  test("behavior_codify cross-store duplicate reinforces in its home store", async () => {
    await findTool("behavior_codify").execute({
      situation: "about to run a destructive shell command",
      behavior: "re-read the command for flags before pressing enter",
      rationale: "typo'd flags are how directories vanish",
      store: "global",
    }, ctx);

    const result = await findTool("behavior_codify").execute({
      situation: "about to run a destructive shell command",
      behavior: "re-read the command for flags before pressing enter",
      rationale: "same rule, defaulting to the project store",
    }, ctx);

    expect(result).toContain("global");
    expect(result).not.toContain("[codified] ");

    const list = await findTool("behavior_list").execute({}, ctx);
    const occurrences = list.split("re-read the command for flags before pressing enter").length - 1;
    expect(occurrences).toBe(1);
  });

  test("behavior_codify with unknown default store falls back to global", async () => {
    const unknownCtx = { ...ctx, defaultStore: "unknown" };
    const result = await findTool("behavior_codify").execute({
      situation: "about to run a destructive shell command",
      behavior: "re-read the command for flags before pressing enter",
      rationale: "user-agnostic discipline",
    }, unknownCtx);

    expect(result).toContain("[codified] global ::");
    const list = await findTool("behavior_list").execute({}, unknownCtx);
    expect(list).toContain("re-read the command for flags before pressing enter");
  });

  test("behavior_feedback ham confirms a behavior", async () => {
    await findTool("behavior_codify").execute({
      situation: "writing code comments",
      behavior: "write comments for a future coder who knows the stack",
      rationale: "narrate intent, not implementation",
    }, ctx);

    const result = await findTool("behavior_feedback").execute({
      behavior: "write comments for a future coder who knows the stack",
      relevant: true,
      context: "reviewing comment quality",
    }, ctx);
    expect(result).toContain("[confirm]");
    expect(result).toContain("(1/0)"); // 1 confirm, 0 disconfirm
  });

  test("behavior_feedback spam disconfirms a behavior", async () => {
    await findTool("behavior_codify").execute({
      situation: "choosing variable names",
      behavior: "prefer descriptive names over short ones",
      rationale: "clarity wins",
    }, ctx);

    const result = await findTool("behavior_feedback").execute({
      behavior: "prefer descriptive names over short ones",
      relevant: false,
      context: "rule fired but was not relevant here",
    }, ctx);
    expect(result).toContain("[disconfirm]");
    expect(result).toContain("(0/1)"); // 0 confirm, 1 disconfirm
  });

  test("behavior_delete removes a behavior", async () => {
    await findTool("behavior_codify").execute({
      situation: "choosing a testing strategy",
      behavior: "prefer integration tests over unit tests",
      rationale: "user said",
    }, ctx);

    const result = await findTool("behavior_delete").execute({
      statement: "prefer integration tests over unit tests",
    }, ctx);
    expect(result).toContain("[deleted]");

    const list = await findTool("behavior_list").execute({}, ctx);
    expect(list).toContain("No behaviors");
  });

  test("behavior_delete returns not-found for unknown statement", async () => {
    const result = await findTool("behavior_delete").execute({
      statement: "this behavior does not exist at all",
    }, ctx);
    expect(result).toContain("No behavior matching");
  });

  test("behavior_list includes provenance entries", async () => {
    await findTool("behavior_codify").execute({
      situation: "reviewing code for separation of concerns",
      behavior: "check for god modules before reviewing the diff",
      rationale: "SoC is the prime directive",
    }, ctx);

    const list = await findTool("behavior_list").execute({}, ctx);
    expect(list).toContain("provenance:");
    expect(list).toContain("codify:");
    expect(list).toContain("separation of concerns");
  });
});
