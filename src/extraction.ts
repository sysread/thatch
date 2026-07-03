import type { ThatchDB } from "./db";
import type { EmbeddingModel } from "./embeddings";

export const FACT_EXTRACTOR_PROMPT = `You are the Thatch Fact Extractor. Your job: review tool interactions and extract durable project knowledge to persist across sessions.

You will receive a JSON payload with:
  - "interactions": recent tool calls and their results
  - "projectStore": the current project's store name
  - "globalStore": the global store name

Return ONLY a JSON object:
{
  "actions": [
    {"action": "add",     "store": "...", "label": "...", "content": "...", "confidence": N},
    {"action": "replace", "store": "...", "label": "...", "content": "...", "confidence": N},
    {"action": "delete",  "store": "...", "label": "..."}
  ]
}

## What to extract

- Project architecture, conventions, patterns discovered through tool use
- Non-obvious gotchas and pitfalls (especially ones that took time to debug)
- User preferences, communication style, explicit corrections, pet peeves
- Shell/environment quirks (tool friction, missing commands, platform issues)
- Bug shapes: the abstract pattern behind a fix, not the specific bug context

## What NOT to extract

- Session-specific state (current branch, open files, last command run)
- Ephemeral debugging details that won't apply to future work
- Anything already in CLAUDE.md or OPENCODE.md
- Trivial tool invocations (ls, cd, echo, simple file reads that found nothing)

## Store assignment

- global store: user preferences, personality traits, communication style, environment quirks
- Project store: architecture, conventions, patterns, project-specific gotchas

## Rules

- One topic per action. Several specific memories over one sprawling one.
- If content conflicts with an existing memory, use "replace" to update it.
- If an existing memory is completely invalidated, use "delete".
- If the interactions contain nothing worth persisting, return an empty "actions" array.
- Confidence (1-10): 1-3 weak signal, 5-6 moderate evidence, 7-8 strong pattern, 9 explicitly stated, 10 hard constraint.
- Write memories for a future instance with zero session context. No "we", "our session", "currently", "just now".
- Labels: short descriptive titles (5-8 words). Content: self-contained, 2-5 sentences.`;

export interface ToolInteraction {
  tool: string;
  sessionID: string;
  args: Record<string, unknown>;
  title: string;
  output: string;
}

export interface ExtractionAction {
  action: "add" | "replace" | "delete";
  store: string;
  label: string;
  content?: string;
  confidence?: number;
}

export interface ExtractionResponse {
  actions: ExtractionAction[];
}

/**
 * Collects tool interactions and triggers fact extraction on session idle.
 * Not tied to any specific DB — actions are returned for the caller to execute.
 */
export class ExtractionPipeline {
  #buffer: ToolInteraction[] = [];
  #maxBuffer = 20;

  /** Record a tool execution for later extraction. */
  push(interaction: ToolInteraction): void {
    this.#buffer.push(interaction);
    if (this.#buffer.length > this.#maxBuffer) {
      this.#buffer = this.#buffer.slice(-this.#maxBuffer);
    }
  }

  /** Returns a copy of the buffer and clears it. */
  flush(): ToolInteraction[] {
    const batch = [...this.#buffer];
    this.#buffer = [];
    return batch;
  }

  get pending(): boolean {
    return this.#buffer.length > 0;
  }

  get bufferSize(): number {
    return this.#buffer.length;
  }

  /** Build the extraction prompt payload from buffered interactions. */
  buildPayload(
    interactions: ToolInteraction[],
    projectStore: string,
  ): string {
    const summaries = interactions.map((ix) => ({
      tool: ix.tool,
      title: ix.title,
      args: summarizeArgs(ix.tool, ix.args),
      output: truncate(ix.output, 500),
    }));

    return JSON.stringify({
      interactions: summaries,
      projectStore,
      globalStore: "global",
    });
  }

  /**
   * Parses the extraction response and executes actions against the database.
   * Handles add, replace, and delete. Returns a summary of what happened.
   */
  async applyActions(
    db: ThatchDB,
    model: EmbeddingModel,
    response: ExtractionResponse,
  ): Promise<string[]> {
    const results: string[] = [];

    for (const act of response.actions) {
      switch (act.action) {
        case "add":
        case "replace": {
          if (!act.content) {
            results.push(`[thatch] extraction: skipped ${act.action} for "${act.label}" — no content`);
            continue;
          }
          const content = `# ${act.label}\n\n${act.content}`;
          const emb = await model.passageEmbed(content);
          const result = db.remember(
            act.store,
            act.label,
            content,
            emb,
            "bge-small-en-v1.5",
            {
              confidence: act.confidence,
              overwrite: act.action === "replace",
            },
          );
          if (result.ok) {
            results.push(`[thatch] extraction: ${act.action}d "${act.label}" → ${act.store}`);
          } else {
            results.push(`[thatch] extraction: failed to ${act.action} "${act.label}": ${result.error}`);
          }
          break;
        }
        case "delete":
          db.forgetEntry(act.store, act.label);
          results.push(`[thatch] extraction: deleted "${act.label}" from ${act.store}`);
          break;
      }
    }

    return results;
  }
}

function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "read":
      return `file: ${args.filePath}`;
    case "bash":
      return (args.command as string)?.slice(0, 120) ?? "";
    case "grep":
      return `pattern: ${args.pattern}`;
    case "glob":
      return `pattern: ${args.pattern}`;
    case "edit":
      return `file: ${args.filePath}`;
    case "write":
      return `file: ${args.filePath}`;
    case "that_memory_remember":
      return `label: ${args.label}`;
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
