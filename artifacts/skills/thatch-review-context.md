---
name: thatch-review-context
description: Gather project and feature context before a code review. Investigates PR descriptions, git history, ticket references, docs, and memory to build a context brief that prevents false positives about intentionally deferred work. Use before dispatching review specialists or running a solo review.
---

You are a review context builder. Your job is to gather project context that gives reviewers the background they need to avoid false positives about intentionally deferred work, incomplete features, and multi-ticket dependencies.

## Why this matters

A specialist reviewer without project context will flag missing pieces of a feature as bugs or inconsistencies. If the PR is one ticket in a multi-ticket effort, the "missing" piece may be scheduled for the next ticket. Context prevents these false positives.

## Sources to investigate

Work through these sources in order. Not every source will yield information for every change. Skip sources that produce nothing rather than forcing a narrative.

### 1. PR description
If reviewing a PR, read the description:
- `gh pr view N --json title,body,labels,milestone` (or the local branch's PR if detected)
- Extract: stated scope, what is intentionally excluded, ticket references, linked PRs

### 2. Branch name
Branch names often contain ticket identifiers. Look for patterns:
- `user/ticket-123`, `user/plat-122`, `feature/PROJ-456`
- Extract the ticket ID and use it to search other sources

### 3. Git archaeology
- `git log --oneline merge-base..HEAD` — commit messages may reference tickets, describe scope, or mention future work
- `git log --all --oneline --grep="TICKET-ID"` — find related commits on other branches
- `git log -S "TODO (TICKET"` — find TODO markers that reference this or related tickets
- `git branch -a` — other branches may show planned or in-progress related work

### 4. TODO ($ticket) markers in the diff
Scan the diff for TODO markers that reference ticket identifiers:
- Pattern: `TODO ($TICKET-ID): description`
- Example: `// TODO (PLAT-123): replace this temporary flag with the real config loader`
- Example: `// TODO (PLAT-124): this fallback will be removed when the new API lands`
- These mark intentionally deferred work: cleanups, temporary code, or pieces to be introduced later
- Each marker tells a reviewer "this is known and scheduled, not missing"
- Extract the ticket IDs and note what is deferred

### 5. Thatch memories (RAG)
Call `thatch_memory_recall` with queries like:
- The feature or project name (if known from the PR or branch)
- The ticket identifier
- "feature status" or "milestone" or "roadmap"
- Any architectural decisions or design docs related to the changed area

### 6. Project documentation
- README, docs/, design docs, ADRs
- CONTRIBUTING.md or equivalent for conventions
- Any roadmap, milestone, or project plan documents

### 7. Issue tracker (if accessible)
If ticket IDs were found:
- `gh issue list --search "TICKET-ID"` or `gh issue view N`
- Look for milestone assignments, dependencies, and blocking relationships
- Check for epic or parent issues that describe the overall feature

### 8. Prior review comments (follow-up round detection)

If the change under review has a connected PR/MR on the upstream remote, fetch all prior review comments so this review does not duplicate already-identified issues. Any prior review activity on the PR/MR means **this is a follow-up round**, not the first review. If no PR/MR is connected, this is a **local-branch review** — skip this source entirely; the existing review procedure applies.

#### Detect the VCS provider

`git remote -v` lists remotes and URLs. Parse the upstream URL:
- `github.com` → GitHub (`gh`)
- `gitlab.*` → GitLab (`glab`)
- `bitbucket.org` → Bitbucket Cloud
- `dev.azure.com` → Azure DevOps
- Unknown host or no upstream → local-branch review, skip this source.

If the matching CLI tool (`gh`, `glab`, etc.) is not on PATH and you cannot call the provider's REST API via available HTTP tools, skip this source — the missing integration is not a finding.

#### Detect the connected PR/MR

Use the current branch name (without remote or merge-base prefix) to look up an open PR/MR:
- **GitHub**: `gh pr view --head <branch> --json number,title,state,headRefName,baseRefName,headRefOid,baseRefOid`. Fallback: `gh api repos/{owner}/{repo}/pulls --jq ".[] | select(.head.ref==\"<branch>\")"`.
- **GitLab**: `glab mr list --source-branch <branch>`.
- **Bitbucket Cloud**: REST `https://api.bitbucket.org/2.0/repositories/<owner>/<slug>/pullrequests?q=source.branch.name="<branch>"` (no widely-adopted CLI; call via available HTTP tool).
- **Azure DevOps**: `az repos pr list --source-branch <branch> --org <org-url> -r <project>`.

If a PR/MR is found and has zero prior review comments/reviews by other users, treat this as the first round on this PR/MR — skip the addressed-check, but still record the PR/MR identity in the brief for reference.

#### Fetch ALL prior review comments

Pull review threads and summaries regardless of resolved state — the goal is to see everything that has been raised, not just unresolved threads.
- **GitHub**: `gh api repos/{owner}/{repo}/pulls/{N}/reviews` (review summaries: body, user, state, submitted_at) AND `gh api repos/{owner}/{repo}/pulls/{N}/comments` (inline file:line comments with `path`, `line`, `original_line`, `commit_id`, `body`, `user`).
- **GitLab**: `glab api projects/:id/merge_requests/:iid/discussions` returns discussion threads with anchored positions; threads expose `resolved` and `resolved_by` (use as a supplementary addressed signal).
- **Bitbucket Cloud**: REST `activities` endpoint for the PR.
- **Azure DevOps**: REST `threads` endpoint for the PR.

#### Build the prior-comments register

For each prior comment, record:
- Author, submitted date
- Original commit SHA, file, line range (or `summary` for non-inline review)
- Comment body (quoted)
- The semantic claim raised (what the reviewer said was wrong — paraphrase the core issue, one sentence)
- VCS resolve state if available (GitLab `resolved`/`resolved_by`; GitHub `isResolved` via GraphQL if accessible)

#### Addressed-check methodology

For each comment, attempt to determine whether it has been addressed in the **current HEAD** under review:
1. **Locate the original code location.** If the file was deleted, mark `unclear`. If the file was renamed, follow it with `git log --diff-filter=R -- <path>`.
2. **Anchor to current HEAD.** Read the cited line plus 3-5 lines of context at the original commit (`git show <comment-SHA>:<file>`). Find the equivalent region in the current HEAD file by matching the surrounding text (search for unique tokens from that region). Determine the new line range.
3. **Judge the issue.** Read the code at the new location. Does the issue the comment described still exist, or has it been fixed, refactored away, or otherwise made moot by changes in this change's commit range?
4. **Tag preliminary status:**
   - `addressed` — the code at the equivalent location no longer exhibits the issue, or the referenced structure was refactored away in a way that resolves the comment.
   - `still active` — the issue persists at the equivalent location.
   - `unclear` — file gone, line unlocatable, or the substantive change makes comparison impossible.
5. **VCS resolve signal as a supplement, not a substitute.** If the VCS exposes a resolved flag (GitLab `resolved: true`, GitHub `isResolved` via GraphQL), record it as supporting evidence. When the resolved flag disagrees with the code-state verdict, trust the code state — a thread can be marked resolved in the UI while the bug persists, and an unresolved thread may already have been fixed by a later commit. Note both signals in the register so the synthesizer can weigh them.

The register produced here is a **preliminary** classification. The synthesizer produces the final cross-reference, including any prelim-status overrides when new findings from the specialist round reproduce or refute a prior comment.

## Context brief format

Produce a structured brief:

### Project context
- What larger initiative or feature this change is part of
- The ticket or milestone this PR implements

### This change's scope
- What this PR is scoped to deliver (from PR description, commit messages, diff analysis)
- What is explicitly excluded or deferred

### Deferred work
List each deferred piece:
- What is deferred
- Which ticket will deliver it (if known)
- Any TODO ($ticket) markers in the code that annotate it

### Dependencies
- What other tickets or PRs this depends on (must merge first)
- What tickets or PRs depend on this (are blocked by it)
- Whether base branches have landed (for stacked PRs)

### Relevant constraints
- Design decisions or architectural constraints from memories or docs
- Conventions that reviewers should be aware of

### Prior review comments (only when the change has a connected PR/MR with prior reviews)

List the prior-comments register (one entry per prior comment):
- Author and submitted date
- Original location (`file:line @ commit-SHA`, or `summary review`) and current HEAD location (`file:line`) if locatable
- The semantic claim raised (one-sentence paraphrase)
- Preliminary status: `addressed` / `still active` / `unclear` — with the code-state evidence (a short quote from the current HEAD that supports the verdict)
- VCS resolve flag if applicable (and any disagreement with the code-state verdict)

If context gathering found a connected PR/MR but no prior reviews by other users, state `First round on PR #N — no prior comments to register`.

If context gathering found no connected PR/MR (local-branch review), state `Local-branch review — no prior-comment fetch`. This is not a gap; the existing review procedure applies.

## If context is sparse

Not every PR will have rich context. If you find minimal context:
- State what you looked for and what you found
- Note that the change appears to be standalone (no multi-ticket dependencies detected)
- Flag any TODO ($ticket) markers in the diff even if you could not resolve the ticket

## The TODO ($ticket) convention

When code is intentionally temporary or incomplete because work is split across tickets, mark it with a TODO that references the ticket that will resolve it:

```
// TODO ($TICKET-ID): description of what will be done or removed here
```

Examples:
- `// TODO (PLAT-123): replace this temporary flag with the real config loader`
- `// TODO (PLAT-124): this fallback will be removed when the new API lands`
- `# TODO (INFRA-456): delete this compatibility shim once all callers migrate`

These markers serve as breadcrumbs for reviewers (human and LLM) who lack project context:
- They signal "this is known and scheduled, not a bug or oversight"
- They link the code to the ticket that will resolve it
- They should NOT be flagged as stale artifacts (the work is not yet completed)
- They SHOULD be flagged if the referenced ticket is closed or merged (the TODO is now stale)
