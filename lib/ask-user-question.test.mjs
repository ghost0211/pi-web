import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  QUESTIONNAIRE_LIMITS,
  formatAnswersAsSnippet,
  parseAskUserQuestionArgs,
  validateQuestionnaireAnswers,
} = await jiti.import("./ask-user-question.ts");

const question = (overrides = {}) => ({
  header: "Target",
  question: "Which environment should this run against?",
  multiSelect: false,
  options: [
    { label: "Test", description: "Safe rehearsal", recommended: true },
    { label: "Production", description: "Live data" },
  ],
  ...overrides,
});

const payload = (questions) => ({ title: "Confirm", questions });

test("parses a valid questionnaire and keeps the recommended flag", () => {
  const parsed = parseAskUserQuestionArgs(payload([question()]));
  assert.ok(parsed);
  assert.equal(parsed.title, "Confirm");
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].options[0].recommended, true);
  assert.equal(parsed.questions[0].multiSelect, false);
});

test("rejects malformed questionnaires rather than showing a partial one", () => {
  // No questions, too many questions, one option, too many options.
  assert.equal(parseAskUserQuestionArgs({}), null);
  assert.equal(parseAskUserQuestionArgs({ questions: [] }), null);
  assert.equal(parseAskUserQuestionArgs(payload(Array.from({ length: QUESTIONNAIRE_LIMITS.MAX_QUESTIONS + 1 }, () => question()))), null);
  assert.equal(parseAskUserQuestionArgs(payload([question({ options: [{ label: "Only" }] })])), null);
  assert.equal(parseAskUserQuestionArgs(payload([question({
    options: Array.from({ length: QUESTIONNAIRE_LIMITS.MAX_OPTIONS + 1 }, (_, index) => ({ label: `o${index}` })),
  })])), null);
  // Missing header/question, wrong types.
  assert.equal(parseAskUserQuestionArgs(payload([question({ header: "" })])), null);
  assert.equal(parseAskUserQuestionArgs(payload([question({ question: 42 })])), null);
  assert.equal(parseAskUserQuestionArgs("nope"), null);
});

test("rejects duplicate option labels and over-long text", () => {
  assert.equal(parseAskUserQuestionArgs(payload([question({
    options: [{ label: "Same" }, { label: "same" }],
  })])), null);
  assert.equal(parseAskUserQuestionArgs(payload([question({ question: "x".repeat(QUESTIONNAIRE_LIMITS.MAX_QUESTION_LENGTH + 1) })])), null);
  assert.equal(parseAskUserQuestionArgs(payload([question({
    options: [{ label: "a", preview: "p".repeat(QUESTIONNAIRE_LIMITS.MAX_TOTAL_PREVIEW_BUDGET + 1) }, { label: "b" }],
  })])), null);
});

test("bounds the preview budget across every option", () => {
  const half = "p".repeat(QUESTIONNAIRE_LIMITS.MAX_TOTAL_PREVIEW_BUDGET / 2);
  // Two previews inside the limit are fine; three exceed the shared budget.
  const ok = parseAskUserQuestionArgs(payload([question({
    options: [{ label: "a", preview: half }, { label: "b", preview: half }],
  })]));
  assert.ok(ok);
  const tooMuch = parseAskUserQuestionArgs(payload([question({
    options: [{ label: "a", preview: half }, { label: "b", preview: half }, { label: "c", preview: "x" }],
  })]));
  assert.equal(tooMuch, null);
});

test("validates answers strictly and normalizes multi-select order", () => {
  const questions = parseAskUserQuestionArgs(payload([
    question(),
    question({ header: "Scope", multiSelect: true }),
    question({ header: "Note" }),
  ]))?.questions;
  assert.ok(questions);

  const valid = validateQuestionnaireAnswers(questions, [
    { kind: "option", optionIndex: 0 },
    { kind: "multi", optionIndexes: [1, 0, 1] },
    { kind: "custom", text: "  only stage 1  " },
  ]);
  assert.deepEqual(valid, [
    { kind: "option", optionIndex: 0 },
    { kind: "multi", optionIndexes: [0, 1] },
    { kind: "custom", text: "only stage 1" },
  ]);
});

test("rejects out-of-range, empty, duplicate-shaped and mismatched answers", () => {
  const questions = parseAskUserQuestionArgs(payload([question(), question({ header: "Scope", multiSelect: true })]))?.questions;
  assert.ok(questions);
  const cases = [
    [],                                                                    // too few
    [{ kind: "option", optionIndex: 0 }, { kind: "multi", optionIndexes: [0] }, { kind: "option", optionIndex: 0 }], // too many
    [{ kind: "option", optionIndex: 9 }, { kind: "multi", optionIndexes: [0] }],  // out of range
    [{ kind: "option", optionIndex: 1.5 }, { kind: "multi", optionIndexes: [0] }], // non-integer
    [{ kind: "option", optionIndex: 0 }, { kind: "multi", optionIndexes: [] }],   // empty multi
    [{ kind: "option", optionIndex: 0 }, { kind: "multi", optionIndexes: [7] }],  // multi out of range
    [{ kind: "option", optionIndex: 0 }, { kind: "custom", text: "   " }],        // blank custom
    [{ kind: "option", optionIndex: 0 }, { kind: "multi", optionIndexes: [0], text: "both" }], // ambiguous shape
    [{ kind: "unknown" }, { kind: "multi", optionIndexes: [0] }],
  ];
  for (const answers of cases) {
    assert.equal(validateQuestionnaireAnswers(questions, answers), null, JSON.stringify(answers));
  }
});

test("formats answers as plain text without the raw payload", () => {
  const questions = parseAskUserQuestionArgs(payload([question()]))?.questions;
  assert.ok(questions);
  const snippet = formatAnswersAsSnippet(questions, [{ kind: "option", optionIndex: 1 }]);
  assert.match(snippet, /Which environment/);
  assert.match(snippet, /Production/);
  assert.doesNotMatch(snippet, /optionIndex/);
});
