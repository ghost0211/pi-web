"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { normalizeDisplayMath } from "@/lib/markdown";
import { splitFinalAssistantBlocks } from "@/lib/message-display";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";
import styles from "./ChatMinimap.module.css";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onRevealHistory: () => void;
}

// ---------------------------------------------------------------------------
// Turn rail geometry. One 3px bar per turn on a fixed 15px pitch, left aligned
// in a slim column at the left edge of the chat area. On hover the bar under
// the pointer grows into a lens and its neighbours taper with distance, while
// a compact card with that turn's prompt + answer summary opens to the right.
// The rail compresses its pitch instead of scrolling once the turns outgrow
// the column, so every turn stays reachable without touching the mouse wheel.
// ---------------------------------------------------------------------------
const RAIL_WIDTH = 56;
const BAR_LEFT = 16;
const BAR_HEIGHT = 3;
const BAR_PITCH = 15;
const BAR_WIDTH = 9;
const BAR_LENS_WIDTH = 39;
/**
 * Bar widths for the hovered bar and its neighbours, measured from the
 * reference design: 39 → 30 → 21 → 15, then the resting width.
 */
const LENS_WIDTHS = [BAR_LENS_WIDTH, 30, 21, 15];
const RAIL_PADDING = 12;
const CARD_MAX_HEIGHT = 168;
const CARD_EDGE_PADDING = 8;
const PREVIEW_HIDE_DELAY = 180;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

interface TurnInfo {
  /**
   * Label shown for the turn: the user prompt, a compaction summary, or the
   * first line of a leading segment when the lazy-loaded window starts
   * mid-turn (no anchor message in range yet).
   */
  previewText: string;
  /** Plain-text digest of the turn's final answer, shown under the prompt. */
  summary: string;
  scrollTop: number | null;
}

interface RailBar {
  index: number;
  top: number;
  turn: TurnInfo;
}

function getMessagePreview(message: { content?: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block): block is TextContent => (block as TextContent)?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return "";
}

function firstTextLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return (line ?? "").replace(/^#+\s*/, "") || "…";
}

function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "assistant") return "";
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/**
 * Flattens an answer into the single paragraph shown under the prompt in the
 * hover card: markdown structure (headings, lists, emphasis, tables, code
 * fences) is dropped and math delimiters are unwrapped so the digest reads as
 * prose instead of source.
 */
export function turnSummaryFromMarkdown(markdown: string): string {
  return normalizeDisplayMath(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/[*~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bar width for a given distance from the hovered bar (the lens falloff). */
function barWidthAt(distance: number): number {
  return LENS_WIDTHS[distance] ?? BAR_WIDTH;
}

/**
 * Places the bars on a fixed pitch, compressing it only when the turns would
 * otherwise overflow the rail.
 */
export function layoutBars(turns: TurnInfo[], railHeight: number): RailBar[] {
  if (turns.length === 0) return [];
  if (turns.length === 1) {
    return [{ index: 0, top: Math.max(RAIL_PADDING, railHeight / 2), turn: turns[0] }];
  }
  const usable = Math.max(0, railHeight - RAIL_PADDING * 2);
  const pitch = Math.min(BAR_PITCH, usable / (turns.length - 1));
  return turns.map((turn, index) => ({
    index,
    top: RAIL_PADDING + index * pitch,
    turn,
  }));
}

/**
 * Keeps the preview card inside the chat area while it stays vertically
 * centered on the hovered bar.
 */
export function cardTopFor(barTop: number, railHeight: number): number {
  const half = CARD_MAX_HEIGHT / 2;
  const min = half + CARD_EDGE_PADDING;
  const max = railHeight - half - CARD_EDGE_PADDING;
  if (max < min) return railHeight / 2;
  return Math.min(max, Math.max(min, barTop));
}

interface RailViewProps {
  bars: RailBar[];
  railHeight: number;
  activeIndex: number | null;
  hoveredIndex: number | null;
  onHoverBar: (index: number) => void;
  onLeaveRail: () => void;
  onJump: (index: number) => void;
}

/**
 * Presentational turn rail: one bar per turn plus the hover preview card.
 * Kept free of measurement state so the geometry is directly testable.
 */
export function TurnRailView({
  bars,
  railHeight,
  activeIndex,
  hoveredIndex,
  onHoverBar,
  onLeaveRail,
  onJump,
}: RailViewProps) {
  const hoveredBar = hoveredIndex === null ? null : (bars[hoveredIndex] ?? null);
  return (
    <div
      className={styles.rail}
      style={{ width: RAIL_WIDTH }}
      onMouseLeave={onLeaveRail}
    >
      {bars.map((bar) => {
        const distance = hoveredIndex === null ? null : Math.abs(bar.index - hoveredIndex);
        return (
          <button
            key={bar.index}
            type="button"
            className={styles.bar}
            data-turn-index={bar.index}
            data-active={activeIndex === bar.index ? "true" : undefined}
            data-hovered={hoveredIndex === bar.index ? "true" : undefined}
            style={{
              top: bar.top,
              left: BAR_LEFT,
              width: distance === null ? BAR_WIDTH : barWidthAt(distance),
              height: BAR_HEIGHT,
            }}
            aria-label={`Jump to turn ${bar.index + 1}: ${bar.turn.previewText}`}
            title={bar.turn.previewText}
            onMouseEnter={() => onHoverBar(bar.index)}
            onFocus={() => onHoverBar(bar.index)}
            onBlur={onLeaveRail}
            onClick={() => onJump(bar.index)}
          />
        );
      })}

      {hoveredBar && (
        <button
          type="button"
          className={styles.card}
          data-turn-preview={hoveredBar.index}
          style={{ top: cardTopFor(hoveredBar.top, railHeight) }}
          onMouseEnter={() => onHoverBar(hoveredBar.index)}
          onMouseLeave={onLeaveRail}
          onClick={() => onJump(hoveredBar.index)}
        >
          <span className={styles.cardPrompt}>{hoveredBar.turn.previewText}</span>
          {hoveredBar.turn.summary && (
            <span className={styles.cardSummary}>{hoveredBar.turn.summary}</span>
          )}
        </button>
      )}
    </div>
  );
}

export function ChatMinimap({
  messages,
  streamingMessage,
  scrollContainer,
  messageRefs,
  onRevealHistory,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [turns, setTurns] = useState<TurnInfo[]>([]);
  const [railHeight, setRailHeight] = useState(600);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const turnsRef = useRef<TurnInfo[]>([]);
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const pendingNavigationRef = useRef<number | null>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage],
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const bars = useMemo(() => layoutBars(turns, railHeight), [turns, railHeight]);

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS,
    };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextTurns: TurnInfo[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;

    const measured = nextTurns
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => turn.scrollTop !== null);
    if (measured.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const next = measured.reduce((best, candidate) => (
      Math.abs((candidate.turn.scrollTop ?? 0) - focusTop)
        < Math.abs((best.turn.scrollTop ?? 0) - focusTop)
        ? candidate
        : best
    ), measured[0]);
    setActiveIndex(next.index);
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
    syncActiveNode(scrollEl, turnsRef.current);
  }, [scrollContainer, syncActiveNode]);

  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureTurns = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;

      const refs = messageRefs.current;
      const containerRect = scrollEl.getBoundingClientRect();
      const measureTop = (element: HTMLDivElement | null): number | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.top - containerRect.top + scrollEl.scrollTop;
      };
      const nextTurns: TurnInfo[] = [];
      let refIndex = 0;
      let currentTurn: TurnInfo | null = null;
      // A compaction summary anchors a turn like a user prompt (mirroring
      // ChatWindow's isGroupAnchor) but carries no message ref, so the turn's
      // measured anchor is the first message rendered after it.
      let pendingAnchorText: string | null = null;

      for (const message of allMessagesRef.current) {
        const isUser = message.role === "user";
        const isAssistant = message.role === "assistant";
        if (!isUser && !isAssistant) {
          if (
            message.role === "custom"
            && (message as { customType?: string }).customType === "compaction"
          ) {
            pendingAnchorText = firstTextLine(getMessagePreview(message));
            currentTurn = null;
          }
          continue;
        }
        const element = refs?.[refIndex] ?? null;
        refIndex++;

        if (isUser) {
          pendingAnchorText = null;
          currentTurn = {
            previewText: getMessagePreview(message) || "…",
            summary: "",
            scrollTop: measureTop(element),
          };
          nextTurns.push(currentTurn);
          continue;
        }

        // Assistant message: fold it into the current turn. When the lazy
        // loaded window starts mid-turn (no anchor message before it), open a
        // head turn so the rail is never empty on long sessions.
        const answerMarkdown = getAssistantAnswerMarkdown(message);
        if (!currentTurn && (pendingAnchorText !== null || nextTurns.length === 0)) {
          currentTurn = {
            previewText: pendingAnchorText ?? firstTextLine(answerMarkdown),
            summary: "",
            scrollTop: measureTop(element),
          };
          pendingAnchorText = null;
          nextTurns.push(currentTurn);
        }
        if (!currentTurn) continue;
        if (answerMarkdown) {
          currentTurn.summary = turnSummaryFromMarkdown(answerMarkdown);
        }
      }

      turnsRef.current = nextTurns;
      setTurns(nextTurns);
      setRailHeight(scrollEl.clientHeight);
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
      syncActiveNode(scrollEl, nextTurns);

      const pendingIndex = pendingNavigationRef.current;
      const pendingTurn = pendingIndex === null ? null : nextTurns[pendingIndex];
      if (pendingIndex !== null && pendingTurn && pendingTurn.scrollTop !== null) {
        pendingNavigationRef.current = null;
        lockActiveNode(pendingIndex);
        scrollEl.scrollTo({
          top: Math.max(0, pendingTurn.scrollTop - scrollEl.clientHeight * 0.3),
          behavior: "smooth",
        });
      }
    }, 150);
  }, [lockActiveNode, messageRefs, scrollContainer, syncActiveNode]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updateScroll, { passive: true });
    return () => el.removeEventListener("scroll", updateScroll);
  }, [scrollContainer, updateScroll]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      measureTurns();
      updateScroll();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [measureTurns, scrollContainer, updateScroll]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      measureTurns();
      updateScroll();
    }, 50);
    return () => clearTimeout(timeout);
  }, [messages.length, measureTurns, updateScroll]);

  const scrollToTurn = useCallback((index: number, behavior: ScrollBehavior) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const turn = turnsRef.current[index];
    if (!turn) return;
    lockActiveNode(index);
    if (turn.scrollTop === null) {
      pendingNavigationRef.current = index;
      onRevealHistory();
      return;
    }
    scrollEl.scrollTo({
      top: Math.max(0, turn.scrollTop - scrollEl.clientHeight * 0.3),
      behavior,
    });
  }, [lockActiveNode, onRevealHistory, scrollContainer]);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      setHoveredIndex(null);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  if (!visible || turns.length === 0) return null;

  return (
    <TurnRailView
      bars={bars}
      railHeight={railHeight}
      activeIndex={activeIndex}
      hoveredIndex={hoveredIndex}
      onHoverBar={(index) => {
        cancelPreviewHide();
        setHoveredIndex(index);
      }}
      onLeaveRail={schedulePreviewHide}
      onJump={(index) => scrollToTurn(index, "smooth")}
    />
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
