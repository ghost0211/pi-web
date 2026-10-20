"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AssistantMessage } from "@/lib/types";
import type { StreamingState, StreamingStore } from "@/lib/streaming-message";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Subscribes to a single derived value from the streaming store;
 * the component re-renders only when that value changes.
 *
 * Uses plain React state rather than useSyncExternalStore:
 * useSyncExternalStore forces a synchronous re-render for every incoming chunk
 * without microtask batching, which causes heavy markdown/syntax re-parsing on
 * every token during long streaming sessions.
 * Plain React state updates allow React 19 to automatically batch rapid deltas
 * landing in the same tick while isolating re-renders to components that
 * actually consume the changed slice.
 */
export function useStreamingSelector<T>(
  store: StreamingStore,
  select: (state: StreamingState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const [record, setRecord] = useState(() => ({
    store,
    value: select(store.getState()),
  }));

  // Synchronously adapt if the store instance changes (e.g. session switch)
  let currentValue = record.value;
  if (record.store !== store) {
    currentValue = select(store.getState());
    setRecord({ store, value: currentValue });
  }

  const latestValueRef = useRef(currentValue);
  latestValueRef.current = currentValue;

  useIsomorphicLayoutEffect(() => {
    const update = () => {
      const nextValue = select(store.getState());
      if (!equalityFn(latestValueRef.current, nextValue)) {
        latestValueRef.current = nextValue;
        setRecord({ store, value: nextValue });
      }
    };

    // A chunk may have landed between render and subscription effect
    update();
    return store.subscribe(update);
  }, [store, select, equalityFn]);

  return currentValue;
}

export const selectIsStreaming = (state: StreamingState): boolean => state.isStreaming;
export const selectHasStreamingContent = (state: StreamingState): boolean =>
  Boolean(state.streamingMessage?.content.length);
export const selectStreamingMessage = (state: StreamingState): AssistantMessage | null =>
  state.streamingMessage;
