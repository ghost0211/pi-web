"use client";

/**
 * Per-family usage for the agent switcher.
 *
 * Reads once when the panel opens, then polls only while a member is running
 * and the page is visible. One request at a time, aborted on family change or
 * unmount, and a response for a previous family is discarded by generation so
 * stale numbers can never appear under a different session.
 *
 * Never starts a session: the endpoint only reads session files.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { totalFamilyUsage, type FamilyMemberUsage, type FamilyUsageTotal } from "@/lib/agent-family-usage";

const POLL_MS = 3_000;
const MAX_IDS = 32;

export interface FamilyUsageState {
  usage: Record<string, FamilyMemberUsage>;
  total: FamilyUsageTotal | null;
  incomplete: boolean;
}

const EMPTY: FamilyUsageState = { usage: {}, total: null, incomplete: false };

export function useFamilyUsage(
  rootSession: SessionInfo,
  subagents: readonly SessionInfo[],
  running: boolean,
): FamilyUsageState {
  const [state, setState] = useState<FamilyUsageState>(EMPTY);
  const generationRef = useRef(0);
  const familyKey = useMemo(
    () => [rootSession.id, ...subagents.map((session) => session.id)].slice(0, MAX_IDS).join(","),
    [rootSession.id, subagents],
  );
  const familyKeyRef = useRef(familyKey);
  familyKeyRef.current = familyKey;

  useEffect(() => {
    const ids = familyKey.split(",").filter(Boolean);
    if (ids.length === 0) {
      setState(EMPTY);
      return;
    }
    // A new family starts from scratch: showing the previous family's numbers
    // while the first response is in flight would attribute costs wrongly.
    const generation = ++generationRef.current;
    setState(EMPTY);
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();

    const load = async (allowHidden = false) => {
      if (disposed || inFlight) return;
      // The first read happens because the panel was opened; only the periodic
      // poll waits for a visible tab.
      if (!allowHidden && document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const roles: Record<string, "main" | "subagent"> = {};
        for (const id of ids) roles[id] = id === ids[0] ? "main" : "subagent";
        const response = await fetch("/api/sessions/stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, roles }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json() as { stats?: Record<string, FamilyMemberUsage> };
        if (disposed || generation !== generationRef.current || !data.stats) return;
        const members = Object.values(data.stats);
        const total = members.length > 0 ? totalFamilyUsage(members) : null;
        setState({
          usage: data.stats,
          total,
          incomplete: Boolean(total?.costIncomplete || total?.durationEstimated),
        });
      } catch {
        // Best effort: rows keep whatever they last showed.
      } finally {
        inFlight = false;
      }
    };

    void load(true);
    const timer = running ? setInterval(() => void load(), POLL_MS) : null;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [familyKey, running]);

  return state;
}
