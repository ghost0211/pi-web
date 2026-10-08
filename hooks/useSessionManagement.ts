"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SessionManagementAction, SessionManagementState } from "@/lib/session-management-types";
import {
  getSessionManagementServerSnapshot,
  getSessionManagementSnapshot,
  loadSessionManagement,
  refreshSessionManagement,
  subscribeSessionManagement,
  updateSessionManagement,
} from "@/lib/session-management-client";

export interface UseSessionManagementResult {
  state: SessionManagementState | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (action: SessionManagementAction) => Promise<SessionManagementState>;
}

/** Shared server-backed session metadata for Settings and sidebar consumers. */
export function useSessionManagement(): UseSessionManagementResult {
  const snapshot = useSyncExternalStore(
    subscribeSessionManagement,
    getSessionManagementSnapshot,
    getSessionManagementServerSnapshot,
  );

  useEffect(() => {
    // The store records bootstrap errors for every hook consumer; the effect
    // observes the rejection to avoid an unhandled promise on mount.
    void loadSessionManagement().catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    await refreshSessionManagement();
  }, []);
  const update = useCallback((action: SessionManagementAction) => (
    updateSessionManagement(action)
  ), []);

  return {
    state: snapshot.state,
    ready: snapshot.ready,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
    update,
  };
}
