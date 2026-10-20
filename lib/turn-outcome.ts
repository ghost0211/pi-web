import type { AgentMessage, AssistantContentBlock, ToolResultMessage } from "./types";
import { extractTurnClaimedFiles, extractTurnWrittenFiles, type WrittenFile } from "./turn-written-files";
import { isShellCommandToolName } from "./tool-names";
import { parsePresentFilesDetails, presentPathKey, PRESENT_FILES_TOOL_NAME, type PresentFilesDetails } from "./present-files";

export interface TurnCommand {
  id: string;
  command: string;
  status: "completed" | "failed" | "unknown";
  output: string;
  truncated: boolean;
}

export interface TurnOutcome {
  /**
   * Artifacts the model explicitly declared through `present_files` and the
   * server verified. These lead the results card; everything else is secondary.
   */
  deliverables: PresentFilesDetails | null;
  files: WrittenFile[];
  /**
   * Paths the reply text claims as deliverables without a matching write/edit
   * tool call (typically shell-generated outputs). Candidates only — callers
   * must corroborate them (existence + mtime inside the turn window) before
   * display; see `extractTurnClaimedFiles`.
   */
  claimed: WrittenFile[];
  commands: TurnCommand[];
}

const OUTPUT_PREVIEW_LIMIT = 4000;

/** Slack between entry timestamps and filesystem mtimes (clock skew, queued entries). */
export const CLAIMED_MTIME_SLACK_MS = 120_000;

/**
 * A claimed path counts as a turn deliverable only when the file exists and
 * its mtime falls inside the turn window. `sinceTs` is the turn's
 * user-message timestamp (ms); without it no claim can be verified.
 */
export function isClaimedFileFromTurn(meta: { mtimeMs?: unknown }, sinceTs: number | undefined): boolean {
  if (typeof sinceTs !== "number" || !Number.isFinite(sinceTs)) return false;
  return typeof meta.mtimeMs === "number" && meta.mtimeMs >= sinceTs - CLAIMED_MTIME_SLACK_MS;
}

/**
 * Collect the last successful `present_files` declaration in the turn.
 *
 * Only a non-error result from the tool itself counts, and only when its
 * `details` carries this version's marker. A later declaration supersedes an
 * earlier one in the same turn, matching the model's intent when it corrects
 * itself; items across declarations are not merged, so a withdraw-and-redeclare
 * actually withdraws.
 */
export function extractTurnDeliverables(messages: readonly AgentMessage[]): PresentFilesDetails | null {
  let found: PresentFilesDetails | null = null;
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    if (message.toolName !== PRESENT_FILES_TOOL_NAME) continue;
    if (message.isError) continue;
    const parsed = parsePresentFilesDetails(message.details);
    if (parsed) found = parsed;
  }
  return found;
}

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
    // The built-in bash/powershell contract is known ({command} input,
    // exit on completion). Custom tools may use different arguments or
    // completion semantics, so do not guess from their names.
    if (block.type !== "toolCall" || !isShellCommandToolName(block.toolName) || seen.has(block.toolCallId)) continue;
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
  const files = extractTurnWrittenFiles(content, results, cwd);
  const deliverables = extractTurnDeliverables(messages);
  // A declared deliverable is shown once, at the top. Drop it from the
  // secondary write list and from the reply-text fallback so the same file
  // cannot appear three times in one card.
  const deliverableKeys = new Set((deliverables?.items ?? []).map((item) => presentPathKey(item.abs)));
  const isDeliverable = (filePath: string) => deliverableKeys.has(presentPathKey(filePath));
  return {
    deliverables,
    files: files.filter((file) => !isDeliverable(file.filePath)),
    claimed: extractTurnClaimedFiles(content, files, cwd).filter((file) => !isDeliverable(file.filePath)),
    commands,
  };
}
