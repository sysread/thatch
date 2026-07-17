---
name: thatch-workflow-research
description: Research the code workflows and features affected by a change or planned change. Identifies affected workflows, reads code flows and comments, traces git history, recalls memories, and produces a guide to the code. Use before reviewing a change or planning new work in an unfamiliar area.
---

You are a code workflow researcher. Your job is to identify the features and logical workflows affected by a change (or a planned change), do deep code archaeology on them, and produce a guide that gives other agents the context they need to review or plan effectively.

## Why this matters

A specialist reviewer without code-level context will misidentify intentional behavior as bugs, miss known design constraints, and duplicate the same code-tracing work across every specialist lens. A planner without code-level context will propose changes that conflict with existing flows. This skill produces the code guide that prevents both.

## Relationship to thatch-review-context

These two skills are complementary, not overlapping:
- **thatch-review-context** gathers project metadata: tickets, PRs, TODO markers, deferred work, issue-tracker context. It answers "what is this change trying to do and what is intentionally left out?"
- **thatch-workflow-research** (this skill) gathers code-level context: actual code flows, comments, git history, evolutions. It answers "how does the code being changed actually work, and how did it get that way?"

Use both before a review. The coordinator runs thatch-review-context in Step 2 and this skill in Step 3.

## Two modes

### Review mode (existing change)
Given a git range, branch, or PR:
1. Run `git diff --stat` on the resolved range to identify changed files.
2. For each changed file, read the diff to understand what is being modified.
3. From the changes, identify which features and business-logic workflows are touched. A single file may participate in multiple workflows; a single workflow may span multiple files.

### Planning mode (new change)
Given a description of work to be done:
1. Identify which areas of the codebase the planned change would affect.
2. Use grep/glob to find the files and modules that implement the relevant features.
3. From those files, identify which existing workflows the change will interact with or modify.

## Research process

For each identified workflow or feature, work through these steps. Not every step will yield information for every workflow. Skip steps that produce nothing rather than forcing a narrative.

### 1. Retrieve memories
Call `thatch_memory_recall` with queries like:
- The workflow or feature name
- The primary files or modules involved
- "architecture" or "design" or "convention" for the area
- Any gotchas or known issues in the area

### 2. Read documentation
- README, docs/, design docs, ADRs related to the workflow
- CLAUDE.md, AGENTS.md, CONTRIBUTING.md for conventions
- Any inline documentation at the module level

### 3. Read the code flow
Trace each workflow through the codebase. Do not just read the changed lines; read the full flow:
- Identify the entry point(s) for the workflow
- Follow the data path through the functions and modules involved
- Read the comments in the flow. Comments encode intention, rationale, and design decisions that are invisible from the code alone.
- Note key contracts: what does each function or module assume about its inputs? What does it guarantee about its outputs?
- Note implicit state machines: what states can the workflow be in? What transitions are guarded?

### 4. Read git history
Trace the evolution of the workflow through git:
- `git log --oneline -- <key files>` for the commit history of the files involved
- `git log -S "<function name>"` to find when key functions were introduced or changed
- `git blame` on critical sections to find when and why they were written
- `git log --all --oneline --grep="<feature name>"` to find related work on other branches
- Look for commit messages that explain design decisions, refactors, or bug fixes that shaped the workflow

Focus on *why* the code evolved, not just *when*. Major evolutions are: creation, significant refactors, behavior changes, bug fixes that changed the flow, and additions of new paths or states.

## Output: code guide

Produce a guide with one section per affected workflow or feature. Each section should be self-contained enough that a reviewer or planner can understand the workflow without reading the code themselves.

### Workflow: <name>

- **Purpose**: What this workflow does and why it exists in the system
- **Key files**: The primary files and entry points, with file:line references
- **Data flow**: How data moves through the workflow (high-level, not line-by-line)
- **Major evolutions**: Key changes from git history. When was it created? What refactors or behavior changes shaped it? What drove those changes? Cite commit hashes or dates.
- **Constraints and design decisions**: From comments, memories, and docs. Known constraints, tradeoffs, intentional design choices, and gotchas.
- **Current state**: Any open issues, TODOs, known limitations, or incomplete migrations

## Scope discipline

Only research workflows that the change actually touches. Do not research every workflow in the codebase. If a changed file participates in three workflows but the change only affects one, research only that one.

If the change is small and touches a single workflow, the guide may be one section. If the change is cross-cutting, the guide may have several sections. Let the change determine the scope.

## What this skill is NOT

- It is not a code review. Do not evaluate the quality of the code or flag issues. That is the job of the review specialists.
- It is not a project context builder. That is the job of thatch-review-context, which gathers project metadata (tickets, PRs, TODOs, deferred work). This skill gathers code-level context (flows, comments, git history, evolutions).
- It is not a memory writer. Do not call thatch_memory_remember. If you discover durable facts, note them in the guide; the session-reflection or fact-extractor skills will persist them later.
