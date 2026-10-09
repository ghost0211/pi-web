"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentEndInfo, AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { buildChatMessageGroups, findFinalAssistantIndex, needsStreamingFollowUpLabel } from "@/lib/chat-message-groups";
import type { WrittenFile } from "@/lib/turn-written-files";
import { buildTurnOutcome } from "@/lib/turn-outcome";
import { TurnOutcomeCard } from "./TurnOutcomeCard";
import { getFileName } from "@/lib/file-paths";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ChatScrollbar } from "./ChatScrollbar";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { KimiTaskDock } from "./KimiTaskDock";
import { DirectoryPicker } from "./DirectoryPicker";
import { RemoteDirPicker } from "./RemoteDirPicker";
import { AnsiText } from "./AnsiText";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { extractAssistantSnippet } from "@/lib/notification-text";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsDesktopApp } from "@/hooks/useIsDesktopApp";
import { appDisplayName } from "@/lib/app-brand";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { SessionSystemPromptCustomization } from "@/lib/session-system-prompt";
import type { ToolEntry } from "@/lib/tool-presets";
import {
  captureScrollDistance,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  searchJump?: { entryId: string; requestId: number } | null;
  sessionRunning?: boolean;
  /** Sub-agent tabs are observational: only their parent agent can send commands. */
  readOnly?: boolean;
  /** Archived sessions remain live/observable but cannot be changed or sent to. */
  archived?: boolean;
  /** Fail closed until server metadata and legacy migration are acknowledged. */
  managementPending?: boolean;
  archivedRestoring?: boolean;
  onRestoreArchived?: () => void;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: (info?: AgentEndInfo) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, onSetEntryLabel?: (entryId: string, label: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onCustomSystemPromptChange?: (custom: SessionSystemPromptCustomization | null) => void;
  onSystemPromptSaverChange?: (saver: ((custom: SessionSystemPromptCustomization | null) => Promise<void>) | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenGitDiff?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  subagentSessions?: readonly SessionInfo[];
  runningSessionIds?: ReadonlySet<string>;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
  recentProjects?: { root: string; key: string }[];
  onSelectCwd?: (cwd: string) => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const latest = phase.tools[phase.tools.length - 1];
    if (latest?.progress) {
      return `${t("chat.runningNamedTool", { name: latest.name })} ${latest.progress}`;
    }
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_COLUMN_PADDING = 16;

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, defaultExpanded = false, children, t }: { messageCount: number; toolCallCount: number; defaultExpanded?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, searchJump, sessionRunning, readOnly = false, archived = false, managementPending = false, archivedRestoring = false, onRestoreArchived, newSessionCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onNewSession, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onCustomSystemPromptChange, onSystemPromptSaverChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onOpenGitDiff, onOpenSession, subagentSessions, runningSessionIds, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio, recentProjects, onSelectCwd }: Props) {
  const { t, locale } = useI18n();
  const desktopShell = useIsDesktopApp();
  const appName = appDisplayName(desktopShell);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [projectMenuOpen]);
  const isReadOnlySubagent = readOnly || session?.relation?.kind === "subagent";
  const isReadOnlyConversation = isReadOnlySubagent || archived || managementPending;
  const isReadOnlyConversationRef = useRef(isReadOnlyConversation);
  isReadOnlyConversationRef.current = isReadOnlyConversation;
  const completionNotificationsEnabled = !isReadOnlySubagent;

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  // Latest messages for the completion-notification snippet. The ref is
  // synced after useAgentSession returns (see below); the callback reads it
  // lazily so it never closes over a stale timeline.
  const messagesForNotifyRef = useRef<AgentMessage[]>([]);
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.({ snippet: extractAssistantSnippet(messagesForNotifyRef.current) });
  }, [completionNotificationsEnabled, onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    if (isReadOnlyConversationRef.current) return;
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const {
    loading, error, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, firstEntryParentId, streamState,
    turnIndex, ensureEntryLoaded,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, customToolNames, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused,
    isAutoModelSelection,
    agentPhase,
    isNew,
    showScrollToBottom,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleCustomToolsChange, ephemeral, setEphemeral, handleThinkingLevelChange, loadSlashCommands, scrollUserMsgToTop, scrollToBottom,
    loadContext, activeLeafId, data,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onNewSession,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onCustomSystemPromptChange, onSystemPromptSaverChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
  });
  // Keep the notification snippet source current (see wrappedOnAgentEnd).
  messagesForNotifyRef.current = messages;
  const messageGroups = useMemo(() => buildChatMessageGroups(messages), [messages]);
  const sessionBusy = agentRunning || bashRunning;
  const handleConversationSend = useCallback(async (...args: Parameters<typeof handleSend>) => {
    if (isReadOnlyConversationRef.current) return;
    await handleSend(...args);
  }, [handleSend]);
  const handleConversationFork = useCallback((entryId: string) => {
    if (isReadOnlyConversationRef.current) return;
    return handleFork(entryId);
  }, [handleFork]);
  const handleConversationNavigate = useCallback((entryId: string) => {
    if (isReadOnlyConversationRef.current) return;
    return handleNavigate(entryId);
  }, [handleNavigate]);
  const handleConversationBuiltinSlashCommand = useCallback(async (text: string) => {
    if (isReadOnlyConversationRef.current) return { handled: false };
    return handleBuiltinSlashCommand(text);
  }, [handleBuiltinSlashCommand]);

  useEffect(() => {
    if (
      !completionNotificationsEnabled
      || !extensionDialog
      || soundedExtensionDialogIdRef.current === extensionDialog.id
    ) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    // A sub-agent pane must not replace the main conversation's Esc handler.
    if (!isReadOnlySubagent) registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort, isReadOnlySubagent]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const railJumpRequestsRef = useRef(0);
  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // No older history loaded yet: fetch the previous page from the server
        // and prepend it (loadContext handles prepend + scroll anchoring).
        // Skip while a page is already loading or nothing older exists.
        if (loadingOlderRef.current || railJumpRequestsRef.current > 0) return;
        if (!hasEarlierMessages) return;
        const oldestId = historyCursor;
        if (!oldestId) return;
        const sid = session?.id ?? sessionIdRef.current;
        if (!sid) return;
        loadingOlderRef.current = true;
        prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        void loadContext(sid, activeLeafId, oldestId).finally(() => {
          loadingOlderRef.current = false;
        });
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyCursor, hasEarlierMessages, session, activeLeafId, loadContext, sessionIdRef, scrollContainerRef]);

  // Keep the rendered window at least as large as what's loaded, so prepended
  // (older) pages stay visible instead of being sliced off the top.
  useEffect(() => {
    setVisibleCount((current) => Math.max(current, messages.length));
  }, [messages.length]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (railJumpRequestsRef.current > 0) prevScrollDistanceRef.current = null;
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    if (!isReadOnlyConversationRef.current) chatInputRef?.current?.addFiles(files);
  }, [chatInputRef]);
  const onDesktopPathDrop = useCallback((paths: string[]) => {
    if (!isReadOnlyConversationRef.current) chatInputRef?.current?.addLocalFiles(paths);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop, onDesktopPathDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);
  const [jumpToScroll, setJumpToScroll] = useState<{ entryId: string; requestId: number } | null>(null);
  useEffect(() => {
    if (!searchJump || loading || !session) return;
    let cancelled = false;
    void ensureEntryLoaded(session.id, searchJump.entryId).then((found) => {
      if (!cancelled && found) setJumpToScroll(searchJump);
    });
    return () => { cancelled = true; };
  }, [searchJump, loading, session, ensureEntryLoaded]);

  useLayoutEffect(() => {
    if (!jumpToScroll) return;
    const index = entryIds.indexOf(jumpToScroll.entryId);
    if (index < 0) return;
    const visibleIndex = messages[index]?.role === "user" || messages[index]?.role === "assistant"
      ? index
      : messages.findIndex((message, i) => i > index && (message.role === "user" || message.role === "assistant"));
    if (visibleIndex < 0) { setJumpToScroll(null); return; }
    const needed = messages.length - visibleIndex + 1;
    if (visibleCount < needed) { setVisibleCount(needed); return; }
    const refIndex = messages.slice(0, visibleIndex).filter((message) => message.role === "user" || message.role === "assistant").length;
    const element = messageRefs.current[refIndex];
    if (!element) return;
    // Let session-load scroll restoration finish before positioning a search hit.
    const frame = requestAnimationFrame(() => {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.style.outline = "2px solid var(--accent)";
      element.style.outlineOffset = "4px";
      window.setTimeout(() => { element.style.outline = ""; element.style.outlineOffset = ""; }, 2200);
      setJumpToScroll(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpToScroll, entryIds, messages, visibleCount, messageRefs]);
  const isMobile = useIsMobile();
  // Jump target for the turn rail: page history in until the turn renders,
  // then expand the rendered window so the rail can measure and scroll to it.
  const revealTurnForMinimap = useCallback(async (entryId: string): Promise<boolean> => {
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return false;
    // A deliberate rail jump takes priority over the top sentinel's ordinary
    // scroll restoration while older pages are being prepended.
    railJumpRequestsRef.current += 1;
    prevScrollDistanceRef.current = null;
    try {
      const loaded = await ensureEntryLoaded(sid, entryId);
      if (!loaded) return false;
      setVisibleCount((current) => Math.max(current, messages.length * 2));
      return true;
    } finally {
      railJumpRequestsRef.current -= 1;
    }
  }, [ensureEntryLoaded, messages.length, session?.id, sessionIdRef]);
  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight === promptAnchorSpacerHeightRef.current) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  useLayoutEffect(() => {
    promptAnchorUpdateRef.current?.();
  }, [streamState.streamingMessage]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const readOnlyNotice = (
    <div role="status" data-subagent-read-only="true" style={{ padding: "10px 16px", textAlign: "center", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
      {t("subagent.readOnly")}
    </div>
  );
  const managementPendingNotice = (
    <div role="status" data-session-status-pending="true" style={{ padding: "10px 16px", textAlign: "center", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
      {t("sessionSidebar.checkingStatus")}
      {sessionBusy && !isReadOnlySubagent && <button type="button" onClick={handleAbort} style={{ marginLeft: 12 }}>{t("chat.stopAgent")}</button>}
    </div>
  );
  const archivedReadOnlyNotice = (
    <div role="status" data-archived-read-only="true" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
      <span>{t("sessionSidebar.archivedReadOnly")}</span>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {sessionBusy && !isReadOnlySubagent && (
          <button type="button" onClick={handleAbort} aria-label={t("chat.stopAgent")} title={t("chat.stopAgent")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}>
            {t("chat.stopAgent")}
          </button>
        )}
        {!isReadOnlySubagent && (
          <button type="button" onClick={onRestoreArchived} disabled={archivedRestoring || !onRestoreArchived} aria-busy={archivedRestoring || undefined} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", cursor: archivedRestoring || !onRestoreArchived ? "not-allowed" : "pointer", opacity: archivedRestoring || !onRestoreArchived ? 0.6 : 1 }}>
            {t("sessionSidebar.restoreContinue")}
          </button>
        )}
      </div>
    </div>
  );
  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleConversationSend}
      onAbort={handleAbort}
      onSteer={!isReadOnlyConversation && agentRunning ? handleSteer : undefined}
      onFollowUp={!isReadOnlyConversation && agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={!isReadOnlyConversation && agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={isReadOnlyConversation ? undefined : handleModelChange}
      modelSwitching={modelSwitching}
      onCompact={!isReadOnlyConversation && (session || isNew) ? handleCompact : undefined}
      onAbortCompaction={isReadOnlyConversation ? undefined : handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      customToolNames={customToolNames}
      onToolPresetChange={!isReadOnlyConversation && (session || isNew) ? handleToolPresetChange : undefined}
      onCustomToolsChange={!isReadOnlyConversation && (session || isNew) ? handleCustomToolsChange : undefined}
      ephemeral={ephemeral}
      onEphemeralChange={!isReadOnlyConversation && isNew && !session ? setEphemeral : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={!isReadOnlyConversation && (session || isNew) ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={isReadOnlyConversation ? undefined : handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleConversationBuiltinSlashCommand}
      contextUsage={contextUsage}
      sessionStats={sessionStats}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={isReadOnlyConversation ? undefined : handleDragEnter}
      onDragOver={isReadOnlyConversation ? undefined : handleDragOver}
      onDragLeave={isReadOnlyConversation ? undefined : handleDragLeave}
      onDrop={isReadOnlyConversation ? undefined : handleDrop}
    >
      {isDragOver && !isReadOnlyConversation && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {!isReadOnlySubagent && extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {!isReadOnlySubagent && extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: 0,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      {isEmptyNew ? (
        <div className="kimi-new-session flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="kimi-new-session-stage w-full max-w-[760px]">
            <div className="text-center">
              <h1 className="mb-16 text-[32px] font-semibold tracking-[-0.03em] text-text">{appName}</h1>
              <p className="kimi-empty-copy text-[14px] text-text-muted">
                {locale.startsWith("zh") ? "还没有消息 — 在下方开始对话" : "No messages yet — type below to start the conversation"}
              </p>
            </div>

            {managementPending ? managementPendingNotice : archived ? archivedReadOnlyNotice : isReadOnlySubagent ? readOnlyNotice : chatInputElement}

            {messageCwd && !isReadOnlyConversation && (
              <div ref={projectMenuRef} className="relative mx-4 -mt-2">
                <button
                  type="button"
                  onClick={() => setProjectMenuOpen((prev) => !prev)}
                  className="kimi-new-workspace"
                  title={messageCwd}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                  </svg>
                  <span>{getFileName(messageCwd) || messageCwd}</span>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={projectMenuOpen ? "rotate-180" : ""}>
                    <polyline points="2 3.5 5 6.5 8 3.5" />
                  </svg>
                </button>
                {projectMenuOpen && (
                  <div className="absolute bottom-full left-0 z-50 mb-2 w-80 max-h-72 overflow-y-auto rounded-xl border border-border bg-bg p-1.5 shadow-xl">
                    <div className="px-2.5 py-1.5 text-[10px] font-semibold text-text-dim uppercase tracking-wider text-left">
                      {locale.startsWith("zh") ? "切换工作区工程目录" : "Switch Project Workspace"}
                    </div>
                    {recentProjects?.map((project) => {
                      const current = project.root === messageCwd;
                      return (
                        <button
                          key={project.key}
                          type="button"
                          onClick={() => { setProjectMenuOpen(false); onSelectCwd?.(project.root); }}
                          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${current ? "bg-bg-selected font-medium text-accent" : "text-text hover:bg-bg-hover"}`}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                          </svg>
                          <span className="min-w-0 flex-1 truncate">{getFileName(project.root) || project.root}</span>
                          {current && <span className="text-accent">✓</span>}
                        </button>
                      );
                    })}
                    <div className="my-1 border-t border-border" />
                    <button
                      type="button"
                      onClick={() => {
                        setProjectMenuOpen(false);
                        setDirPickerOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-bg-hover"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                        <line x1="12" y1="10" x2="12" y2="16" />
                        <line x1="9" y1="13" x2="15" y2="13" />
                      </svg>
                      <span className="min-w-0 flex-1 truncate">{t("sidebar.openDirectory")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProjectMenuOpen(false);
                        setRemotePickerOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-bg-hover"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <rect x="2" y="3" width="20" height="7" rx="2" />
                        <rect x="2" y="14" width="20" height="7" rx="2" />
                        <path d="M6 6.5h.01M6 17.5h.01" />
                      </svg>
                      <span className="min-w-0 flex-1 truncate">{t("sidebar.openRemoteDirectory")}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {!isReadOnlyConversation && dirPickerOpen && (
              <DirectoryPicker
                initialPath={messageCwd}
                onCancel={() => setDirPickerOpen(false)}
                onSelect={(chosenPath) => {
                  setDirPickerOpen(false);
                  onSelectCwd?.(chosenPath);
                }}
              />
            )}

            {!isReadOnlyConversation && remotePickerOpen && (
              <RemoteDirPicker
                onCancel={() => setRemotePickerOpen(false)}
                onSelect={(localPath) => {
                  setRemotePickerOpen(false);
                  onSelectCwd?.(localPath);
                }}
              />
            )}

            {!isReadOnlyConversation && <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />}
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        {isMobile ? null : (
          <ChatMinimap
            branchKey={activeLeafId}
            messages={messages}
            entryIds={entryIds}
            turnIndex={turnIndex}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealTurn={revealTurnForMinimap}
          />
        )}
        <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]">
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} style={{ width: "100%", minWidth: 0, maxWidth: 728, margin: "0 auto" }}>
            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (msg.role === "user" || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[]; parentFollowUp?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : msg.role === "user" && idx === 0 && !hasEarlierMessages
                      // "Edit from here" on the first message truncates the
                      // branch to before it, i.e. navigates to its parent (#628).
                      ? (firstEntryParentId ?? undefined)
                      : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = entryIds[idx] ?? idx;
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const messageView = (
                  <MessageView
                    key={`${keyPrefix}-view-${messageKey}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    onFork={isReadOnlyConversation || sessionBusy || isNew ? undefined : handleConversationFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={isReadOnlyConversation || sessionBusy ? undefined : handleConversationNavigate}
                    prevAssistantEntryId={isReadOnlyConversation || sessionBusy ? undefined : prevAssistantEntryId}
                    onEditContent={isReadOnlyConversation ? undefined : handleEditContent}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                  />
                );
                const view = options.parentFollowUp && msg.role === "assistant" ? (
                  <div key={`follow-up-${keyPrefix}-${messageKey}`}>
                    <div className="chat-parent-follow-up" data-parent-follow-up="true">{t("subagent.parentFollowUp")}</div>
                    {messageView}
                  </div>
                ) : messageView;
                if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
                return (
                  <div key={`${keyPrefix}-${messageKey}`} ref={attachVisibleRef(idx, currentRefIdx)}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (const group of messageGroups) {
                const { startIndex: userIdx, endIndex: endIdx, contentStartIndex } = group;
                const finalAssistantIdx = group.kind === "standalone" ? -1
                  : findFinalAssistantIndex(messages, contentStartIndex - 1, endIdx);
                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length;
                if (finalAssistantIdx === -1 || isLiveTail) {
                  let labeled = false;
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    const parentFollowUp = group.parentFollowUp && !labeled && messages[renderIdx].role === "assistant";
                    if (parentFollowUp) labeled = true;
                    rendered.push(renderMessage(renderIdx, { parentFollowUp }));
                  }
                  continue;
                }

                // Consecutive reports stay visible as source cards, never process details.
                for (let anchorIdx = userIdx; anchorIdx < contentStartIndex; anchorIdx++) {
                  rendered.push(renderMessage(anchorIdx));
                }

                const processIndices: number[] = [];
                for (let processIdx = contentStartIndex; processIdx < finalAssistantIdx; processIdx++) {
                  processIndices.push(processIdx);
                }
                const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalProcessMessage = finalSplit.processBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                  : null;
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;

                const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                if (processCount > 0) {
                  const processRefIdx = visibleProcessIndices
                    .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                    .find((value): value is number => typeof value === "number")
                    ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                  const processGroup = (
                    <ProcessDetailsGroup
                      messageCount={processCount}
                      defaultExpanded={!finalAnswerMessage}
                      t={t}
                      toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
                    >
                      {visibleProcessIndices.map((processIdx) => renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }))}
                      {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false, parentFollowUp: group.parentFollowUp && !finalAnswerMessage })}
                    </ProcessDetailsGroup>
                  );
                  rendered.push(
                    <div
                      key={`process-group-${entryIds[userIdx] ?? userIdx}-${entryIds[finalAssistantIdx] ?? finalAssistantIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {processGroup}
                    </div>,
                  );
                }

                if (finalAnswerMessage) {
                  rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage, parentFollowUp: group.parentFollowUp }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                rendered.push(
                  <TurnOutcomeCard
                    key={`outcome-${entryIds[userIdx] ?? userIdx}`}
                    outcome={buildTurnOutcome(messages.slice(userIdx + 1, endIdx), messageCwd)}
                    onOpenFile={onOpenFile}
                    onOpenGitDiff={onOpenGitDiff}
                    diffNotice={t("chat.reviewDiffNotice")}
                  />,
                );
              }
              const { startIndex } = getVisibleRenderWindow(rendered.length, visibleCount);
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier")}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {streamState.isStreaming && hasStreamingContent && streamState.streamingMessage && (
              <>
                {needsStreamingFollowUpLabel(messages, messageGroups.at(-1)) && (
                  <div className="chat-parent-follow-up" data-parent-follow-up="true">{t("subagent.parentFollowUp")}</div>
                )}
                <MessageView message={streamState.streamingMessage as AgentMessage} toolResults={toolResultsMap} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} />
              </>
            )}

            {agentRunning && !hasStreamingContent && agentPhase && (
              <div className="my-3 flex w-fit items-center gap-3 rounded-xl border border-border bg-bg-panel px-3.5 py-2.5 shadow-sm animate-pulse">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 font-serif text-[13px] font-bold text-white shadow-sm">
                  π
                </span>
                <span className="text-xs font-medium text-text-muted">
                  {phaseLabel(agentPhase, t)}
                </span>
                <span className="ml-1 inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-[pi-dot-jump_1.2s_infinite_ease-in-out]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-[pi-dot-jump_1.2s_infinite_ease-in-out_0.2s]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-[pi-dot-jump_1.2s_infinite_ease-in-out_0.4s]" />
                </span>
              </div>
            )}

            {bashRunning && !pendingBash && !agentRunning && (
              <div className="my-2 flex w-fit items-center gap-2 rounded-lg border border-border bg-bg-panel px-3 py-1.5 text-[12px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSession={onOpenSession}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
        {isMobile ? null : <ChatScrollbar scrollContainer={scrollContainerRef} />}
      </div>

      <div className="relative">
        <KimiTaskDock
          messages={messages}
          pendingBash={pendingBash}
          agentRunning={agentRunning || streamState.isStreaming}
          subagentSessions={subagentSessions}
          runningSessionIds={runningSessionIds}
          onOpenSession={onOpenSession}
          fallbackPlan={data?.history?.latestPlan ?? data?.context?.latestPlan}
        />
        {managementPending ? managementPendingNotice : archived ? archivedReadOnlyNotice : isReadOnlySubagent ? readOnlyNotice : (
          <>
            {chatInputElement}
            <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />
          </>
        )}
        {/* scroll-to-latest floats above the composer when scrolled up (#845) */}
        {messages.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              className={`chat-scroll-to-bottom${showScrollToBottom ? " is-visible" : ""}`}
              title={t("chat.scrollToLatest")}
              aria-label={t("chat.scrollToLatest")}
              onClick={() => scrollToBottom("smooth")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

function NoticeShelf({ notices, floating = false, onPauseChange }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div
          style={{
            padding: 14,
            ...(request.method === "select"
              ? { flex: "1 1 auto", minHeight: 0, overflowY: "auto" }
              : {}),
          }}
        >
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(var(--app-viewport-height, 100dvh) - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, var(--app-viewport-height, 100dvh) - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
    </div>
  );
}
