# CI/CD

Thatch uses GitHub Actions for CI and publishing, plus a local release helper script. The quality gate is `mise run check` (typecheck + tests + markdownlint).

## CI pipeline (.github/workflows/ci.yml)

Runs on every push/PR to main. Three jobs:
1. **Typecheck** — `bunx tsc -p tsconfig.check.json` (includes src, tests, and the CI scripts in `.github/scripts`; the build's `tsconfig.json` includes only src)
2. **Tests** — `bun test` (bun:test framework, no network, `:memory:` DB or temp dirs)
3. **Markdownlint** — `bunx markdownlint-cli2` on `README.md` and `docs/**/*.md` (excluding `docs/plans/**`)

The CI gate is the never-merge-broken guard before a release. All three must pass.

## Publish pipeline (.github/workflows/publish.yml)

Triggered by pushing a `v*` tag. Publishes to npm via OIDC trusted publishing — no stored npm token. The tag push does not trigger ci.yml, so the publish workflow re-runs the full CI gate (typecheck, tests, markdownlint) across the same dual-Bun matrix as its own release gate.

Key details:
- `id-token: write` permission lets npm authenticate through GitHub's OIDC exchange
- Prerequisite: a Trusted Publisher configured on npmjs.com for `@jeffober/thatch` pointing at the `sysread/thatch` repo
- npm >= 11.5.1 required (OIDC exchange needs it). The workflow installs setup-node@v4 (node 24) and `npm install -g npm@11`
- npm 12 shipped a sigstore bug that broke OIDC publishing; the pin prevents it
- The workflow deliberately sets NO `registry-url`, which would write a token-expecting `.npmrc` that preempts the OIDC exchange

## Wiki pipeline (.github/workflows/wiki.yml)

Triggered by pushes to main that touch `docs/**`, the workflow file, or the render script. One-way mirror of `docs/` into the GitHub wiki: renders each doc to a flat wiki page (tiered prefixes `Guide:`, bare, `Feature:`; see `.github/scripts/sync-wiki.ts`), rewrites relative md links, generates `Home.md` + `_Sidebar.md`, wipes and rewrites all wiki pages, then pushes to `sysread/thatch.wiki.git`.

- Uses the `WIKI_TOKEN` Actions secret (classic PAT, `public_repo` scope) because the built-in `GITHUB_TOKEN` cannot push to wiki repos
- Precondition: the wiki must be initialized once via the UI (GitHub does not auto-create `.wiki.git` repos)
- `docs/plans/` and `docs/in-progress/` are excluded; duplicate or reserved page names fail the render script

## Release helper (bin/release)

A bash script (`set -euo pipefail`) that bumps, checks, commits, tags, and pushes.

Args: exactly one required: `patch | minor | major`. Anything else prints an error and exits 1.

Steps:
1. Read current version from `package.json` via `node -p`
2. Compute next version (major resets minor/patch to 0; minor resets patch to 0)
3. Print current/bump/next
4. Pre-flight: if git tag `v$curr` exists, check npm registry for `@jeffober/thatch@$curr`. If npm returns E404 (tagged but not published = prior release failed), error with recovery instructions and exit 1. If npm check fails for non-404 reason, warn and proceed.
5. Run `mise run check` (typecheck + tests + markdownlint)
6. Bump `package.json` via `npm version $v --no-git-tag-version`
7. Prompt `commit, tag, and push v$next? [y/N]`. On no: revert `package.json` and exit 0. On yes: git add, commit -m "v$next", tag `v$next`, push, push --tags.
8. Print `done - CI will publish v$next to npm`

## mise tasks

| Task | Purpose |
|------|---------|
| `test` | Run the test suite (`bun test`) |
| `test-watch` | Run tests in watch mode |
| `coverage` | Run tests with coverage report |
| `typecheck` | Typecheck src + tests + `.github/scripts` (`bunx tsc -p tsconfig.check.json`) |
| `lint-md` | Lint markdown docs (`bunx markdownlint-cli2`) |
| `check` | The CI gate: typecheck + tests + markdownlint |
| `release` | Bump version, commit, tag, push (args: `patch\|minor\|major`) |
| `qa` | Run QA use cases (auto first, then live) |
| `qa-dry-run` | List QA use cases without spawning opencode sessions |
| `qa-auto` | Run only automatable QA use cases (no LLM, fast) |
| `qa-live` | Run only live-session QA use cases (spawns opencode, costs model tokens) |
| `cli` | Run the thatch CLI (list, show, search, forget) |

`mise.toml` pins Bun 1.3.14 and sets `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

## Development tooling

- **Bun 1.3.14** (pinned via mise)
- **TypeScript** with `tsconfig.check.json` for typecheck (includes src, tests, and `.github/scripts`; build's `tsconfig.json` includes only src)
- **bun:test** framework (no network, `:memory:` DB or temp dirs, mock embeddings)
- **markdownlint-cli2** with custom config (`.markdownlint-cli2.jsonc`): disables MD013 (line length), MD032 (blanks around lists), MD036 (emphasis as heading), MD060 (table alignment). Keeps MD040 (code-block language), MD047 (trailing newline), heading hierarchy.
- **Zod** for tool schema validation and JSON Schema generation (`src/tool-defs.ts`)

## Interactions with other features

- QA system ([qa-system.md](qa-system.md)): `mise run qa` runs the QA use cases
- All features: `mise run check` is the gate that validates everything before release

## Source files

- `.github/workflows/ci.yml` — CI pipeline
- `.github/workflows/publish.yml` — publish pipeline (OIDC)
- `.github/workflows/wiki.yml` + `.github/scripts/sync-wiki.ts` — wiki mirror pipeline
- `bin/release` — release helper script
- `mise.toml` — task definitions, tool pins, env vars
- `.markdownlint-cli2.jsonc` — markdownlint config
- `tsconfig.check.json` — typecheck config (includes src, tests, `.github/scripts`)

## Key invariants

- `mise run check` (typecheck + tests + markdownlint) must pass before any release. The release helper enforces this in step 5.
- OIDC publishing uses no stored npm token. The workflow sets NO `registry-url` because it would write a token-expecting `.npmrc` that preempts the OIDC exchange.
- npm is pinned to 11.x. npm 12 shipped a sigstore bug that broke OIDC publishing.
- The release helper checks for tagged-but-not-published state (tag exists, npm returns E404) and refuses to proceed with recovery instructions.
- CI runs on push/PR to main. Publish runs only on `v*` tags. The release helper bridges them: tag + push triggers publish.
- `tsconfig.check.json` includes src, tests, and `.github/scripts` for typecheck. The build's `tsconfig.json` includes only src.
