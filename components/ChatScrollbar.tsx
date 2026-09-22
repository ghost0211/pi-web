"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import styles from "./ChatScrollbar.module.css";

// ---------------------------------------------------------------------------
// Slim custom scrollbar pinned to the far right of the chat window. The chat
// scroll container hides its native scrollbar (`[scrollbar-width:none]`), so
// this rail is the only draggable scroll affordance for browsing history.
// Sits at the opposite edge from the ChatMinimap turn rail.
// ---------------------------------------------------------------------------

interface Props {
  scrollContainer: RefObject<HTMLDivElement | null>;
}

interface ThumbState {
  top: number;
  height: number;
  /** Scroll progress 0-100 for aria-valuenow. */
  percent: number;
}

const MIN_THUMB_PX = 28;
const KEYBOARD_LINE_PX = 80;

export function ChatScrollbar({ scrollContainer }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<ThumbState | null>(null);
  const [dragging, setDragging] = useState(false);
  // aria-controls must reference the scrolled element; tag it lazily so the
  // rail keeps proper scrollbar semantics without threading an id through props.
  const scrollAreaId = useId();

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl || scrollEl.id) return;
    scrollEl.id = scrollAreaId;
    return () => {
      scrollEl.removeAttribute("id");
    };
  }, [scrollContainer, scrollAreaId]);

  const update = useCallback(() => {
    const scrollEl = scrollContainer.current;
    const railEl = railRef.current;
    if (!scrollEl || !railEl) return;
    const railHeight = railEl.clientHeight;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    const maxScrollTop = scrollHeight - clientHeight;
    if (railHeight <= 0 || maxScrollTop <= 1) {
      setThumb(null);
      return;
    }
    const height = Math.min(
      railHeight,
      Math.max(MIN_THUMB_PX, (clientHeight / scrollHeight) * railHeight),
    );
    const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop));
    const top = (clampedScrollTop / maxScrollTop) * (railHeight - height);
    setThumb({
      top,
      height,
      percent: Math.round((clampedScrollTop / maxScrollTop) * 100),
    });
  }, [scrollContainer]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    const railEl = railRef.current;
    if (!scrollEl || !railEl) return;
    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(railEl);
    ro.observe(scrollEl);
    if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
    return () => {
      scrollEl.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollContainer, update]);

  const handleThumbPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const scrollEl = scrollContainer.current;
    const railEl = railRef.current;
    if (!scrollEl || !railEl || !thumb) return;
    setDragging(true);
    const startY = event.clientY;
    const startScrollTop = scrollEl.scrollTop;
    const railTravel = railEl.clientHeight - thumb.height;
    const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;

    const onMove = (moveEvent: PointerEvent) => {
      if (railTravel <= 0) return;
      const deltaRatio = (moveEvent.clientY - startY) / railTravel;
      scrollEl.scrollTop = Math.max(
        0,
        Math.min(maxScrollTop, startScrollTop + deltaRatio * maxScrollTop),
      );
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [scrollContainer, thumb]);

  const handleRailPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const scrollEl = scrollContainer.current;
    const railEl = railRef.current;
    if (!scrollEl || !railEl || !thumb) return;
    const rect = railEl.getBoundingClientRect();
    const railTravel = rect.height - thumb.height;
    if (railTravel <= 0) return;
    // Jump so the thumb centers on the clicked position.
    const targetTop = event.clientY - rect.top - thumb.height / 2;
    const ratio = Math.max(0, Math.min(1, targetTop / railTravel));
    const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    scrollEl.scrollTo({ top: ratio * maxScrollTop, behavior: "smooth" });
    railEl.focus();
  }, [scrollContainer, thumb]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    const pageStep = scrollEl.clientHeight * 0.9;
    switch (event.key) {
      case "ArrowUp":
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - KEYBOARD_LINE_PX);
        break;
      case "ArrowDown":
        scrollEl.scrollTop = Math.min(maxScrollTop, scrollEl.scrollTop + KEYBOARD_LINE_PX);
        break;
      case "PageUp":
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - pageStep);
        break;
      case "PageDown":
        scrollEl.scrollTop = Math.min(maxScrollTop, scrollEl.scrollTop + pageStep);
        break;
      case "Home":
        scrollEl.scrollTop = 0;
        break;
      case "End":
        scrollEl.scrollTop = maxScrollTop;
        break;
      default:
        return;
    }
    event.preventDefault();
  }, [scrollContainer]);

  // The rail stays mounted (reserving its 12px column) even when there is
  // nothing to scroll so measurement/observers keep running and the layout
  // does not jump when a conversation grows past the viewport.
  return (
    <div
      ref={railRef}
      className={styles.rail}
      role="scrollbar"
      aria-orientation="vertical"
      aria-controls={scrollAreaId}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={thumb ? thumb.percent : 0}
      tabIndex={0}
      onPointerDown={handleRailPointerDown}
      onWheel={(event) => {
        const scrollEl = scrollContainer.current;
        if (!scrollEl) return;
        scrollEl.scrollTop += event.deltaY;
      }}
      onKeyDown={handleKeyDown}
    >
      {thumb && (
        <div
          className={styles.thumb}
          data-dragging={dragging ? "" : undefined}
          style={{ top: thumb.top, height: thumb.height }}
          onPointerDown={handleThumbPointerDown}
        />
      )}
    </div>
  );
}
