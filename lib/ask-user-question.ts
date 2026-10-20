/**
 * Safe data models, strict validators, and bridge definitions for user structured questionnaires.
 * Client-safe, zero side-effects, zero DOM dependency.
 */

export const QUESTIONNAIRE_LIMITS = {
  MIN_QUESTIONS: 1,
  MAX_QUESTIONS: 4,
  MIN_OPTIONS: 2,
  MAX_OPTIONS: 6,
  MAX_QUESTION_LENGTH: 2000,
  MAX_HEADER_LENGTH: 200,
  MAX_OPTION_LABEL_LENGTH: 200,
  MAX_OPTION_DESC_LENGTH: 1000,
  MAX_TOTAL_PREVIEW_BUDGET: 4000,
  MAX_CUSTOM_TEXT_LENGTH: 2000,
} as const;

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
  recommended?: boolean;
}

export interface Question {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionnaireRequest {
  id: string;
  title?: string;
  questions: Question[];
  toolCallId?: string;
  closed?: boolean;
}

/**
 * Discriminated union for a single question's answer.
 * Enforces mutual exclusivity between preset options (single/multi) and custom typed text.
 */
export type SingleQuestionAnswer =
  | { kind: "option"; optionIndex: number }
  | { kind: "multi"; optionIndexes: number[] }
  | { kind: "custom"; text: string };

export type QuestionnaireAnswers = SingleQuestionAnswer[];
export type NormalizedAnswers = QuestionnaireAnswers;

export interface ParsedQuestionnairePayload {
  title?: string;
  questions: Question[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a single question option with strict bounds.
 */
function validateOption(
  raw: unknown,
  existingLabelsLower: Set<string>,
): { option: QuestionOption; previewLen: number } | null {
  if (!isPlainObject(raw)) return null;

  if (typeof raw.label !== "string") return null;
  const label = raw.label.trim();
  if (!label || label.length > QUESTIONNAIRE_LIMITS.MAX_OPTION_LABEL_LENGTH) {
    return null;
  }

  // Strict deduplication across option labels within the same question
  const labelLower = label.toLowerCase();
  if (existingLabelsLower.has(labelLower)) {
    return null;
  }
  existingLabelsLower.add(labelLower);

  const option: QuestionOption = { label };

  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return null;
    const desc = raw.description.trim();
    if (desc.length > QUESTIONNAIRE_LIMITS.MAX_OPTION_DESC_LENGTH) return null;
    if (desc) option.description = desc;
  }

  let previewLen = 0;
  if (raw.preview !== undefined) {
    if (typeof raw.preview !== "string") return null;
    const preview = raw.preview.trim();
    if (preview.length > QUESTIONNAIRE_LIMITS.MAX_TOTAL_PREVIEW_BUDGET) return null;
    if (preview) {
      option.preview = preview;
      previewLen = preview.length;
    }
  }

  if (raw.recommended !== undefined) {
    if (typeof raw.recommended !== "boolean") return null;
    option.recommended = raw.recommended;
  }

  return { option, previewLen };
}

/**
 * Validates a single question with strict constraints:
 * - header non-empty <= 200
 * - question text non-empty <= 2000
 * - 2..6 options
 * - preview budget bounds
 */
function validateQuestion(
  raw: unknown,
  currentTotalPreviewLen: number,
): { question: Question; addedPreviewLen: number } | null {
  if (!isPlainObject(raw)) return null;

  if (typeof raw.header !== "string") return null;
  const header = raw.header.trim();
  if (!header || header.length > QUESTIONNAIRE_LIMITS.MAX_HEADER_LENGTH) {
    return null;
  }

  if (typeof raw.question !== "string") return null;
  const questionText = raw.question.trim();
  if (!questionText || questionText.length > QUESTIONNAIRE_LIMITS.MAX_QUESTION_LENGTH) {
    return null;
  }

  const multiSelect = typeof raw.multiSelect === "boolean" ? raw.multiSelect : false;

  if (!Array.isArray(raw.options)) return null;
  if (
    raw.options.length < QUESTIONNAIRE_LIMITS.MIN_OPTIONS ||
    raw.options.length > QUESTIONNAIRE_LIMITS.MAX_OPTIONS
  ) {
    return null;
  }

  const existingLabelsLower = new Set<string>();
  const options: QuestionOption[] = [];
  let addedPreviewLen = 0;

  for (const rawOpt of raw.options) {
    const validated = validateOption(rawOpt, existingLabelsLower);
    if (!validated) return null;
    addedPreviewLen += validated.previewLen;
    if (currentTotalPreviewLen + addedPreviewLen > QUESTIONNAIRE_LIMITS.MAX_TOTAL_PREVIEW_BUDGET) {
      return null;
    }
    options.push(validated.option);
  }

  return {
    question: {
      header,
      question: questionText,
      multiSelect,
      options,
    },
    addedPreviewLen,
  };
}

/**
 * Parses and strictly validates questionnaire tool call arguments or payload.
 * Accepts either `{ questions: [...], title?: string }` or `[...]`.
 * Returns normalized data or null if invalid.
 */
export function parseAskUserQuestionArgs(raw: unknown): ParsedQuestionnairePayload | null {
  let title: string | undefined;
  let rawQuestions: unknown;

  if (Array.isArray(raw)) {
    rawQuestions = raw;
  } else if (isPlainObject(raw)) {
    if (typeof raw.title === "string") {
      const trimmed = raw.title.trim();
      if (trimmed) title = trimmed.slice(0, 200);
    }
    rawQuestions = raw.questions;
  } else {
    return null;
  }

  if (!Array.isArray(rawQuestions)) return null;
  if (
    rawQuestions.length < QUESTIONNAIRE_LIMITS.MIN_QUESTIONS ||
    rawQuestions.length > QUESTIONNAIRE_LIMITS.MAX_QUESTIONS
  ) {
    return null;
  }

  let totalPreviewLen = 0;
  const questions: Question[] = [];

  for (const rawQ of rawQuestions) {
    const res = validateQuestion(rawQ, totalPreviewLen);
    if (!res) return null;
    totalPreviewLen += res.addedPreviewLen;
    questions.push(res.question);
  }

  return {
    ...(title ? { title } : {}),
    questions,
  };
}

/**
 * Validates submitted answers against questions strictly:
 * - Answers length matches questions length
 * - Validates discriminated union kind ('option' | 'multi' | 'custom')
 * - Validates bounds: 0 <= optionIndex < options.length
 * - Multi: non-empty array of valid indexes, sorted and deduplicated
 * - Custom: non-empty trimmed text within limit
 * - Preserves mutual exclusivity between options and custom text
 * Returns normalized answers or null on any invalid answer.
 */
export function validateQuestionnaireAnswers(
  questions: Question[],
  raw: unknown,
): NormalizedAnswers | null {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  if (!Array.isArray(raw) || raw.length !== questions.length) return null;

  const normalized: NormalizedAnswers = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const ans = raw[i];
    if (!isPlainObject(ans) || typeof ans.kind !== "string") {
      return null;
    }
    // A discriminated union must not carry another kind's fields: accepting
    // `{ kind: "multi", optionIndexes: [...], text: "..." }` would let a client
    // claim both an option list and a typed answer.
    const allowedKeys = ans.kind === "option"
      ? new Set(["kind", "optionIndex"])
      : ans.kind === "multi"
        ? new Set(["kind", "optionIndexes"])
        : ans.kind === "custom"
          ? new Set(["kind", "text"])
          : null;
    if (!allowedKeys) return null;
    if (Object.keys(ans).some((key) => !allowedKeys.has(key))) return null;

    if (ans.kind === "option") {
      if (
        typeof ans.optionIndex !== "number" ||
        !Number.isInteger(ans.optionIndex) ||
        ans.optionIndex < 0 ||
        ans.optionIndex >= q.options.length
      ) {
        return null;
      }
      normalized.push({
        kind: "option",
        optionIndex: ans.optionIndex,
      });
    } else if (ans.kind === "multi") {
      if (!Array.isArray(ans.optionIndexes) || ans.optionIndexes.length === 0) {
        return null;
      }
      const indexes = new Set<number>();
      for (const idx of ans.optionIndexes) {
        if (
          typeof idx !== "number" ||
          !Number.isInteger(idx) ||
          idx < 0 ||
          idx >= q.options.length
        ) {
          return null;
        }
        indexes.add(idx);
      }
      if (indexes.size === 0) return null;
      normalized.push({
        kind: "multi",
        optionIndexes: Array.from(indexes).sort((a, b) => a - b),
      });
    } else if (ans.kind === "custom") {
      if (typeof ans.text !== "string") return null;
      const trimmed = ans.text.trim();
      if (!trimmed || trimmed.length > QUESTIONNAIRE_LIMITS.MAX_CUSTOM_TEXT_LENGTH) {
        return null;
      }
      normalized.push({
        kind: "custom",
        text: trimmed,
      });
    } else {
      return null;
    }
  }

  return normalized;
}

/**
 * Formats validated questionnaire answers into clean plain text for host/agent context.
 * Does not contain raw HTML or formatting that could lead to unintended script injection.
 */
export function formatAnswersAsSnippet(
  questions: Question[],
  answers: NormalizedAnswers,
): string {
  const parts: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    const headerPrefix = q.header ? `[${q.header}] ` : "";
    const questionLine = `Q${i + 1}: ${headerPrefix}${q.question}`;

    let answerLine: string;
    if (!a) {
      answerLine = "A: (No answer)";
    } else if (a.kind === "option") {
      const opt = q.options[a.optionIndex];
      answerLine = `A: ${opt ? opt.label : `Option #${a.optionIndex}`}`;
    } else if (a.kind === "multi") {
      const labels = a.optionIndexes.map((idx) => {
        const opt = q.options[idx];
        return opt ? opt.label : `#${idx}`;
      });
      answerLine = `A: ${labels.join(", ")}`;
    } else if (a.kind === "custom") {
      answerLine = `A: ${a.text}`;
    } else {
      answerLine = "A: (Unknown)";
    }

    parts.push(`${questionLine}\n${answerLine}`);
  }

  return parts.join("\n\n");
}

/**
 * rpiv QuestionnaireBridge protocol wiring types and helpers.
 * Used by host rpc manager via requestExtensionUi(method: "questionnaire").
 */
export interface QuestionnaireUiRequest {
  method: "questionnaire";
  title?: string;
  questions: Question[];
  timeout?: number;
}

export type QuestionnaireUiResponse =
  | { answers: NormalizedAnswers; cancelled?: false }
  | { cancelled: true };

/**
 * Type guard for host rpc requestExtensionUi calls.
 */
export function isQuestionnaireUiRequest(value: unknown): value is QuestionnaireUiRequest {
  if (!isPlainObject(value) || value.method !== "questionnaire") return false;
  const parsed = parseAskUserQuestionArgs(value);
  return parsed !== null;
}

/**
 * Creates normalized response payload for the extension UI bridge.
 */
export function createQuestionnaireResponse(answers: NormalizedAnswers): QuestionnaireUiResponse {
  return { answers, cancelled: false };
}

/**
 * Creates cancelled response payload for the extension UI bridge.
 */
export function createQuestionnaireCancelledResponse(): QuestionnaireUiResponse {
  return { cancelled: true };
}
