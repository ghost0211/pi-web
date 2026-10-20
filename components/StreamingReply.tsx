"use client";

import { memo } from "react";
import { useStreamingSelector, selectStreamingMessage } from "@/hooks/useStreamingSelector";
import type { StreamingStore } from "@/lib/streaming-message";
import type { AgentMessage } from "@/lib/types";
import { ChatMinimap } from "./ChatMinimap";
import { MessageView } from "./MessageView";

/**
 * The in-progress assistant reply.
 *
 * Isolated so a streamed chunk re-renders this bubble instead of the whole
 * chat: `ChatWindow` only subscribes to "is streaming" / "has content", which
 * change once per reply, while the message itself updates on every chunk.
 */
export function StreamingReply({
  streamingStore,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  onOpenSession,
  followUpLabel,
}: {
  streamingStore: StreamingStore;
  toolResults: React.ComponentProps<typeof MessageView>["toolResults"];
  modelNames?: React.ComponentProps<typeof MessageView>["modelNames"];
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  followUpLabel?: string | null;
}) {
  const streamingMessage = useStreamingSelector(streamingStore, selectStreamingMessage);
  if (!streamingMessage) return null;
  return (
    <>
      {followUpLabel && (
        <div className="chat-parent-follow-up" data-parent-follow-up="true">{followUpLabel}</div>
      )}
      <MessageView
        message={streamingMessage as AgentMessage}
        toolResults={toolResults}
        isStreaming
        modelNames={modelNames}
        cwd={cwd}
        onOpenFile={onOpenFile}
        onOpenSession={onOpenSession}
      />
    </>
  );
}

/**
 * Turn rail for the open session.
 *
 * The rail consumes the streaming reply to show the in-progress turn, so it
 * subscribes on its own instead of forcing `ChatWindow` to re-render per chunk.
 * It mounts only while the rail is on screen.
 */
export const StreamingMinimap = memo(function StreamingMinimap({
  streamingStore,
  ...props
}: Omit<React.ComponentProps<typeof ChatMinimap>, "streamingMessage"> & { streamingStore: StreamingStore }) {
  const streamingMessage = useStreamingSelector(streamingStore, selectStreamingMessage);
  return <ChatMinimap {...props} streamingMessage={streamingMessage} />;
});
