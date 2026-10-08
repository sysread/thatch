#!/usr/bin/env bash
# Entrypoint for the thatch QA opencode sandbox (see Dockerfile).
# Sets up a throwaway XDG tree + thatch plugin shim, then execs opencode.
# Every path the plugin or the server can write to lives under /qa - the
# container is the isolation boundary, so nothing here can touch host state.
set -euo pipefail

export HOME=/qa/home
export XDG_CONFIG_HOME=/qa/config
export XDG_DATA_HOME=/qa/data
export XDG_STATE_HOME=/qa/state
# The caller's -w (the QA runner mounts the fixture at its host path and
# runs there) - captured before the /qa/work init cd's around.
INITIAL_CWD=$(pwd)
mkdir -p "$XDG_CONFIG_HOME/opencode/plugins/thatch" "$XDG_DATA_HOME" "$XDG_STATE_HOME" /qa/work

# The thatch plugin shim, in DIRECTORY form: the v2 TUI's plugin discovery
# loads directories/symlinks and SKIPS plain files, so the ./tui entrypoint
# (the tab-strip driver) only loads from the directory shape. The container
# is v2-only (the image pins v2), so v1's file-only discovery does not
# apply here. Absolute paths: a plugin file's relative imports resolve from
# its own directory - ./src/index would never load. Dual-shape index: v2's
# server-side loader reads the default export (merged {id, setup, server}).
cat >"$XDG_CONFIG_HOME/opencode/plugins/thatch/index.ts" <<'SHIM'
export { server } from "/app/thatch/src/index";
export { default } from "/app/thatch/src/index";
SHIM
cat >"$XDG_CONFIG_HOME/opencode/plugins/thatch/tui.ts" <<'TUI'
export { default } from "/app/thatch/src/opencode/tui-plugin";
TUI
ln -sfn /app/thatch/node_modules "$XDG_CONFIG_HOME/opencode/node_modules"
cp /app/thatch/package.json "$XDG_CONFIG_HOME/opencode/package.json"

# The work dir: a scratch git repo so repo-identity helpers (detectRepo,
# resolveMainCheckout) and the session-tab worktree flow have a repo to
# resolve against when one is launched from here. Idempotent for `run`
# invocations that re-exec.
if [ ! -d /qa/work/.git ]; then
  cd /qa/work
  git init -q
  git config user.email qa@example.com
  git config user.name QA
  touch .gitkeep
  git add .gitkeep
  git commit -qm init
fi
# Back to the caller's -w: the project (skills, git identity) resolves from
# the working directory, and the QA runner points it at the mounted fixture.
cd "$INITIAL_CWD"

# Minimal opencode config: the venice provider with the key from the env
# (never on disk), autoupdate off, no MCP servers - the sandbox has none.
cat >"$XDG_CONFIG_HOME/opencode/opencode.json" <<'CONFIG'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "snapshot": false,
  "model": "venice/z-ai-glm-5-3-flash",
  "provider": {
    "venice": {
      "options": { "apiKey": "{env:VENICE_API_KEY}" }
    }
  }
}
CONFIG

exec opencode "$@"
