"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
  buildTurnPreviews,
  mapTurnOffsets,
  type LocalTurnMeasure,
  type TurnPreview,
} from "@/lib/turn-index";
import type { AgentMessage } from "@/lib/types";
import styles from "./ChatMinimap.module.css";

interface Props {
  branchKey: string | null;
  messages: AgentMessage[];
  /** Entry ids parallel to `messages`; undefined for optimistic messages. */
  entryIds: (string | undefined)[];
  /** Whole-session turn index from the server; empty until it arrives. */
  turnIndex: TurnPreview[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  /** Loads history until `entryId` is rendered; resolves false when unavailable. */
  onRevealTurn: (entryId: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Turn rail geometry. One 3px bar per turn on a fixed 15px pitch, centered
// vertically when it fits. Longer sessions scroll within the rail; only the
// visible bars are mounted so neither the spacing nor DOM size depends on the
// length of the full session. The hover card stays outside the scrolling area.
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
const RAIL_OVERSCAN = 3;
const CARD_MAX_HEIGHT = 168;
const CARD_EDGE_PADDING = 8;
const PREVIEW_HIDE_DELAY = 180;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

interface RailBar {
  index: number;
  top: number;
  turn: TurnPreview;
}

/** Bar width for a given distance from the hovered bar (the lens falloff). */
function barWidthAt(distance: number): number {
  return LENS_WIDTHS[distance] ?? BAR_WIDTH;
}

/** Never crowd bars together; the scrollable content grows instead. */
export function railContentHeight(turnCount: number, railHeight: number): number {
  if (turnCount <= 1) return railHeight;
  return Math.max(railHeight, (turnCount - 1) * BAR_PITCH + RAIL_PADDING * 2 + BAR_HEIGHT);
}

/** Return only the bars near the rail's viewport, preserving global indices. */
export function layoutBars(turns: TurnPreview[], railHeight: number, scrollTop = 0): RailBar[] {
  if (turns.length === 0) return [];
  if (turns.length === 1) {
    return [{ index: 0, top: railHeight / 2, turn: turns[0] }];
  }
  const span = (turns.length - 1) * BAR_PITCH;
  if (span + RAIL_PADDING * 2 + BAR_HEIGHT <= railHeight) {
    const start = (railHeight - span) / 2;
    return turns.map((turn, index) => ({ index, top: start + index * BAR_PITCH, turn }));
  }
  const top = Math.max(0, Math.min(scrollTop, railContentHeight(turns.length, railHeight) - railHeight));
  const first = Math.max(0, Math.floor((top - RAIL_PADDING) / BAR_PITCH) - RAIL_OVERSCAN);
  const last = Math.min(turns.length, Math.ceil((top + railHeight - RAIL_PADDING) / BAR_PITCH) + RAIL_OVERSCAN);
  const bars: RailBar[] = [];
  for (let index = first; index < last; index++) {
    bars.push({ index, top: RAIL_PADDING + index * BAR_PITCH, turn: turns[index] });
  }
  return bars;
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

export function nextRailIndex(key: string, current: number, count: number, railHeight: number): number | null {
  if (count === 0) return null;
  const page = Math.max(1, Math.floor(railHeight / BAR_PITCH) - 2);
  const next = key === "ArrowUp" ? current - 1
    : key === "ArrowDown" ? current + 1
      : key === "PageUp" ? current - page
        : key === "PageDown" ? current + page
          : key === "Home" ? 0
            : key === "End" ? count - 1 : null;
  return next === null ? null : Math.max(0, Math.min(count - 1, next));
}

interface RailViewProps {
  turns: TurnPreview[];
  railHeight: number;
  activeIndex: number | null;
  hoveredIndex: number | null;
  onHoverBar: (index: number) => void;
  onLeaveRail: () => void;
  onJump: (index: number) => void;
}

/** Scrollable, windowed turn rail with the preview card outside the viewport. */
export function TurnRailView({
  turns,
  railHeight,
  activeIndex,
  hoveredIndex,
  onHoverBar,
  onLeaveRail,
  onJump,
}: RailViewProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentHeight = railContentHeight(turns.length, railHeight);
  const scrollable = contentHeight > railHeight;
  const bars = useMemo(() => layoutBars(turns, railHeight, scrollTop), [turns, railHeight, scrollTop]);
  const hoveredBar = hoveredIndex === null ? null : bars.find((bar) => bar.index === hoveredIndex);
  const selectedIndex = hoveredBar?.index
    ?? (activeIndex !== null && bars.some((bar) => bar.index === activeIndex) ? activeIndex : null)
    ?? Math.max(0, Math.min(turns.length - 1, Math.round((scrollTop + railHeight / 2 - RAIL_PADDING) / BAR_PITCH)));

  // Start at the latest turn, and follow the active turn only when it leaves
  // the viewport. Scrolling the rail to inspect older turns must not snap back.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !scrollable) return;
    const index = activeIndex ?? turns.length - 1;
    const top = RAIL_PADDING + index * BAR_PITCH;
    const margin = BAR_PITCH;
    if (top < viewport.scrollTop + margin || top > viewport.scrollTop + railHeight - margin) {
      viewport.scrollTop = Math.max(0, Math.min(
        contentHeight - railHeight,
        top - railHeight / 2,
      ));
      setScrollTop(viewport.scrollTop);
    }
  }, [activeIndex, contentHeight, railHeight, scrollable, turns.length]);

  const onRailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (turns.length === 0) return;
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      onJump(selectedIndex);
      return;
    }
    const index = nextRailIndex(event.key, selectedIndex, turns.length, railHeight);
    if (index === null) return;
    event.preventDefault();
    if (event.target !== event.currentTarget) event.currentTarget.focus();
    onHoverBar(index);
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = RAIL_PADDING + index * BAR_PITCH;
    if (top < viewport.scrollTop + BAR_PITCH || top > viewport.scrollTop + railHeight - BAR_PITCH) {
      viewport.scrollTop = Math.max(0, Math.min(contentHeight - railHeight, top - railHeight / 2));
      setScrollTop(viewport.scrollTop);
    }
  };

  return (
    <div
      className={styles.rail}
      data-can-scroll-up={scrollable && scrollTop > 1 ? "true" : undefined}
      data-can-scroll-down={scrollable && scrollTop < contentHeight - railHeight - 1 ? "true" : undefined}
      style={{ width: RAIL_WIDTH, height: railHeight }}
      onMouseLeave={onLeaveRail}
    >
      <div
        ref={viewportRef}
        className={styles.viewport}
        data-scrollable={scrollable ? "true" : undefined}
        tabIndex={scrollable ? 0 : -1}
        role="navigation"
        aria-label={`Conversation turns (${turns.length}); scroll or use arrow keys to browse`}
        onKeyDown={onRailKeyDown}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          if (document.activeElement !== event.currentTarget) onLeaveRail();
        }}
      >
        <div className={styles.track} style={{ height: contentHeight }}>
          {bars.map((bar) => {
            const distance = hoveredIndex === null ? null : Math.abs(bar.index - hoveredIndex);
            return (
              <button
                key={bar.index}
                type="button"
                className={styles.bar}
                data-turn-index={bar.index}
                tabIndex={scrollable ? -1 : 0}
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
        </div>
      </div>

      {hoveredBar && (
        <button
          type="button"
          className={styles.card}
          data-turn-preview={hoveredBar.index}
          style={{ top: cardTopFor(hoveredBar.top - scrollTop, railHeight) }}
          onMouseEnter={() => onHoverBar(hoveredBar.index)}
          onMouseLeave={onLeaveRail}
          onClick={() => onJump(hoveredBar.index)}
        >
          <span className={styles.cardOrdinal}>{hoveredBar.index + 1} / {turns.length}</span>
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
  branchKey,
  messages,
  entryIds,
  turnIndex,
  streamingMessage,
  scrollContainer,
  messageRefs,
  onRevealTurn,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [railHeight, setRailHeight] = useState(600);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const offsetsRef = useRef<Map<number, number>>(new Map());
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const pendingJumpRef = useRef<number | null>(null);
  const jumpGenerationRef = useRef(0);
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    jumpGenerationRef.current += 1;
    pendingJumpRef.current = null;
    offsetsRef.current = new Map();
    activeNodeLockRef.current = null;
    setActiveIndex(null);
    setHoveredIndex(null);
  }, [branchKey]);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage],
  );
  const allEntryIds = useMemo(
    () => (streamingMessage ? [...entryIds, undefined] : entryIds),
    [entryIds, streamingMessage],
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // The loaded window is the fallback for sessions the server has no index for
  // yet (a brand-new session) and the top-up for turns added since the index
  // was fetched. Head turns — placeholders for a window that starts mid-turn —
  // are never appended: they belong to the turn above, which the index knows.
  const localTurns = useMemo(() => buildTurnPreviews(allMessages, allEntryIds), [allMessages, allEntryIds]);
  const turns = useMemo(() => {
    if (turnIndex.length === 0) return localTurns;
    const known = new Set(turnIndex.map((turn) => turn.entryId));
    const extra = localTurns.filter((turn) => !turn.head && turn.entryId && !known.has(turn.entryId));
    return extra.length > 0 ? [...turnIndex, ...extra] : turnIndex;
  }, [localTurns, turnIndex]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const localTurnsRef = useRef(localTurns);
  localTurnsRef.current = localTurns;

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS,
    };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextOffsets: Map<number, number>) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;
    if (nextOffsets.size === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    let nextActive: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, top] of nextOffsets) {
      const distance = Math.abs(top - focusTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        nextActive = index;
      }
    }
    setActiveIndex(nextActive);
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
    syncActiveNode(scrollEl, offsetsRef.current);
  }, [scrollContainer, syncActiveNode]);

  const measureTurns = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;

      const refs = messageRefs.current;
      const containerRect = scrollEl.getBoundingClientRect();
      // Refs exist for rendered user/assistant messages only, in window order.
      const refIndexByMessage = new Map<number, number>();
      let refIndex = 0;
      allMessagesRef.current.forEach((message, index) => {
        if (message.role !== "user" && message.role !== "assistant") return;
        refIndexByMessage.set(index, refIndex);
        refIndex += 1;
      });

      const currentTurns = turnsRef.current;
      const localMeasures: LocalTurnMeasure[] = localTurnsRef.current.map((turn) => {
        const elementIndex = turn.messageIndex === undefined
          ? undefined
          : refIndexByMessage.get(turn.messageIndex);
        const element = elementIndex === undefined ? null : refs?.[elementIndex] ?? null;
        if (!element) {
          // Only a compaction card borrows an offset; an unrendered message
          // must wait for its element instead of jumping to a neighbour.
          const message = turn.messageIndex === undefined ? null : allMessagesRef.current[turn.messageIndex];
          return { top: null, borrowNext: message?.role === "custom" && message.customType === "compaction" };
        }
        return {
          top: element.getBoundingClientRect().top - containerRect.top + scrollEl.scrollTop,
        };
      });
      const nextOffsets = mapTurnOffsets(localMeasures, currentTurns.length, scrollEl.scrollHeight);
      offsetsRef.current = nextOffsets;
      setRailHeight(scrollEl.clientHeight);
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
      syncActiveNode(scrollEl, nextOffsets);

      const pending = pendingJumpRef.current;
      if (pending !== null) {
        const top = nextOffsets.get(pending);
        if (top !== undefined) {
          pendingJumpRef.current = null;
          lockActiveNode(pending);
          scrollEl.scrollTo({
            top: Math.max(0, top - scrollEl.clientHeight * 0.3),
            behavior: "smooth",
          });
        }
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
  }, [messages.length, turns.length, measureTurns, updateScroll]);

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

  const requestJump = useCallback((index: number) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const turn = turnsRef.current[index];
    if (!turn) return;
    const generation = ++jumpGenerationRef.current;
    pendingJumpRef.current = null;
    lockActiveNode(index);
    const top = offsetsRef.current.get(index);
    if (top !== undefined) {
      scrollEl.scrollTo({
        top: Math.max(0, top - scrollEl.clientHeight * 0.3),
        behavior: "smooth",
      });
      return;
    }
    // Turn sits outside the loaded window: page history in until it renders,
    // then the measurement pass above performs the jump.
    if (!turn.entryId) return;
    pendingJumpRef.current = index;
    void onRevealTurn(turn.entryId).then((loaded) => {
      if (!loaded && jumpGenerationRef.current === generation) pendingJumpRef.current = null;
    });
  }, [lockActiveNode, onRevealTurn, scrollContainer]);

  if (!visible || turns.length === 0) return null;

  return (
    <TurnRailView
      turns={turns}
      railHeight={railHeight}
      activeIndex={activeIndex}
      hoveredIndex={hoveredIndex}
      onHoverBar={(index) => {
        cancelPreviewHide();
        setHoveredIndex(index);
      }}
      onLeaveRail={schedulePreviewHide}
      onJump={requestJump}
    />
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
