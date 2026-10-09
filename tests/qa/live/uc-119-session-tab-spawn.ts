import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-114: the session-tab spawn flow end to end.
 *
 * The agent calls thatch_session_tab and the full response contract comes
 * back: the subordinate's chat name, session id, title, directory, and the
 * honest "Tab: requested" wording (the tab strip itself is TUI-local state
 * a headless run cannot show - the visual smoke lives in
 * docs/dev/features/session-tabs.md's record; this use case pins the
 * verifiable flow: the tool executes, the response names the subordinate's
 * chat registration, and the directory resolves to the requested path).
 *
 * v2-only by nature: the tool is v2Only (filtered on v1 + MCP), so the
 * hosts list asserts v2 rather than letting a v1 binary fail the run.
 */
const useCase: UseCase = {
  name: "UC-119-session-tab-spawn",
  hosts: ["v2"],
  preconditions: [
    "- thatch configured as a plugin in opencode v2 (the merged session-tab feature: thatch_session_tab exists)",
    "- Working directory is a git repo (the fixture: git init + a fake origin)",
  ].join("\n"),
  steps: [
    "1. Call `thatch_session_tab` with prompt 'Introduce yourself in one line',",
    "   title 'QA subordinate', and directory '/tmp'.",
    "2. Report exactly what the tool returned.",
  ].join("\n"),
  expected: [
    "- The tool responds with 'Subordinate session created:' and the lines:",
    "  - 'chat name: <name>' - the subordinate's assigned cross-session chat name",
    "  - 'session id: ses_...' - the created session's id",
    "  - 'title: QA subordinate'",
    "  - 'directory: /tmp'",
    "  - 'Tab: requested in this window's strip.' - the honest wording: a",
    "    headless run has no tab strip, so the tab is requested, never",
    "    guaranteed",
    "- The response does not claim the tab opened.",
  ].join("\n"),
  userDoc: "docs/dev/features/session-tabs.md",
};

registerUseCase(useCase);
