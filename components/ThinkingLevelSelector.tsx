"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { normalizeThinkingLevelOption, THINKING_LEVEL_OPTIONS, type ThinkingLevelOption } from "@/lib/thinking-level-options";

interface Props {
  variant: "primary" | "fallback";
  model?: { provider: string; modelId: string } | null;
  level?: ThinkingLevelOption;
  onChange?: (level: ThinkingLevelOption) => void;
  availableLevels?: readonly string[] | null;
  levelMap?: Record<string, string | null> | null;
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

export function ThinkingLevelSelector({ variant, model, level = "auto", onChange, availableLevels, levelMap, disabled = false, isMobile = false, showLabel = true }: Props) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const modelKey = model ? `${model.provider}:${model.modelId}` : "";
  const [menu, setMenu] = useState({ modelKey, open: false });
  const unsupported = availableLevels != null && !availableLevels.some((value) => value !== "off");
  const locked = disabled || !model || availableLevels == null || unsupported || !onChange;
  // Suppress the old panel synchronously, before the closing effect runs.
  const open = menu.open && menu.modelKey === modelKey && !locked;
  const selected = unsupported ? "off" : normalizeThinkingLevelOption(level, availableLevels);
  const display = selected === "auto" ? "auto" : levelMap?.[selected] ?? selected;
  const label = t(variant === "primary" ? "chat.primaryThinkingLevel" : "chat.fallbackThinkingLevel");
  const reason = !model
    ? t(variant === "fallback" ? "chat.fallbackSelectFirst" : "chat.thinkingSelectModelFirst")
    : availableLevels == null ? t("chat.thinkingLoading")
    : unsupported ? t("chat.thinkingUnsupported") : null;

  useEffect(() => {
    setMenu({ modelKey, open: false });
  }, [modelKey, locked]);
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu((current) => current.open ? { ...current, open: false } : current);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  if (!onChange) return null;
  return (
    <div ref={rootRef} data-thinking-selector={variant} style={{ position: "relative" }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); event.stopPropagation(); setMenu({ modelKey, open: false });
      }
    }}>
      <button type="button" disabled={locked} aria-disabled={locked} aria-label={label}
        aria-haspopup="listbox" aria-expanded={open}
        title={reason ?? `${label}: ${display}\n${model?.provider}/${model?.modelId}`}
        onClick={() => { if (!locked) setMenu({ modelKey, open: !open }); }}
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
        {showLabel && <span>{t(variant === "primary" ? "chat.primaryThinkingShort" : "chat.fallbackThinkingShort")}: {display}</span>}
      </button>
      {open && (
        <div role="listbox" aria-label={label} style={{
          position: "absolute", bottom: "calc(100% + 6px)", ...(isMobile ? { left: 0 } : { right: 0 }),
          zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 -4px 16px rgba(0,0,0,0.10)", overflow: "hidden", minWidth: 180,
        }}>
          {THINKING_LEVEL_OPTIONS.filter((value) => value === "auto" || availableLevels?.includes(value)).map((value) => {
            const active = value === selected;
            const mapped = value !== "auto" ? levelMap?.[value] : undefined;
            const text = mapped ?? value;
            const desc = t(value === "auto" && variant === "fallback" ? "chat.fallbackThinkingUseDefault" : DESC_KEYS[value]);
            return (
              <button key={value} type="button" role="option" aria-selected={active}
                onClick={() => {
                  if (locked || (value !== "auto" && !availableLevels?.includes(value))) return;
                  setMenu({ modelKey, open: false });
                  if (!active) onChange(value);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px",
                  background: active ? "var(--bg-selected)" : "none", border: "none",
                  color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12,
                  textAlign: "left", fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
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
      )}
    </div>
  );
}
