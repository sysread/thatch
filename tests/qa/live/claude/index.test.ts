// Barrel: the CLAUDE leg of the live QA suite - opt-in per run, NEVER part
// of a default gate (model tokens + the host's logged-in claude CLI). Each
// use case spawns real `claude -p` sessions with the thatch plugin
// installed and asserts ONLY via surfaces the plugin writes (db, queue
// dir, debug log, files) - never the model's prose (the leg invariant;
// see .claude/skills/thatch-plugin-qa/SKILL.md).

import "./uc-134-claude-stage-delivery";
import "./uc-135-claude-extraction-cycle";
import "./uc-136-claude-escalation";
import "./uc-137-claude-chat-wake";
import "./uc-138-claude-wrapup";
import "./uc-139-claude-watcher";
import "./uc-140-claude-alerts";
import "./uc-146-claude-marketplace-install";
