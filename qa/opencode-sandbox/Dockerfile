# A fully isolated opencode v2 + thatch QA sandbox.
#
# Why docker: the XDG-override sandbox approach leaks the LAUNCHING SHELL's
# env into the spawned opencode - direnv's OPENCODE_CONFIG layers real MCP
# server configs into the "sandbox", whose auth credentials then live in a
# different (overridden) XDG dir, producing spurious re-auth prompts and
# partial real-config loading. A container has exactly the env it is given:
# no host state, no MCP servers unless the entrypoint writes them, no host
# keychain/auth files.
#
# Build:   docker build -t thatch-qa-opencode qa/opencode-sandbox
#
# TUI smoke (interactive; attach a host dir at /qa so the run's artifacts -
# sandbox dbs, the TUI tabs store - can be verified afterwards):
#   SMOKE=$TMPDIR/thatch-tab-smoke; mkdir -p $SMOKE/qa
#   docker run -it --rm -v "$(pwd)":/app/thatch \
#     -v "$SMOKE/qa:/qa" -e VENICE_API_KEY thatch-qa-opencode
#
# Headless (non-interactive; the same /qa mount for post-run assertions):
#   docker run --rm -v "$(pwd)":/app/thatch -v "$SMOKE/qa:/qa" \
#     -e VENICE_API_KEY thatch-qa-opencode run "<prompt>"
#
# Serve mode (a long-lived headless server: sessions live across plugin
# reloads - what the reload-loss repro needs):
#   docker run -d --rm -p 127.0.0.1:4096:4096 -v "$(pwd)":/app/thatch \
#     -v "$SMOKE/qa:/qa" -e OPENCODE_SERVER_PASSWORD=qa-repro \
#     -e VENICE_API_KEY -e THATCH_DEBUG=1 -e THATCH_WATCH_POLL_SECONDS=5 \
#     thatch-qa-opencode serve --hostname 0.0.0.0 --port 4096
# The SDK/scripts talk to http://127.0.0.1:4096 with basic auth
# (opencode:$OPENCODE_SERVER_PASSWORD) + the x-opencode-directory header.
#
# The thatch checkout is MOUNTED (not baked) so QA always exercises the
# current working tree - the same choice the QA runner makes with git
# archive. VENICE_API_KEY is passed at run time, never baked.
#
# The reload-loss repro (automated; verifies pending-event durability
# across a plugin reload): start the serve container as above, then
#   bun qa/opencode-sandbox/reload-loss-repro.ts

FROM oven/bun:1.4.2

# git is required: thatch's repo-identity helpers (detectRepo,
# resolveMainCheckout) and the session-tab worktree flow shell out to git.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# opencode v2, pinned - bump deliberately when testing a new release.
# The image is bun-only (no node/npm), so install via bun's global add.
# --trust is required: the package's postinstall downloads the platform
# binary, and bun blocks lifecycle scripts from untrusted dependencies.
RUN bun add -g --trust @opencode/cli@2.0.23
ENV PATH="/root/.bun/bin:${PATH}"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
