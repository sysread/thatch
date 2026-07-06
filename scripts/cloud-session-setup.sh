#!/usr/bin/env bash
# Dependency bootstrap for Claude Code cloud sessions, run by the
# SessionStart hook in .claude/settings.json. Local sessions exit
# immediately — local setup is mise-managed (see mise.toml).
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

# Cloud environment setup scripts run before the repo is cloned, so
# dependency installation has to happen here instead. Environment files
# persist between sessions, so after the first session this is a no-op.
[ -d node_modules ] && exit 0

# The sandbox routes all traffic through an HTTP proxy that bun's fetcher
# sometimes chokes on. npm resolves the same deps (it ignores bun.lock and
# writes its own lockfile — don't commit package-lock.json).
if ! bun install; then
  echo "[thatch] bun install failed (sandbox proxy?) — falling back to npm" >&2
  npm install
fi
