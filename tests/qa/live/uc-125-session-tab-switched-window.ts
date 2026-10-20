import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-125: the coordinator-anchored tab routing (the 2026-10-20 fix).
 *
 * The pre-fix guard routed tab-open events by the VIEWED session's
 * directory, and the TUI's location context follows the viewed session -
 * so a coordinator window parked on a worktree or foreign-repo tab dropped
 * every spawn silently (sessions ran, tabs never appeared). The fix anchors
 * open events on the coordinator session's own tab: the strip holds it
 * regardless of what is on screen.
 *
 * The discriminating observation is the tab strip itself, which is
 * TUI-local state no headless run has - hence manualOnly, like the other
 * visual-TUI use cases. The precondition that makes the run discriminate
 * old behavior from new: the viewed tab must be a session in a DIFFERENT
 * directory (a worktree or another repo); a same-directory viewed tab
 * passes under both the old and new guards.
 */
const useCase: UseCase = {
  name: "UC-125-session-tab-switched-window",
  hosts: ["v2"],
  manualOnly: true,
  preconditions: [
    "- thatch configured as a plugin in opencode v2 (the coordinator-anchored routing: coordinatorSessionID rides the tab-opened event)",
    "- Working directory is a git repo (the fixture: git init + a fake origin)",
    "- At least one OTHER tab is open in the strip and the window is VIEWING it",
    "- The viewed tab's session lives in a DIFFERENT directory than this window's cwd (a worktree or another repo session)",
  ].join("\n"),
  steps: [
    "1. While viewing the other-directory tab, call `thatch_session_tab` with",
    "   prompt 'Introduce yourself in one line', title 'QA switched-window",
    "   spawn', and directory '/tmp'.",
    "2. Report exactly what the tool returned.",
    "3. Look at the tab strip (do not navigate away first) and report whether",
    "   a 'QA switched-window spawn' tab appeared beside the coordinator's.",
  ].join("\n"),
  expected: [
    "- The tool responds with 'Subordinate session created:' and the same",
    "  contract lines as UC-119 (chat name, session id, title, directory,",
    "  'Tab: requested').",
    "- Step 3: the subordinate's tab IS in the strip, even though the window",
    "  was viewing a different-directory session at spawn time - the",
    "  coordinator-anchored routing does not depend on the viewed session.",
  ].join("\n"),
  userDoc: "docs/dev/features/session-tabs.md",
};

registerUseCase(useCase);
