# UC-021: Prediction auto-fire

**Preconditions**
- An opencode session (or Claude Code / Cursor with the MCP server running and sideband socket live)
- A clean DB (no existing matchers or predictions)

**Steps**

1. Send a prompt expressing a preference, e.g. "I prefer to handle error cases before happy paths. Record this preference."
2. Observe the agent calls `prediction_update` with `signal: "create"`.
3. Start a new session (or send a fresh prompt in the same session).
4. Send a prompt matching the matcher context, e.g. "Write a function to parse a JSON config file."
5. Send an unrelated prompt, e.g. "What's the weather like?"

**Expected**
- Step 2: Agent calls `thatch_prediction_update` with a matcher describing the context ("writing functions", "error handling") and a prediction describing the preference ("handle errors before happy paths"). The tool returns `[created]` and seeds confidence at 0.50 with 0 evidence.
- Step 4: The `chat.message` hook embeds the prompt, finds matchers above the 0.45 threshold, scores linked predictions, and injects a `[thatch] User decision model` nudge. The 0-evidence prediction uses "you may prefer" (not "you tend to"). The agent may follow the prediction, surface it, or ignore it.
- Step 5: No prediction nudge (cosine below threshold). No extra synthetic parts.
- Claude Code / Cursor: The `flush-tools` hook fires predictions alongside the recall nudge via the sideband socket. The `flush-predictions` CLI subcommand provides standalone prediction-only output.

_Automatable: yes — the auto-fire path is tested in `plugin.test.ts` (prediction nudge via chat.message, independent firing, no-match suppression). The end-to-end "agent acts on prediction" flow is manual._
