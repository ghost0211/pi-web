/**
 * Local strings for the questionnaire panel.
 *
 * Kept out of the shared i18n table on purpose: the panel is self-contained,
 * new, and its wording is still settling. Falling back to English keeps a
 * missing key from rendering a raw key string.
 */
import type { Locale } from "./i18n/types";

type Entry = Record<string, string>;

const EN: Entry = {
  panelTitle: "Confirm before continuing",
  submit: "Send answers",
  submitting: "Sending…",
  cancel: "Cancel",
  dismissed: "Dismissed",
  required: "Pick one option",
  requiredMulti: "Pick at least one option",
  customOption: "Something else",
  customPlaceholder: "Type your answer…",
  recommended: "Recommended",
  optionPreview: "Preview",
  previewToggle: "Show preview",
  previewHide: "Hide preview",
  questionCounter: "Question {current} of {total}",
  submitFailed: "Could not send the answers. Try again.",
};

const ZH_CN: Entry = {
  panelTitle: "继续前请确认",
  submit: "提交回答",
  submitting: "提交中…",
  cancel: "取消",
  dismissed: "已取消",
  required: "请选择一个选项",
  requiredMulti: "请至少选择一个选项",
  customOption: "其他（自行填写）",
  customPlaceholder: "输入你的回答…",
  recommended: "推荐",
  optionPreview: "预览",
  previewToggle: "查看预览",
  previewHide: "收起预览",
  questionCounter: "第 {current} / {total} 题",
  submitFailed: "回答发送失败，请重试。",
};

const ZH_TW: Entry = {
  panelTitle: "繼續前請確認",
  submit: "送出回答",
  submitting: "送出中…",
  cancel: "取消",
  dismissed: "已取消",
  required: "請選擇一個選項",
  requiredMulti: "請至少選擇一個選項",
  customOption: "其他（自行填寫）",
  customPlaceholder: "輸入你的回答…",
  recommended: "推薦",
  optionPreview: "預覽",
  previewToggle: "查看預覽",
  previewHide: "收起預覽",
  questionCounter: "第 {current} / {total} 題",
  submitFailed: "回答傳送失敗，請重試。",
};

const TABLES: Record<string, Entry> = {
  en: EN,
  "zh-CN": ZH_CN,
  "zh-TW": ZH_TW,
};

export function questionnaireText(locale: Locale, key: keyof typeof EN, params?: Record<string, string | number>): string {
  const table = TABLES[locale] ?? EN;
  const template = table[key] ?? EN[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    params[name] === undefined ? match : String(params[name])
  ));
}
