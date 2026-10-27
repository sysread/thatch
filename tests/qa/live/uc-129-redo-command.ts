import { registerUseCase, type UseCase } from "../runner";

/**
 * UC-129: the /s redo command's TUI smoke.
 *
 * /s is a TUI keymap slash command (the ./tui plugin's keymap layer), so it
 * only exists in the real TUI - headless runs have no prompt and no
 * keymap, hence manualOnly (the uc-125 precedent for visual-TUI features).
 * The discriminating observations are the revert + resubmit pair: the
 * message reverts with /undo semantics (files the turn edited restore) and
 * a NEW user message with the substituted text runs as the next turn.
 */
const useCase: UseCase = {
  name: "UC-129-redo-command",
  hosts: ["v2"],
  manualOnly: true,
  preconditions: [
    "- thatch configured as a plugin in opencode v2 (the ./tui entrypoint loaded: the /s command in prompt slash completion)",
    "- A session with at least one earlier real user message (the redo target)",
  ].join("\n"),
  steps: [
    "1. In the session prompt, run `/s /color/colour/` where the session's last",
    "   user message contains the word 'color' (adjust the substitution to a",
    "   word actually in that message).",
    "2. Report what toast appeared and what the message list shows.",
    "3. Run `/s /nosuchword/x/` and report the toast.",
    "4. Run `/s /a/b/q` and report the toast (q is not a valid flag).",
    "5. Run /undo, then `/s /anything/whatever/` and report the toast.",
  ].join("\n"),
  expected: [
    "- Step 1-2: a success toast ('reverted and resubmitted with the",
    "  substitution applied'); the prior exchange is reverted (the turn's",
    "  file edits restore) and a new user message carrying the substituted",
    "  text runs as the next turn.",
    "- Step 3: 'no match - nothing done'; no revert, no new message.",
    "- Step 4: an error toast naming the unknown flag; nothing touched.",
    "- Step 5: 'an undo is staged - cancel it with the built-in /redo first';",
    "  nothing touched. (Run the built-in /redo afterwards to clear it.)",
  ].join("\n"),
  userDoc: "docs/dev/features/opencode-plugin.md",
};

registerUseCase(useCase);
