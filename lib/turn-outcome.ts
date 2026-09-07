import type { AgentMessage, AssistantContentBlock, ToolResultMessage } from "./types";
import { extractTurnWrittenFiles, type WrittenFile } from "./turn-written-files";

export interface TurnCommand {
  id: string;
  command: string;
  status: "completed" | "failed" | "unknown";
  output: string;
  truncated: boolean;
}

export interface TurnOutcome {
  files: WrittenFile[];
  commands: TurnCommand[];
}

const OUTPUT_PREVIEW_LIMIT = 4000;

/** Uses only the supplied turn's recorded calls/results, never assistant claims.
 * A completed command is not evidence that tests ran or that changes are correct.
 */
export function buildTurnOutcome(messages: readonly AgentMessage[], cwd?: string): TurnOutcome {
  const content: AssistantContentBlock[] = [];
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "assistant") content.push(...message.content);
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }

  const commands: TurnCommand[] = [];
  const seen = new Set<string>();
  for (const block of content) {
    // The built-in bash contract is known. Custom tools may use different
    // arguments or completion semantics, so do not guess from their names.
    if (block.type !== "toolCall" || block.toolName !== "bash" || seen.has(block.toolCallId)) continue;
    const command = block.input?.command;
    if (typeof command !== "string" || !command.trim()) continue;
    seen.add(block.toolCallId);
    const result = results.get(block.toolCallId);
    const output = result?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
    commands.push({
      id: block.toolCallId,
      command,
      status: !result ? "unknown" : result.isError ? "failed" : "completed",
      output: output.slice(-OUTPUT_PREVIEW_LIMIT),
      truncated: output.length > OUTPUT_PREVIEW_LIMIT,
    });
  }
  return { files: extractTurnWrittenFiles(content, results, cwd), commands };
}
