import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { questionnaireText } = await jiti.import("./questionnaire-messages.ts");

test("questionnaire strings exist in every supported locale", () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    for (const key of [
      "panelTitle", "submit", "submitting", "cancel", "required", "requiredMulti",
      "customOption", "customPlaceholder", "recommended", "previewToggle", "previewHide",
      "questionCounter", "submitFailed",
    ]) {
      const value = questionnaireText(locale, key);
      assert.ok(value && value !== key, `${locale}.${key} must have a translation`);
    }
  }
});

test("missing locales and keys fall back instead of rendering a raw key", () => {
  assert.equal(questionnaireText("fr", "submit"), "Send answers");
  // Unknown key falls back to the key itself only as a last resort.
  assert.equal(questionnaireText("en", "nope"), "nope");
});

test("fills placeholders and leaves unknown ones intact", () => {
  assert.match(questionnaireText("zh-CN", "questionCounter", { current: 2, total: 3 }), /2 \/ 3/);
});
