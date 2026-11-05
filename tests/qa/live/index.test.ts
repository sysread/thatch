// Barrel file: the live QA entry. The DEFAULT leg is opencode (the docker
// sandbox and the host-opencode tasks both land here). The CLAUDE leg is
// opt-in per run - it spawns real `claude -p` sessions with the plugin
// installed, costing model tokens AND requiring the host's logged-in claude
// CLI - so it is NEVER imported here. Run it explicitly:
//   bun test tests/qa/live/claude/index.test.ts -t UC-134
// or via mise: mise run qa-host-live-claude.
import "./opencode/index.test";
