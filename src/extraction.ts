export interface ToolInteraction {
  tool: string;
  sessionID: string;
  args: Record<string, unknown>;
  title: string;
  output: string;
}

/**
 * Summarize a tool's args to a single human-readable string. Used by both the
 * opencode plugin (in-process) and the Claude Code CLI (file-backed queue) so
 * the payload the agent ultimately receives has the same shape from either path.
 */
export function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  const file = args.filePath ?? args.file_path;
  switch (tool.toLowerCase()) {
    case "read":
      return `file: ${file}`;
    case "bash":
      return (args.command as string)?.slice(0, 120) ?? "";
    case "grep":
      return `pattern: ${args.pattern}`;
    case "glob":
      return `pattern: ${args.pattern}`;
    case "edit":
      return `file: ${file}`;
    case "write":
      return `file: ${file}`;
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

/**
 * Derive a short identifying title for a tool call when the host doesn't supply
 * one. opencode passes an `output.title` via tool.execute.after; Claude Code's
 * PostToolBatch only gives us tool_name + tool_input, so we synthesize a label.
 * Kept short so the JSON payload stays scannable across ~20 buffered entries.
 */
export function deriveTitle(tool: string, args: Record<string, unknown>): string {
  const file = args.filePath ?? args.file_path;
  switch (tool.toLowerCase()) {
    case "read":
    case "edit":
    case "write":
      return String(file ?? "").split("/").pop() ?? "";
    case "bash":
      return (args.command as string)?.slice(0, 80) ?? "";
    case "grep":
    case "glob":
      return String(args.pattern ?? "");
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Serialize a list of tool interactions into the JSON payload the
 * thatch-fact-extractor skill expects. Shared by the opencode plugin path
 * (in-memory buffer) and the Claude Code CLI path (file-backed queue) so the
 * extractor sees an identical contract regardless of host. The agent itself
 * does the actual fact extraction — this function only collects and serializes.
 */
export function buildExtractionPayload(
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
 * Per-session in-memory ring buffer used by the opencode plugin path. Claude
 * Code's MCP server has no equivalent plugin lifecycle, so its CLI subcommands
 * use the file-backed queue in extract-queue.ts plus buildExtractionPayload.
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

  /** Returns the session's buffered interactions without clearing them. */
  peek(sessionID: string): ToolInteraction[] {
    return this.#buffers.get(sessionID) ?? [];
  }

  /** Clears the session's buffer. Called when the agent writes a memory. */
  consume(sessionID: string): void {
    this.#buffers.delete(sessionID);
  }

  /** Returns the session's buffered interactions and clears them. */
  flush(sessionID: string): ToolInteraction[] {
    const batch = this.peek(sessionID);
    this.consume(sessionID);
    return batch;
  }

  pending(sessionID: string): boolean {
    return (this.#buffers.get(sessionID)?.length ?? 0) > 0;
  }

  /** Build the extraction prompt payload from buffered interactions. */
  buildPayload(interactions: ToolInteraction[], projectStore: string): string {
    return buildExtractionPayload(interactions, projectStore);
  }
}
