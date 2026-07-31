// Preload script: strip OPENCODE_* env vars so tests run against a clean
// baseline. opencode injects these into the parent process, so without this
// tests that branch on env vars (e.g. OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
// pass locally but fail in CI where the vars are absent.
//
// Individual tests that need a specific value set it explicitly and clean up
// in their body. This preload only handles the default: nothing set.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE_")) delete process.env[key];
}
