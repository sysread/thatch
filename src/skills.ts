import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillFile {
  name: string;
  path: string;
  content: string;
}

/**
 * Writes thatch skill files into the given skills directory. Called at plugin
 * init — idempotent, and rewrites a skill whose on-disk content has drifted so
 * plugin upgrades propagate. These files are plugin-owned: local edits are
 * overwritten on next init.
 */
export function installSkills(skillsDir: string): SkillFile[] {
  mkdirSync(skillsDir, { recursive: true });
  const written: SkillFile[] = [];

  for (const skill of SKILLS) {
    const dir = join(skillsDir, skill.name);
    const file = join(dir, "SKILL.md");

    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // missing file — first install
    }

    if (current !== skill.content) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, skill.content);
      written.push({ name: skill.name, path: file, content: skill.content });
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Skill definitions
// ---------------------------------------------------------------------------

const FACT_EXTRACTOR = `---
name: thatch-fact-extractor
description: Extract durable project facts, user preferences, and environment knowledge from recent tool interactions. Use when thatch reports queued tool interactions needing extraction.
---

You are the Thatch Fact Extractor. Your job: review recent tool interactions and extract durable project knowledge to persist across sessions.

You will be given a JSON payload with:
  - "interactions": recent tool calls and their results (tool name, args, truncated output)
  - "projectStore": the current project's store name (e.g., "sysread/thatch")
  - "globalStore": "global"

## Instructions

1. Call thatch_memory_recall to check for existing memories related to the interactions.
2. For each new fact, call thatch_memory_remember with the appropriate store.
3. Do not save session-specific state, ephemeral debugging details, or info already in CLAUDE.md.
4. Write for a future session with zero current context. No "we", "our session", "just now".

## What to extract

- Project architecture, conventions, patterns discovered through tool use
- Non-obvious gotchas and pitfalls (especially ones that took time to debug)
- User preferences, communication style, explicit corrections, pet peeves
- Shell/environment quirks (tool friction, missing commands, platform issues)
- Bug shapes: the abstract pattern behind a fix, not the specific bug context

## Store assignment

- global store: user preferences, personality traits, communication style, environment quirks
- Project store: architecture, conventions, patterns, project-specific gotchas

## Writing good memories

- One topic per memory. Several specific memories over one sprawling one.
- Labels: short descriptive titles (5-8 words).
- Content: self-contained, 2-5 sentences.
- If updating an existing memory, use overwrite: true.
- Confidence (1-10): 1-3 weak signal, 5-6 moderate evidence, 7-8 strong pattern, 9 explicitly stated.`;

const DEDUP_CLASSIFIER = `---
name: thatch-dedup-classifier
description: Classify the relationship between two similar memory entries for deduplication. Use when thatch_find_duplicates identifies candidate pairs.
---

You are a memory deduplication classifier. Given similar memories surfaced by
thatch_find_duplicates (as pairs, grouped into clusters), decide their
relationships and emit actions.

## Instructions

1. Read every memory in the pair or cluster with thatch_memory_show.
2. Classify the relationships.
3. Use thatch_memory_forget to remove duplicates.
4. Use thatch_memory_remember with overwrite: true to update supplemented memories.
5. For pairs you are NOT deleting (supplement, contradiction, unrelated), call
   thatch_dedup_mark_checked with the verdict so the pair stops being re-reported.
6. Call thatch_find_duplicates again afterward to verify the store is clean.

## Clusters (3+ related memories)

A cluster usually means one topic fragmented across entries. Consolidate:
rewrite the cluster as ONE self-contained memory under the best label
(thatch_memory_remember with overwrite: true), preserving every distinct fact,
then thatch_memory_forget the rest. If a cluster mixes topics, split it into
per-topic consolidations, and mark the residual cross-topic pairs checked as
"unrelated".

## Write-time warnings

thatch_memory_remember may warn that a just-saved memory resembles existing
ones. Treat that warning as a one-pair version of this workflow: read the
listed memories and reconcile immediately — merge, or mark the pair checked.

## Relationship types

- **duplicate**: Both memories say essentially the same thing. Delete the less detailed one, or merge content and re-save the better one.
- **supplement**: One memory adds useful context to the other. Update the primary one with the supplement's content, delete the supplement.
- **contradiction**: The memories make incompatible claims. Keep both, note the contradiction in a new memory.
- **unrelated**: Different topics despite high embedding similarity. No action needed.`;

const SKILLS = [
  { name: "thatch-fact-extractor", content: FACT_EXTRACTOR },
  { name: "thatch-dedup-classifier", content: DEDUP_CLASSIFIER },
];
