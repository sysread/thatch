# Plans

Numbered plan documents capture design decisions that span multiple sessions.
Each plan is a snapshot of the reasoning at the time — subsequent plans may
supersede earlier ones as the project evolves.

Plans are temporary. When a plan is fully implemented, it **graduates**:

1. The plan file is removed from this folder.
2. The final architecture is documented in `docs/dev/` — either updated into
   existing dev docs or captured in a new one.
3. End-to-end use-case scenarios are added to `docs/qa/use-cases/`.

Once graduated, the dev docs and use-case docs are the permanent record. The
plan file is no longer needed — git history preserves it if someone needs the
original design reasoning.

## Plan format

Each plan should cover:

1. **Synopsis** — 1-2 line summary
2. **Decisions** — table of choices made, with rationale where non-obvious
3. **Architecture** — module layout and data flow
4. **Dependencies** — runtime, built-in, and dev deps
