// Prompt/nudge unit tests from plugin.test.ts: the pure string builders in
// src/prompts (session-start reminders, recall nudges, prediction
// formatting, extraction escalation tiers and direct prompt). The harness
// boot preserves the fixture env the original file ran these under.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupPluginHarness, teardownPluginHarness } from "./mocks/plugin-harness";
import {
  sessionStartReminder,
  recallNudge,
  claudeRecallNudge,
  claudeSessionStartReminder,
  claudeWriteNudge,
  extractionNudge,
  extractionDirectPrompt,
  type NudgeMatch,
} from "../src/prompts";

beforeAll(async () => {
  await setupPluginHarness();
});

afterAll(() => {
  teardownPluginHarness();
});

// ---------------------------------------------------------------------------
// sessionStartReminder
// ---------------------------------------------------------------------------

describe("sessionStartReminder", () => {
  test("includes store name and recall instructions", () => {
    const reminder = sessionStartReminder("test-owner/test-repo");

    expect(reminder).toContain("[thatch]");
    expect(reminder).toContain("test-owner/test-repo");
    expect(reminder).toContain("thatch_memory_recall");
    expect(reminder).toContain("user preferences and personality");
    expect(reminder).toContain("project architecture and conventions");
    expect(reminder).toContain("thatch_store_list");
    expect(reminder).toContain("thatch_memory_list");
  });
});

// ---------------------------------------------------------------------------
// recallNudge / claudeRecallNudge
// ---------------------------------------------------------------------------

describe("recallNudge (opencode)", () => {
  test("single match uses singular form", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = recallNudge(matches);
    expect(nudge).toContain("1 memory relates to this prompt");
    expect(nudge).toContain('"Architecture"');
    expect(nudge).toContain("thatch_memory_recall");
    // The nudge teaches the argument shape: a bare positional string is the
    // most common first-call mistake (opencode DB analysis, Sept 2026).
    expect(nudge).toContain('({ query: "..." })');
    expect(nudge).toContain("never a bare positional string");
  });

  test("multiple matches use plural and show up to 2 labels", () => {
    const matches: NudgeMatch[] = [
      { label: "Architecture", score: 0.8 },
      { label: "Module map", score: 0.7 },
      { label: "Conventions", score: 0.65 },
    ];
    const nudge = recallNudge(matches);
    expect(nudge).toContain("3 memories relate to this prompt");
    expect(nudge).toContain('"Architecture"');
    expect(nudge).toContain('"Module map"');
    expect(nudge).toContain("etc.");
    expect(nudge).not.toContain('"Conventions"');
  });
});

describe("formatWhenLine prefix deduplication", () => {
  const { formatWhenLine, predictionVerb } = require("../src/prompts");

  test("does not double a matcher that already starts with When", () => {
    const line = formatWhenLine(0.56, 1, "When reviewing a tiny config PR", "prefer the existing pattern", "you tend to");
    expect(line).toContain("] When reviewing a tiny config PR:");
    expect(line).not.toContain("When When");
  });

  test("prepends When to a gerund matcher", () => {
    const line = formatWhenLine(0.56, 1, "Deciding how to show activity feedback", "prefer toast notifications", "you tend to");
    expect(line).toContain("] When Deciding how to show activity feedback: you tend to prefer toast notifications");
  });

  test("does not double a statement that already carries the evidence verb", () => {
    const line = formatWhenLine(0.56, 1, "Deciding how to show activity feedback", "you tend to prefer toast notifications", predictionVerb(1));
    expect(line).toContain(": you tend to prefer toast notifications");
    expect(line).not.toContain("you tend to you tend to");
  });

  test("0-evidence statements keep the hedged verb", () => {
    const line = formatWhenLine(0.5, 0, "Deciding how to show activity feedback", "prefer toast notifications", predictionVerb(0));
    expect(line).toContain("you may prefer");
  });
});

describe("claudeRecallNudge (Claude Code / Cursor)", () => {
  test("uses bare tool name without thatch_ prefix", () => {
    const matches: NudgeMatch[] = [{ label: "Architecture", score: 0.72 }];
    const nudge = claudeRecallNudge(matches);
    expect(nudge).toContain("memory_recall");
    expect(nudge).not.toContain("thatch_memory_recall");
    expect(nudge).toContain('({ query: "..." })');
  });
});

// ---------------------------------------------------------------------------
// claudeSessionStartReminder / claudeWriteNudge
// ---------------------------------------------------------------------------

describe("claudeSessionStartReminder", () => {
  test("includes repo name and bare tool names (no thatch_ prefix)", () => {
    const reminder = claudeSessionStartReminder("owner/repo");
    expect(reminder).toContain("[thatch]");
    expect(reminder).toContain("owner/repo");
    expect(reminder).toContain("store_list");
    expect(reminder).toContain("memory_list");
    expect(reminder).toContain("memory_recall");
    expect(reminder).not.toContain("thatch_store_list");
    expect(reminder).not.toContain("thatch_memory_list");
    expect(reminder).not.toContain("thatch_memory_recall");
  });

  test("without hygiene returns just the base text", () => {
    const reminder = claudeSessionStartReminder("owner/repo");
    expect(reminder).not.toContain("[thatch hygiene]");
  });

  test("with null hygiene returns just the base text", () => {
    const reminder = claudeSessionStartReminder("owner/repo", null);
    expect(reminder).not.toContain("[thatch hygiene]");
  });

  test("with hygiene appends the hygiene block with bare tool names", () => {
    const reminder = claudeSessionStartReminder("owner/repo", "Store x: 2 duplicate-candidate pairs");
    expect(reminder).toContain("[thatch hygiene]");
    expect(reminder).toContain("Store x: 2 duplicate-candidate pairs");
    expect(reminder).toContain("find_duplicates");
    expect(reminder).toContain("memory_show");
    expect(reminder).not.toContain("thatch_find_duplicates");
    expect(reminder).not.toContain("thatch_memory_show");
  });
});

describe("claudeWriteNudge", () => {
  test("returns the after-responding check prompt", () => {
    const nudge = claudeWriteNudge();
    expect(nudge).toContain("[thatch]");
    expect(nudge).toContain("After responding");
    expect(nudge).toContain("save to thatch");
  });
});

describe("extractionNudge escalation (MCP hosts only)", () => {
  const sessionID = "sess-abc";

  test("tier 0 (missedCount 0-1): leads with sub-agent dispatch wording", () => {
    const nudge = extractionNudge(3, 0, sessionID);
    expect(nudge).toContain("Spawn a background sub-agent");
    expect(nudge).not.toContain("background: true");
    expect(nudge).not.toContain("subagent_type");
    expect(nudge).toContain("mcp__thatch__extraction_done");
    expect(nudge).toContain("not user input");
    expect(nudge).toContain("continue waiting");
    expect(nudge).not.toContain("YOU HAVE NOT");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 0 includes session ID and fetch tool name, not payload", () => {
    const nudge = extractionNudge(3, 0, sessionID);
    expect(nudge).toContain(sessionID);
    expect(nudge).toContain("mcp__thatch__get_extraction_payload");
    expect(nudge).not.toContain('"interactions"');
    expect(nudge).not.toContain('"projectStore"');
  });

  test("tier 1 (missedCount 2): directive prefix, no shouting", () => {
    const nudge = extractionNudge(3, 2, sessionID);
    expect(nudge).toContain("YOU HAVE NOT PROCESSED");
    expect(nudge).not.toContain("IGNORING");
  });

  test("tier 2 (missedCount 3+): all caps, harsh", () => {
    const nudge = extractionNudge(3, 3, sessionID);
    expect(nudge).toContain("IGNORING EXTRACTION INSTRUCTIONS");
    expect(nudge).toContain("INSTALLED THIS PLUGIN FOR A REASON");
  });

  test("tier 2 escalates further with higher counts", () => {
    const nudge = extractionNudge(5, 10, sessionID);
    expect(nudge).toContain("IGNORING");
  });

  test("all tiers include the session ID (case-insensitive for ALL-CAPS tier)", () => {
    for (const missed of [0, 2, 3]) {
      const nudge = extractionNudge(1, missed, sessionID);
      expect(nudge.toLowerCase()).toContain(sessionID.toLowerCase());
    }
  });

  test("no tier includes the raw JSON payload", () => {
    for (const missed of [0, 2, 3]) {
      const nudge = extractionNudge(1, missed, sessionID);
      expect(nudge).not.toContain('"interactions"');
      expect(nudge).not.toContain('"projectStore"');
      expect(nudge).not.toContain('"globalStore"');
    }
  });
});

describe("extractionDirectPrompt", () => {
  const sessionID = "sess-direct";

  test("tells the model to run the skill directly, no task dispatch", () => {
    const prompt = extractionDirectPrompt(3, sessionID);
    expect(prompt).toContain("thatch-fact-extractor");
    expect(prompt).toContain("thatch_memory_remember");
    expect(prompt).toContain("thatch_extraction_done");
    expect(prompt).not.toContain("Dispatch a task");
    expect(prompt).not.toContain("background: true");
  });

  test("includes the session ID and fetch tool name", () => {
    const prompt = extractionDirectPrompt(1, sessionID);
    expect(prompt).toContain(sessionID);
    expect(prompt).toContain("thatch_get_extraction_payload");
  });

  test("does not include the raw JSON payload", () => {
    const prompt = extractionDirectPrompt(1, sessionID);
    expect(prompt).not.toContain('"interactions"');
    expect(prompt).not.toContain('"projectStore"');
  });

  test("singular form for one interaction", () => {
    const prompt = extractionDirectPrompt(1, sessionID);
    expect(prompt).toContain("1 queued tool interaction.");
    expect(prompt).not.toContain("1 queued tool interactions");
  });

  test("plural form for multiple interactions", () => {
    const prompt = extractionDirectPrompt(5, sessionID);
    expect(prompt).toContain("5 queued tool interactions");
  });
});
