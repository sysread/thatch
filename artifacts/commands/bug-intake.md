---
description: "Coordinate incoming bug reports: triage, verify against source, route to a filed issue or a landed fix"
---
# User Message

$ARGUMENTS

(That section carries the text typed after the command. When it is empty, treat the user message as n/a - the command was run bare.)

# Bug-intake

Load and follow the thatch-bug-intake skill to run the bug intake desk for this project.

The user message may scope the run: which reports to take, the route per bug (file an issue in a tracker, or coordinate a fix), the repo or tracker to file against, or instructions for any individual step. Apply each instruction to the matching step; user instructions win over the skill's defaults.

If the skill is not available on this host, run the procedure yourself: verify the chat registration with thatch_chat_status, triage reports from the user message and the chat inbox (thatch_chat_read), dispatch an investigation for each bug claim and confirm it against the source, then route. The ticket route generalizes the reported incident into the underlying defect, checks the affected repo's tracker for an existing issue, and files one canonical issue in the thatch-ticket-description format (a project that picks issues up with automation needs the issue, not a fix session). The fix route coordinates the work in a worktree (subordinate session on hosts that support them, inline on a branch elsewhere), runs it through review rounds, lands it by the project's convention, and closes the loop with the reporter.
