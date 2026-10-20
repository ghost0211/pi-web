"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import {
  type NormalizedAnswers,
  type Question,
  type SingleQuestionAnswer,
  validateQuestionnaireAnswers,
} from "@/lib/ask-user-question";
import { questionnaireText } from "@/lib/questionnaire-messages";
import { MarkdownBody } from "./MarkdownBody";

export interface QuestionnairePanelRequest {
  id: string;
  title?: string;
  questions: Question[];
  toolCallId?: string;
  closed?: boolean;
}

export type QuestionnairePanelResponse =
  | { answers: NormalizedAnswers }
  | { cancelled: true };

interface Props {
  request: QuestionnairePanelRequest;
  /**
   * Send the answers. Rejecting keeps the panel open with an error so a
   * network failure never silently discards what the user chose.
   */
  onRespond: (request: QuestionnairePanelRequest, response: QuestionnairePanelResponse) => Promise<void>;
}

type Draft = {
  /** Selected option index (single select). */
  optionIndex: number | null;
  /** Selected option indexes (multi select). */
  optionIndexes: number[];
  /** Custom text; exclusive with the option selections. */
  custom: string;
  /** Whether the custom row is the active choice. */
  customActive: boolean;
};

const EMPTY_DRAFT: Draft = { optionIndex: null, optionIndexes: [], custom: "", customActive: false };

function toAnswer(draft: Draft): SingleQuestionAnswer | null {
  if (draft.customActive) {
    const text = draft.custom.trim();
    return text ? { kind: "custom", text } : null;
  }
  if (draft.optionIndex !== null) return { kind: "option", optionIndex: draft.optionIndex };
  if (draft.optionIndexes.length > 0) {
    return { kind: "multi", optionIndexes: [...draft.optionIndexes].sort((a, b) => a - b) };
  }
  return null;
}

export function AskUserQuestionPanel({ request, onRespond }: Props) {
  const { locale } = useI18n();
  const t = useCallback(
    (key: Parameters<typeof questionnaireText>[1], params?: Record<string, string | number>) =>
      questionnaireText(locale, key, params),
    [locale],
  );
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>(() => request.questions.map(() => ({ ...EMPTY_DRAFT })));
  const [errors, setErrors] = useState<(string | null)[]>(() => request.questions.map(() => null));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openPreviews, setOpenPreviews] = useState<boolean[]>(() => request.questions.map(() => false));
  const panelRef = useRef<HTMLDivElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => setPortalTarget(document.body), []);

  // A different request is a different questionnaire: drop every answer so an
  // answer can never be sent for the wrong tool call.
  useEffect(() => {
    setDrafts(request.questions.map(() => ({ ...EMPTY_DRAFT })));
    setErrors(request.questions.map(() => null));
    setOpenPreviews(request.questions.map(() => false));
    setSubmitError(null);
    submittedRef.current = false;
  }, [request.id, request.questions]);

  useEffect(() => {
    if (!request.closed) return;
    submittedRef.current = true;
  }, [request.closed]);

  const canSubmit = useMemo(
    () => request.questions.every((_, index) => toAnswer(drafts[index] ?? EMPTY_DRAFT) !== null),
    [drafts, request.questions],
  );

  const submit = useCallback(async () => {
    if (submittedRef.current || submitting) return;
    const answers: NormalizedAnswers = [];
    const nextErrors: (string | null)[] = [];
    for (const [index, question] of request.questions.entries()) {
      const answer = toAnswer(drafts[index] ?? EMPTY_DRAFT);
      if (!answer) {
        nextErrors[index] = question.multiSelect ? t("requiredMulti") : t("required");
        continue;
      }
      nextErrors[index] = null;
      answers.push(answer);
    }
    setErrors(nextErrors);
    if (nextErrors.some(Boolean)) return;
    // Reuse the same validator the server trusts instead of a second, looser one.
    const validated = validateQuestionnaireAnswers(request.questions, answers);
    if (!validated) {
      setSubmitError(t("submitFailed"));
      return;
    }
    submittedRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onRespond(request, { answers: validated });
    } catch {
      submittedRef.current = false;
      setSubmitError(t("submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [drafts, onRespond, request, submitting, t]);

  const cancel = useCallback(() => {
    if (submittedRef.current || submitting) return;
    submittedRef.current = true;
    void onRespond(request, { cancelled: true }).catch(() => {
      submittedRef.current = false;
    });
  }, [onRespond, request, submitting]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.stopPropagation();
        cancel();
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, submit, submitting]);

  // Keep focus inside the modal and return it to whatever had it before.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panelRef.current?.querySelector<HTMLElement>("input, button");
    first?.focus();
    return () => previous?.focus?.();
  }, [request.id]);

  if (!portalTarget || request.closed) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={request.title || t("panelTitle")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
        padding: 8,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) cancel();
      }}
    >
      <div
        ref={panelRef}
        className="questionnaire-panel"
        style={{
          display: "flex",
          flexDirection: "column",
          width: 640,
          maxWidth: "100%",
          maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
          overflow: "hidden",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        <header style={{ flexShrink: 0, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>
            {request.title || t("panelTitle")}
          </div>
          {request.questions.length > 1 && (
            <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11 }}>
              {t("questionCounter", { current: 1, total: request.questions.length })}
            </div>
          )}
        </header>

        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "12px 16px" }}>
          {request.questions.map((question, questionIndex) => {
            const draft = drafts[questionIndex] ?? EMPTY_DRAFT;
            const preview = question.options.find((option, optionIndex) => (
              option.preview && (
                question.multiSelect
                  ? draft.optionIndexes.includes(optionIndex)
                  : draft.optionIndex === optionIndex
              )
            ));
            return (
              <section
                key={`${question.header}-${questionIndex}`}
                aria-label={question.header || question.question}
                style={{ marginBottom: questionIndex === request.questions.length - 1 ? 0 : 18 }}
              >
                <div style={{ fontSize: 11, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--text-dim)" }}>
                  {question.header}
                </div>
                <div style={{ margin: "4px 0 8px", color: "var(--text)", fontSize: 14, fontWeight: 600, whiteSpace: "pre-wrap" }}>
                  {question.question}
                </div>
                <div role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question} style={{ display: "grid", gap: 6 }}>
                  {question.options.map((option, optionIndex) => {
                    const selected = draft.customActive
                      ? false
                      : question.multiSelect
                        ? draft.optionIndexes.includes(optionIndex)
                        : draft.optionIndex === optionIndex;
                    return (
                      <label
                        key={option.label}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          padding: "8px 10px",
                          border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                          borderRadius: 8,
                          background: selected ? "var(--user-bg)" : "transparent",
                          cursor: submitting ? "default" : "pointer",
                        }}
                      >
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={`question-${questionIndex}`}
                          checked={selected}
                          disabled={submitting}
                          onChange={() => {
                            setSubmitError(null);
                            setDrafts((current) => current.map((entry, index) => {
                              if (index !== questionIndex) return entry;
                              if (question.multiSelect) {
                                return {
                                  ...entry,
                                  customActive: false,
                                  optionIndexes: entry.optionIndexes.includes(optionIndex)
                                    ? entry.optionIndexes.filter((value) => value !== optionIndex)
                                    : [...entry.optionIndexes, optionIndex],
                                };
                              }
                              return { ...entry, customActive: false, optionIndex: optionIndex };
                            }));
                          }}
                          style={{ marginTop: 3, flexShrink: 0 }}
                        />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", color: "var(--text)", fontSize: 13, fontWeight: 500 }}>
                            {option.label}
                            {option.recommended && (
                              <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px" }}>
                                {t("recommended")}
                              </span>
                            )}
                          </span>
                          {option.description && (
                            <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap" }}>
                              {option.description}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 10px",
                      border: `1px solid ${draft.customActive ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 8,
                      background: draft.customActive ? "var(--user-bg)" : "transparent",
                      cursor: submitting ? "default" : "pointer",
                    }}
                  >
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={`question-${questionIndex}`}
                      checked={draft.customActive}
                      disabled={submitting}
                      onChange={() => {
                        setSubmitError(null);
                        // Typing your own answer excludes the options; matching the
                        // upstream extension's reply format, both cannot reach it.
                        setDrafts((current) => current.map((entry, index) => (
                          index === questionIndex
                            ? { ...entry, customActive: true, optionIndex: null, optionIndexes: [] }
                            : entry
                        )));
                      }}
                      style={{ marginTop: 3, flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", color: "var(--text)", fontSize: 13, fontWeight: 500 }}>
                        {t("customOption")}
                      </span>
                      <input
                        type="text"
                        value={draft.custom}
                        disabled={submitting || !draft.customActive}
                        placeholder={t("customPlaceholder")}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSubmitError(null);
                          setDrafts((current) => current.map((entry, index) => (
                            index === questionIndex ? { ...entry, custom: value } : entry
                          )));
                        }}
                        style={{
                          marginTop: 4,
                          width: "100%",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "var(--bg-panel)",
                          color: "var(--text)",
                          fontFamily: "inherit",
                          fontSize: 12,
                        }}
                      />
                    </span>
                  </label>
                </div>
                {preview?.preview && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => setOpenPreviews((current) => current.map((value, index) => index === questionIndex ? !value : value))}
                      style={{ padding: 0, border: 0, background: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer" }}
                    >
                      {openPreviews[questionIndex] ? t("previewHide") : t("previewToggle")}
                    </button>
                    {openPreviews[questionIndex] && (
                      <div
                        style={{
                          marginTop: 6,
                          maxHeight: 240,
                          overflow: "auto",
                          padding: "8px 10px",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          background: "var(--bg-panel)",
                        }}
                      >
                        <MarkdownBody className="markdown-questionnaire-preview">{preview.preview}</MarkdownBody>
                      </div>
                    )}
                  </div>
                )}
                {errors[questionIndex] && (
                  <div role="alert" style={{ marginTop: 6, color: "#dc2626", fontSize: 11 }}>
                    {errors[questionIndex]}
                  </div>
                )}
              </section>
            );
          })}
          {submitError && (
            <div role="alert" style={{ marginTop: 10, color: "#dc2626", fontSize: 12 }}>
              {submitError}
            </div>
          )}
        </div>

        <footer
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            type="button"
            onClick={cancel}
            disabled={submitting}
            style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", fontSize: 13, cursor: submitting ? "default" : "pointer" }}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !canSubmit}
            title={canSubmit ? undefined : t("required")}
            style={{
              padding: "6px 16px",
              border: 0,
              borderRadius: 6,
              background: "var(--accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: submitting || !canSubmit ? "default" : "pointer",
              opacity: submitting || !canSubmit ? 0.6 : 1,
            }}
          >
            {submitting ? t("submitting") : t("submit")}
          </button>
        </footer>
      </div>
    </div>,
    portalTarget,
  );
}
