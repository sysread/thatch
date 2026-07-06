export interface ToolInteraction {
  tool: string;
  sessionID: string;
  args: Record<string, unknown>;
  title: string;
  output: string;
}

/**
 * Buffers tool interactions per session so the next user message can carry an
 * extraction nudge with the actual payload. The agent then persists facts via
 * the thatch_memory_* tools itself (see the thatch-fact-extractor skill) —
 * this pipeline only collects and serializes, it never writes to the DB.
 */
export class ExtractionPipeline {
  #buffers = new Map<string, ToolInteraction[]>();
  #maxBuffer = 20;

  /** Record a tool execution for later extraction. */
  push(interaction: ToolInteraction): void {
    const buf = this.#buffers.get(interaction.sessionID) ?? [];
    buf.push(interaction);
    this.#buffers.set(interaction.sessionID, buf.slice(-this.#maxBuffer));
  }

  /** Returns the session's buffered interactions and clears them. */
  flush(sessionID: string): ToolInteraction[] {
    const batch = this.#buffers.get(sessionID) ?? [];
    this.#buffers.delete(sessionID);
    return batch;
  }

  pending(sessionID: string): boolean {
    return (this.#buffers.get(sessionID)?.length ?? 0) > 0;
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
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
