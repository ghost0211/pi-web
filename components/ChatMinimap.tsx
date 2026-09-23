"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  buildTurnPreviews,
  mapTurnOffsets,
  type LocalTurnMeasure,
  type TurnPreview,
} from "@/lib/turn-index";
import type { AgentMessage } from "@/lib/types";
import styles from "./ChatMinimap.module.css";

interface Props {
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
// vertically in a slim column at the left edge of the chat area. On hover the
// bar under the pointer grows into a lens and its neighbours taper with
// distance, while a compact card with that turn's prompt + answer summary opens
// to the right. The rail compresses its pitch instead of scrolling once the
// turns outgrow the column, so every turn stays reachable without touching the
// mouse wheel.
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

interface RailBar {
  index: number;
  top: number;
  turn: TurnPreview;
}

/** Bar width for a given distance from the hovered bar (the lens falloff). */
function barWidthAt(distance: number): number {
  return LENS_WIDTHS[distance] ?? BAR_WIDTH;
}

/**
 * Places the bars on a fixed pitch — compressed only when the turns would
 * otherwise overflow the rail — and centers the block vertically.
 */
export function layoutBars(turns: TurnPreview[], railHeight: number): RailBar[] {
  if (turns.length === 0) return [];
  if (turns.length === 1) {
    return [{ index: 0, top: railHeight / 2, turn: turns[0] }];
  }
  const usable = Math.max(0, railHeight - RAIL_PADDING * 2);
  const pitch = Math.min(BAR_PITCH, usable / (turns.length - 1));
  const span = pitch * (turns.length - 1);
  const start = Math.max(RAIL_PADDING, (railHeight - span) / 2);
  return turns.map((turn, index) => ({
    index,
    top: start + index * pitch,
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
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const bars = useMemo(() => layoutBars(turns, railHeight), [turns, railHeight]);

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
          // Compaction cards anchor a turn but render no measurable element.
          return { top: null, borrowNext: true };
        }
        return {
          top: element.getBoundingClientRect().top - containerRect.top + scrollEl.scrollTop,
        };
      });
      const nextOffsets = mapTurnOffsets(localMeasures, currentTurns.length);
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
      if (!loaded && pendingJumpRef.current === index) pendingJumpRef.current = null;
    });
  }, [lockActiveNode, onRevealTurn, scrollContainer]);

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
