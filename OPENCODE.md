- Don't ever let me catch you ignoring linter errors because they are "just warnings" or "pre-existing" or "out of scope".
  Those errors are because of earlier mistakes in your code that you ignored.
- Keep. The. Docs. Up. To. Date.
- And the tests!
- Docs are two-tier per-feature: `docs/user/<feature>.md` (product guide for users) and `docs/dev/features/<feature>.md` (architecture for contributors). When you add or change a feature, update both tiers. The `thatch-docs` skill has the full directory map and house style.
- QA use cases live in `tests/qa/{auto,live}/uc-NNN-*.ts` as executable tests. The docs are gone -- `tests/qa/` is the sole canonical location. Write new use cases directly as `.ts` files following the pattern in `tests/qa/runner.ts`.
- When code changes behavior described in docs, updating those docs is part of the same changeset. A doc naming a deleted symbol or changed behavior is actively misleading.
- Counts drift. Skill counts, tool counts, and table entries live in docs/dev/, docs/user/, tests/qa/, and the root README. The `thatch-docs` skill lists the touch points. Grep for old numbers after any count change.
- Run `mise run lint-md` before committing doc changes. The gate lints `README.md` and `docs/**/*.md`.
