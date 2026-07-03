import { define } from "@opencode-ai/plugin/v2/promise";
import { FACT_EXTRACTOR_PROMPT } from "./extraction";
import { DEDUP_CLASSIFIER_PROMPT } from "./dedup";

export const thatch = define({
  id: "thatch",
  setup: async (ctx: any) => {
    await ctx.agent.transform(async (draft: any) => {
      draft.update("thatch-fact-extractor", (agent: any) => {
        agent.mode = "subagent";
        agent.hidden = true;
        agent.system = FACT_EXTRACTOR_PROMPT;
        agent.description =
          "Extracts durable project facts, user preferences, and environmental knowledge from tool interactions.";
        agent.steps = 3;
      });

      draft.update("thatch-dedup-classifier", (agent: any) => {
        agent.mode = "subagent";
        agent.hidden = true;
        agent.system = DEDUP_CLASSIFIER_PROMPT;
        agent.description =
          "Classifies relationships between similar memory pairs for deduplication.";
        agent.steps = 2;
      });
    });
  },
});
