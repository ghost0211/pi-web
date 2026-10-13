"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import {
  type AutoAdvanceConfig,
  type AutoAdvanceState,
  isAutoAdvanceActive,
} from "@/lib/auto-advance-types";
import type { ModelSelectorOption } from "./ModelSelector";
import { isThinkingLevelOption, normalizeThinkingLevelOption, THINKING_LEVEL_OPTIONS, type ThinkingLevelOption } from "@/lib/thinking-level-options";

const THINKING_DESCRIPTIONS: Record<ThinkingLevelOption, string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal",
  low: "chat.thinkingLow", medium: "chat.thinkingMedium", high: "chat.thinkingHigh",
  xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

export interface AutoAdvanceControlProps {
  state?: AutoAdvanceState | null;
  models: ModelSelectorOption[];
  /** Surrogate capabilities keyed by provider:modelId, never the main/backup preference. */
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  disabled?: boolean;
  busy?: boolean;
  onStart: (config: AutoAdvanceConfig) => Promise<void>;
  onStop: () => Promise<void>;
  className?: string;
  style?: CSSProperties;
}

function getModelId(option: ModelSelectorOption): string { return option.modelId; }

export function AutoAdvanceControl({
  state = null,
  models = [],
  thinkingLevels,
  thinkingLevelMaps,
  disabled = false,
  busy = false,
  onStart,
  onStop,
  className,
  style,
}: AutoAdvanceControlProps) {
  const { t } = useI18n();

  const [isOpen, setIsOpen] = useState(false);
  const [goal, setGoal] = useState(state?.config?.goal ?? "");
  const [scope, setScope] = useState(state?.config?.scope ?? "");
  const [selectedModel, setSelectedModel] = useState<{ provider: string; modelId: string } | null>(
    state?.config?.model ?? null,
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>(state?.config?.thinkingLevel ?? "auto");
  const [maxRounds, setMaxRounds] = useState(String(state?.config?.maxRounds ?? 3));
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  const startPendingRef = useRef(false);
  const stopPendingRef = useRef(false);
  const startAttemptRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const titleId = useId();
  const descId = useId();
  const goalId = useId();
  const scopeId = useId();
  const modelId = useId();
  const thinkingId = useId();
  const thinkingHelpId = useId();
  const scopeHelpId = useId();
  const roundsId = useId();

  const isActive = isAutoAdvanceActive(state);
  const formDisabled = isActive || isStarting || busy || disabled;
  const selectedKey = selectedModel ? `${selectedModel.provider}:${selectedModel.modelId}` : "";
  const supportedThinking = thinkingLevels?.[selectedKey];
  const unsupportedThinking = supportedThinking != null && !supportedThinking.some(level => level !== "off");
  const effectiveThinking = supportedThinking == null ? "auto" : unsupportedThinking ? "off" : normalizeThinkingLevelOption(thinkingLevel, supportedThinking);
  const thinkingOptions = supportedThinking == null ? ["auto" as const] : unsupportedThinking ? ["off" as const]
    : THINKING_LEVEL_OPTIONS.filter(level => level === "auto" || supportedThinking.includes(level));
  const thinkingLabel = (level: ThinkingLevelOption, key: string) => {
    const mapped = level !== "auto" ? thinkingLevelMaps?.[key]?.[level] : undefined;
    const value = mapped != null && mapped !== level ? `${level} → ${mapped}` : level;
    return `${value} · ${t(THINKING_DESCRIPTIONS[level])}`;
  };

  // Metadata can arrive after the dialog opens. Preserve compatible choices,
  // but never submit an explicit level that the newly selected model rejects.
  useEffect(() => {
    if (isActive || supportedThinking == null) return;
    setThinkingLevel(current => unsupportedThinking ? "off" : normalizeThinkingLevelOption(current, supportedThinking));
  }, [isActive, supportedThinking, unsupportedThinking]);

  // Status revisions must not overwrite an editable draft from the same activation.
  useEffect(() => {
    const config = stateRef.current?.config;
    if (config) {
      setGoal(config.goal);
      setScope(config.scope);
      setSelectedModel(config.model);
      setThinkingLevel(config.thinkingLevel ?? "auto");
      setMaxRounds(String(config.maxRounds));
    }
  }, [state?.id]);

  // Default to first available model if none selected
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      const first = models[0];
      const mId = getModelId(first);
      if (first.provider && mId) {
        setSelectedModel({ provider: first.provider, modelId: mId });
      }
    }
  }, [models, selectedModel]);

  const trimmedRounds = maxRounds.trim();
  const parsedRounds = Number(trimmedRounds);
  const isRoundsValid =
    trimmedRounds !== "" &&
    Number.isInteger(parsedRounds) &&
    parsedRounds >= 1 &&
    parsedRounds <= 99;

  const isFormValid = Boolean(
    goal.trim().length > 0 &&
      scope.trim().length > 0 &&
      models.some(m => m.provider === selectedModel?.provider && m.modelId === selectedModel?.modelId) &&
      isRoundsValid,
  );

  const handleClose = useCallback(() => {
    if (isStopping) return;
    setIsOpen(false);
    setError(null);
  }, [isStopping]);

  // Focus restore and autofocus
  useEffect(() => {
    if (!isOpen) return;

    const trigger = triggerRef.current;
    const timer = setTimeout(() => {
      if (panelRef.current) {
        // querySelector honours document order, not selector order, so resolve
        // the primary field separately: the header close button precedes it.
        const focusable = panelRef.current.querySelector<HTMLElement>("[data-auto-advance-autofocus]")
          ?? panelRef.current.querySelector<HTMLElement>(
            "textarea:not([disabled]), input:not([disabled]), select:not([disabled]), button:not([disabled])",
          );
        focusable?.focus({ preventScroll: true });
      }
    }, 0);

    return () => {
      clearTimeout(timer);
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  // Global window Escape key listener
  useEffect(() => {
    if (!isOpen) return;
    const onWindowKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !isStopping) {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [isOpen, isStopping, handleClose]);

  // Focus trap inside dialog panel
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !isStopping) {
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === "Tab") {
      const container = panelRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !container.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !container.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  };

  const handleStart = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (startPendingRef.current || disabled || busy || isActive) return;
    if (!isFormValid || !selectedModel) {
      setError(t("autoAdvance.missing"));
      return;
    }
    startPendingRef.current = true;
    const attempt = ++startAttemptRef.current;
    setIsStarting(true);
    setError(null);
    try {
      await onStart({
        goal: goal.trim(),
        scope: scope.trim(),
        model: { provider: selectedModel.provider, modelId: selectedModel.modelId },
        thinkingLevel: effectiveThinking,
        maxRounds: Number(maxRounds),
      });
      if (attempt === startAttemptRef.current) setIsOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === startAttemptRef.current) setError(msg || t("autoAdvance.error"));
    } finally {
      startPendingRef.current = false;
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    if (stopPendingRef.current) return;
    stopPendingRef.current = true;
    startAttemptRef.current++;
    setIsStopping(true);
    setError(null);
    try {
      await onStop();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || t("autoAdvance.error"));
    } finally {
      stopPendingRef.current = false;
      setIsStopping(false);
    }
  };

  const handleRestart = () => {
    setError(null);
    if (state?.config) {
      setGoal(state.config.goal);
      setScope(state.config.scope);
      setSelectedModel(state.config.model);
      setThinkingLevel(state.config.thinkingLevel ?? "auto");
      setMaxRounds(String(state.config.maxRounds));
    }
  };

  const triggerLabel = isActive
    ? t("autoAdvance.active", { round: state?.round ?? 0 })
    : t("autoAdvance.title");

  // When active, trigger remains enabled so the user can open dialog and click Stop even if disabled prop is true
  const triggerDisabled = !isActive && !isStarting && !busy && disabled;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={triggerDisabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        title={triggerLabel}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 8px",
          borderRadius: 5,
          fontSize: 11,
          maxWidth: "100%", minWidth: 0, overflowWrap: "anywhere",
          border: `1px solid ${isActive ? "color-mix(in srgb, var(--accent) 50%, transparent)" : "var(--border)"}`,
          background: isActive ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "none",
          color: isActive ? "var(--accent)" : "var(--text-muted)",
          cursor: triggerDisabled ? "not-allowed" : "pointer",
          opacity: triggerDisabled ? 0.6 : 1,
          transition: "background-color 0.15s, border-color 0.15s, color 0.15s",
          ...style,
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        <span>{triggerLabel}</span>
      </button>

      {isOpen && typeof document !== "undefined" && createPortal(
        <div
          className="auto-advance-backdrop"
          data-composer-controls-portal="auto-advance"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isStopping) {
              handleClose();
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.45)",
            backdropFilter: "blur(2px)",
            padding: 16,
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="auto-advance-panel"
            onKeyDown={handleKeyDown}
            style={{
              width: "100%",
              maxWidth: 540,
              maxHeight: "min(90dvh, 720px)",
              minWidth: 0, overflowWrap: "anywhere", boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 12px 36px rgba(0, 0, 0, 0.3)",
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                gap: 8,
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0, overflowWrap: "anywhere" }}>
                <h2
                  id={titleId}
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--text)",
                  }}
                >
                  {t("autoAdvance.title")}
                </h2>
                {isActive && state && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 10,
                      background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                      color: "var(--accent)",
                      fontWeight: 500,
                    }}
                  >
                    {t("autoAdvance.phase." + state.phase)} · {t("autoAdvance.active", { round: state.round })}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleClose}
                disabled={isStopping}
                aria-label={t("autoAdvance.close")}
                title={t("autoAdvance.close")}
                style={{
                  border: 0,
                  background: "none",
                  color: "var(--text-muted)",
                  fontSize: 18,
                  cursor: isStopping ? "not-allowed" : "pointer",
                  padding: "2px 6px",
                  lineHeight: 1,
                  borderRadius: 4,
                }}
              >
                ✕
              </button>
            </div>

            {/* Scrollable Body */}
            <div
              id={descId}
              style={{
                padding: "16px 18px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                fontSize: 13,
              }}
            >
              {/* Surrogate warning banner */}
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 6,
                  background: "var(--bg-panel, rgba(0,0,0,0.04))",
                  border: "1px solid var(--border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 12,
                    color: "var(--accent)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>{t("autoAdvance.surrogateMessage")}</span>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                  {t("autoAdvance.warning")}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4, opacity: 0.85 }}>
                  {t("autoAdvance.runHint")}
                </div>
              </div>

              {/* Status card for active or terminal state */}
              {state && (
                <div
                  style={{
                    padding: "12px",
                    borderRadius: 6,
                    border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                    background: isActive
                      ? "color-mix(in srgb, var(--accent) 5%, transparent)"
                      : "var(--bg-panel, rgba(0,0,0,0.02))",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <span style={{ fontWeight: 600 }}>
                      {t("autoAdvance.phase." + state.phase)}
                    </span>
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {t("autoAdvance.limits", {
                        rounds: state.config?.maxRounds ?? maxRounds,
                      })}
                    </span>
                  </div>

                  <div data-auto-advance-surrogate="" style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                    {t("autoAdvance.model")}: {state.config.model.provider}/{state.config.model.modelId}
                    <br />
                    {t("autoAdvance.thinkingLevel")}: {thinkingLabel(state.config.thinkingLevel ?? "auto", `${state.config.model.provider}:${state.config.model.modelId}`)}
                  </div>

                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {t("autoAdvance.tokens", {
                      used: state.tokensUsed ?? 0,
                    })}
                    {state.usageIncomplete && (
                      <span style={{ marginLeft: 6 }}>
                        · {t("autoAdvance.usageIncomplete")}
                      </span>
                    )}
                  </div>

                  {state.reason && (
                    <div style={{ fontSize: 12, color: "var(--text)" }}>
                      <strong>{t(`autoAdvance.reason.${state.reason}`)}</strong>
                    </div>
                  )}

                  {state.detail && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        whiteSpace: "pre-wrap",
                        maxHeight: 120,
                        overflowY: "auto",
                      }}
                    >
                      {state.detail}
                    </div>
                  )}

                  {/* Stop button: Remains enabled even if disabled prop is true */}
                  {isActive && (
                    <div style={{ marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={handleStop}
                        disabled={isStopping}
                        style={{
                          padding: "6px 14px",
                          background: "var(--danger, #ef4444)",
                          color: "#ffffff",
                          border: 0,
                          borderRadius: 6,
                          fontWeight: 600,
                          fontSize: 12,
                          cursor: isStopping ? "not-allowed" : "pointer",
                          opacity: isStopping ? 0.7 : 1,
                        }}
                      >
                        {t("autoAdvance.stop")}
                      </button>
                    </div>
                  )}

                  {!isActive && (
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={handleRestart}
                        style={{
                          padding: "4px 10px",
                          background: "none",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          fontSize: 11,
                          color: "var(--text)",
                          cursor: "pointer",
                        }}
                      >
                        {t("autoAdvance.restart")}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Goal input */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <label htmlFor={goalId} style={{ fontWeight: 500, fontSize: 12 }}>
                    {t("autoAdvance.goal")}
                  </label>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{goal.length}/4000</span>
                </div>
                <textarea
                  id={goalId}
                  data-auto-advance-autofocus=""
                  maxLength={4000}
                  value={goal}
                  disabled={formDisabled}
                  onChange={(e) => setGoal(e.target.value.slice(0, 4000))}
                  placeholder={t("autoAdvance.goal")}
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel, transparent)",
                    color: "var(--text)",
                    fontSize: 13,
                    resize: "vertical",
                  }}
                />
              </div>

              {/* Scope input */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <label htmlFor={scopeId} style={{ fontWeight: 500, fontSize: 12 }}>
                    {t("autoAdvance.scope")}
                  </label>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{scope.length}/2000</span>
                </div>
                <textarea
                  id={scopeId}
                  maxLength={2000}
                  value={scope}
                  required
                  aria-describedby={scopeHelpId}
                  disabled={formDisabled}
                  onChange={(e) => setScope(e.target.value.slice(0, 2000))}
                  placeholder={t("autoAdvance.scopePlaceholder")}
                  rows={2}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel, transparent)",
                    color: "var(--text)",
                    fontSize: 13,
                    resize: "vertical",
                  }}
                />
              </div>

              <div id={scopeHelpId} style={{ marginTop: -8, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
                {t("autoAdvance.scopeHelp")}
              </div>

              {/* Model select */}
              <div>
                <label htmlFor={modelId} style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 12 }}>
                  {t("autoAdvance.model")}
                </label>
                <select
                  id={modelId}
                  data-auto-advance-field="model"
                  disabled={formDisabled}
                  value={
                    selectedModel
                      ? JSON.stringify({ provider: selectedModel.provider, modelId: selectedModel.modelId })
                      : ""
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) {
                      setSelectedModel(null);
                      return;
                    }
                    try {
                      const parsed = JSON.parse(val) as { provider?: unknown; modelId?: unknown };
                      const match = models.find(m => m.provider === parsed.provider && m.modelId === parsed.modelId);
                      setSelectedModel(match ? { provider: match.provider, modelId: match.modelId } : null);
                      const supported = match ? thinkingLevels?.[`${match.provider}:${match.modelId}`] : undefined;
                      setThinkingLevel(current => supported == null ? "auto"
                        : !supported.some(level => level !== "off") ? "off" : normalizeThinkingLevelOption(current, supported));
                    } catch { setSelectedModel(null); }
                  }}
                  style={{
                    width: "100%",
                    height: 36,
                    padding: "0 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel, transparent)",
                    color: "var(--text)",
                    fontSize: 13,
                  }}
                >
                  {models.length === 0 ? (
                    <option value="" disabled>
                      {t("autoAdvance.missing")}
                    </option>
                  ) : (
                    models.map((option, idx) => {
                      const mId = getModelId(option);
                      const val = JSON.stringify({ provider: option.provider, modelId: mId });
                      return (
                        <option key={`${option.provider}:${mId}:${idx}`} value={val}>
                          {option.name || mId} ({option.provider})
                        </option>
                      );
                    })
                  )}
                </select>
              </div>

              <div>
                <label htmlFor={thinkingId} style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 12 }}>
                  {t("autoAdvance.thinkingLevel")}
                </label>
                <select id={thinkingId} data-auto-advance-field="thinking" aria-describedby={thinkingHelpId}
                  value={effectiveThinking} disabled={formDisabled || supportedThinking == null || unsupportedThinking}
                  onChange={event => {
                    const value = event.target.value;
                    if (!formDisabled && supportedThinking != null && !unsupportedThinking && isThinkingLevelOption(value)
                      && (value === "auto" || supportedThinking.includes(value))) setThinkingLevel(value);
                  }}
                  style={{ width: "100%", minWidth: 0, height: 36, padding: "0 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel, transparent)", color: "var(--text)", fontSize: 13 }}>
                  {thinkingOptions.map(level => <option key={level} value={level}>{thinkingLabel(level, selectedKey)}</option>)}
                </select>
                <div id={thinkingHelpId} style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
                  {t("autoAdvance.thinkingLevelHelp")}
                  {supportedThinking == null && <> {t("chat.thinkingLoading")}</>}
                  {unsupportedThinking && <> {t("chat.thinkingUnsupported")}</>}
                </div>
              </div>

              {/* Additional rounds */}
              <div>
                <label htmlFor={roundsId} style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 12 }}>
                  {t("autoAdvance.maxRounds")}
                </label>
                <input
                  id={roundsId}
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={maxRounds}
                  disabled={formDisabled}
                  onChange={(e) => {
                    setMaxRounds(e.target.value);
                  }}
                  style={{
                    width: "100%",
                    height: 34,
                    padding: "0 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel, transparent)",
                    color: "var(--text)",
                    fontSize: 13,
                  }}
                />
              </div>

              {/* Missing validation message */}
              {!isFormValid && (
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {t("autoAdvance.missing")}
                </div>
              )}

              {/* Inline error notice */}
              {error && (
                <div
                  role="alert"
                  style={{
                    padding: "8px 12px",
                    borderRadius: 6,
                    background: "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)",
                    color: "var(--danger, #ef4444)",
                    fontSize: 12,
                    border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 30%, transparent)",
                  }}
                >
                  {error}
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 10, flexWrap: "wrap",
                padding: "12px 18px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={handleClose}
                disabled={isStopping || isStarting}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text)",
                  fontSize: 13,
                  cursor: isStopping || isStarting ? "not-allowed" : "pointer",
                }}
              >
                {isActive ? t("autoAdvance.close") : t("autoAdvance.cancel")}
              </button>

              {!isActive && (isStarting || busy) && (
                <button type="button" onClick={handleStop} disabled={isStopping} style={{ color: "#ef4444", padding: "6px 10px" }}>{t("autoAdvance.stop")}</button>
              )}
              {!isActive && (
                <button
                  type="button"
                  onClick={() => handleStart()}
                  disabled={!isFormValid || disabled || isStarting || busy}
                  style={{
                    padding: "6px 16px",
                    borderRadius: 6,
                    border: 0,
                    background: "var(--accent)",
                    color: "#ffffff",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: !isFormValid || disabled || isStarting || busy ? "not-allowed" : "pointer",
                    opacity: !isFormValid || disabled || isStarting || busy ? 0.5 : 1,
                  }}
                >
                  {t("autoAdvance.start")}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
