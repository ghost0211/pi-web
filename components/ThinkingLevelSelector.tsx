"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { normalizeThinkingLevelOption, THINKING_LEVEL_OPTIONS, type ThinkingLevelOption } from "@/lib/thinking-level-options";

type ThinkingTab = "primary" | "fallback";
type ModelRef = { provider: string; modelId: string };

interface Props {
  model?: ModelRef | null;
  level?: ThinkingLevelOption;
  onChange?: (level: ThinkingLevelOption) => void;
  availableLevels?: readonly string[] | null;
  levelMap?: Record<string, string | null> | null;
  fallbackModel?: ModelRef | null;
  fallbackLevel?: ThinkingLevelOption;
  onFallbackChange?: (level: ThinkingLevelOption) => void;
  fallbackAvailableLevels?: readonly string[] | null;
  fallbackLevelMap?: Record<string, string | null> | null;
  disabled?: boolean;
  isMobile?: boolean;
  /** Mobile hides the toolbar label until the more-controls menu is open. */
  showLabel?: boolean;
}

const DESC_KEYS: Record<ThinkingLevelOption, string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal",
  low: "chat.thinkingLow", medium: "chat.thinkingMedium", high: "chat.thinkingHigh",
  xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

export function ThinkingLevelSelector({
  model, level = "auto", onChange, availableLevels, levelMap,
  fallbackModel, fallbackLevel = "auto", onFallbackChange, fallbackAvailableLevels, fallbackLevelMap,
  disabled = false, isMobile = false, showLabel = true,
}: Props) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [placement, setPlacement] = useState<{ left: number; above: boolean; maxHeight: number } | null>(null);
  const entries = {
    primary: { model, level, onChange, availableLevels, levelMap },
    fallback: { model: fallbackModel, level: fallbackLevel, onChange: onFallbackChange, availableLevels: fallbackAvailableLevels, levelMap: fallbackLevelMap },
  };
  const tabs = (["primary", "fallback"] as const).filter((tab) => entries[tab].onChange);
  const status = (tab: ThinkingTab) => {
    const entry = entries[tab];
    const unsupported = entry.availableLevels != null && !entry.availableLevels.some((value) => value !== "off");
    const reason = !entry.model
      ? t(tab === "fallback" ? "chat.fallbackSelectFirst" : "chat.thinkingSelectModelFirst")
      : entry.availableLevels == null ? t("chat.thinkingLoading")
      : unsupported ? t("chat.thinkingUnsupported") : null;
    const selected = unsupported ? "off" : normalizeThinkingLevelOption(entry.level, entry.availableLevels);
    const display = selected === "auto" ? "auto" : entry.levelMap?.[selected] ?? selected;
    return { locked: disabled || !!reason || !entry.onChange, reason, selected, display };
  };
  const primary = status("primary");
  const fallback = status("fallback");
  const states = { primary, fallback };
  const locked = tabs.every((tab) => states[tab].locked);
  // Both model identities and editability belong to the panel. Never expose a
  // stale backup menu after a model change or a busy/read-only transition.
  const menuKey = JSON.stringify([model?.provider, model?.modelId, fallbackModel?.provider, fallbackModel?.modelId, primary.locked, fallback.locked]);
  const [menu, setMenu] = useState<{ key: string; open: boolean; tab: ThinkingTab }>({ key: menuKey, open: false, tab: "primary" });
  const open = menu.open && menu.key === menuKey && !locked;
  const tab = menu.tab;
  const entry = entries[tab];
  const current = states[tab];
  const label = t(tab === "primary" ? "chat.primaryThinkingLevel" : "chat.fallbackThinkingLevel");
  // The toolbar always summarizes the active/primary model, not the last tab
  // edited. Backup details live inside the panel and in the trigger tooltip.
  const summary = onChange ? primary : fallback;
  const title = tabs.map((value) => {
    const item = entries[value];
    const state = states[value];
    return `${t(value === "primary" ? "chat.primaryThinkingLevel" : "chat.fallbackThinkingLevel")}: ${state.display}\n${state.reason ?? `${item.model?.provider}/${item.model?.modelId}`}`;
  }).join("\n\n");

  useEffect(() => {
    setMenu({ key: menuKey, open: false, tab: "primary" });
  }, [menuKey]);
  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLButtonElement>("[role='tab'][aria-selected='true']")?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !rootRef.current || !panelRef.current) return;
    const position = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
      const width = panel.getBoundingClientRect().width;
      const desiredLeft = isMobile ? anchor.left : anchor.right - width;
      const left = Math.max(leftEdge, Math.min(desiredLeft, rightEdge - width)) - anchor.left;
      const aboveRoom = Math.max(0, anchor.top - topEdge - 6);
      const belowRoom = Math.max(0, bottomEdge - anchor.bottom - 6);
      const above = aboveRoom >= panel.scrollHeight + 2 || aboveRoom >= belowRoom;
      setPlacement({ left, above, maxHeight: above ? aboveRoom : belowRoom });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, tab, isMobile, label, entry.availableLevels, entry.levelMap]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu((current) => current.open ? { ...current, open: false } : current);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  if (tabs.length === 0) return null;
  return (
    <div ref={rootRef} data-thinking-selector="combined" style={{ position: "relative" }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); event.stopPropagation();
        setMenu((current) => ({ ...current, open: false }));
        rootRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']")?.focus();
      }
    }}>
      <button type="button" disabled={locked} aria-disabled={locked} aria-label={t("chat.changeReasoningLabel")}
        aria-haspopup="dialog" aria-expanded={open}
        title={locked ? summary.reason ?? title : title}
        onClick={() => {
          if (!locked) setMenu({ key: menuKey, open: !open, tab: primary.locked ? "fallback" : "primary" });
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          padding: isMobile ? "0 8px" : "0 9px", height: 28,
          background: open ? "var(--bg-selected)" : "var(--bg-hover)",
          border: "1px solid var(--border)", borderRadius: 8,
          color: locked ? "var(--text-dim)" : "var(--text)",
          cursor: locked ? "not-allowed" : "pointer", opacity: locked ? 0.5 : 1,
          fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
        }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
          <line x1="7" y1="18" x2="12" y2="18" /><line x1="8" y1="21" x2="11" y2="21" />
        </svg>
        {showLabel && <span>{t("chat.thinkingShort")}: {summary.display}</span>}
      </button>
      {open && (
        <div ref={panelRef} role="dialog" aria-label={t("chat.changeReasoningLabel")} style={{
          position: "absolute", bottom: "calc(100% + 6px)", ...(isMobile ? { left: 0 } : { right: 0 }),
          ...(placement ? { left: placement.left, right: "auto", bottom: placement.above ? "calc(100% + 6px)" : "auto", top: placement.above ? "auto" : "calc(100% + 6px)", maxHeight: placement.maxHeight } : {}),
          zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 -4px 16px rgba(0,0,0,0.10)", overflowX: "hidden", overflowY: "auto", width: "max-content",
          minWidth: "min(220px, calc(100vw - 16px))", maxWidth: "min(340px, calc(100vw - 16px))",
        }}>
          <div role="tablist" aria-label={t("chat.changeReasoningLabel")} style={{ display: "flex", gap: 4, padding: "6px 8px 0", borderBottom: "1px solid var(--border)" }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const enabled = tabs.filter((value) => !states[value].locked);
              const index = enabled.indexOf(tab);
              const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled[enabled.length - 1]
                : enabled[(index + (event.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
              if (next) {
                setMenu((current) => ({ ...current, tab: next }));
                rootRef.current?.querySelector<HTMLButtonElement>(`[data-thinking-tab='${next}']`)?.focus();
              }
            }}>
            {tabs.map((value) => {
              const active = tab === value;
              const state = states[value];
              return (
                <button key={value} id={`${id}-${value}-tab`} type="button" role="tab" data-thinking-tab={value}
                  aria-controls={`${id}-${value}-panel`}
                  aria-selected={active} aria-disabled={state.locked} disabled={state.locked} tabIndex={active ? 0 : -1}
                  title={state.reason ?? `${entries[value].model?.provider}/${entries[value].model?.modelId}`}
                  onClick={() => { if (!state.locked) setMenu((current) => ({ ...current, tab: value })); }}
                  style={{
                    flex: 1, padding: "7px 8px", border: "none", borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                    background: "none", color: state.locked ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)",
                    cursor: state.locked ? "not-allowed" : "pointer", opacity: state.locked ? 0.5 : 1,
                    fontSize: 12, fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
                  }}>
                  {t(value === "primary" ? "chat.primaryThinkingTab" : "chat.fallbackThinkingTab")}
                </button>
              );
            })}
          </div>
          <div id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`}>
            <div title={`${entry.model?.provider}/${entry.model?.modelId}`} style={{ padding: "7px 12px 4px", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {entry.model?.modelId}
            </div>
            <div role="listbox" aria-label={label} onKeyDown={(event) => {
              if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='option']"));
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                : index < 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
              options[next]?.focus();
            }}>
              {THINKING_LEVEL_OPTIONS.filter((value) => value === "auto" || entry.availableLevels?.includes(value)).map((value) => {
                const active = value === current.selected;
                const mapped = value !== "auto" ? entry.levelMap?.[value] : undefined;
                const text = mapped ?? value;
                const desc = t(value === "auto" && tab === "fallback" ? "chat.fallbackThinkingUseDefault" : DESC_KEYS[value]);
                return (
                  <button key={value} type="button" role="option" aria-selected={active} tabIndex={active ? 0 : -1}
                    onClick={() => {
                      if (current.locked || (value !== "auto" && !entry.availableLevels?.includes(value))) return;
                      setMenu((current) => ({ ...current, open: false }));
                      rootRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup='dialog']")?.focus({ preventScroll: true });
                      if (!active) entry.onChange?.(value);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px",
                      background: active ? "var(--bg-selected)" : "none", border: "none",
                      color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12,
                      textAlign: "left", fontWeight: active ? 600 : 400,
                    }}
                    onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = "none"; }}>
                    {active
                      ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                      : <span style={{ width: 10, flexShrink: 0 }} />}
                    <span style={{ flex: 1 }}>{text}{mapped != null && mapped !== value && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 5 }}>({value})</span>}</span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
