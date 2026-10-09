import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const providerIconSprite = readFileSync(new URL("../public/provider-icons.svg", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function symbolMarkup(id) {
  const start = providerIconSprite.indexOf(`<symbol id="${id}"`);
  assert.notEqual(start, -1, `missing ${id} symbol`);
  const end = providerIconSprite.indexOf("</symbol>", start);
  assert.notEqual(end, -1, `unterminated ${id} symbol`);
  return providerIconSprite.slice(start, end + "</symbol>".length);
}

function themeColor(selector, name) {
  const start = globalStyles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} theme block`);
  const end = globalStyles.indexOf("}", start);
  const block = globalStyles.slice(start, end);
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `missing --${name} in ${selector}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255);
  assert.equal(channels?.length, 3, `expected 6-digit hex color, got ${hex}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const { DefaultModelIcon, ProviderGlyph, ProviderIcon, resolveProviderIcon } = await createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
}).import("./ProviderIcon.tsx");

for (const id of ["azure", "azure-openai-responses"]) {
  test(`Azure provider icon supports ${id} without renaming historical credentials`, () => {
    const icon = ProviderIcon({ id, size: 18 });
    assert.equal(icon.type, "svg");
    assert.equal(icon.props.children.type, "use");
    assert.equal(icon.props.children.props.href, "/provider-icons.svg#azure");
  });
}

test("resolveProviderIcon matches exact, custom-prefixed and vendor-suffixed ids", () => {
  assert.equal(resolveProviderIcon("kimi-coding")?.symbol, "kimi");
  assert.equal(resolveProviderIcon("openai-codex")?.symbol, "openai");
  assert.equal(resolveProviderIcon("deepseek")?.symbol, "deepseek");
  // User-defined providers named after their vendor keep the vendor icon.
  assert.equal(resolveProviderIcon("custom-openai")?.symbol, "openai");
  assert.equal(resolveProviderIcon("my-team-deepseek")?.symbol, "deepseek");
  // Matching is case-insensitive and ignores surrounding whitespace.
  assert.equal(resolveProviderIcon("  Anthropic ")?.symbol, "anthropic");
});

test("resolveProviderIcon prefers the longest suffix and rejects unknown ids", () => {
  // `azure-openai-responses` must win over the shorter `openai` suffix.
  assert.equal(resolveProviderIcon("corp-azure-openai-responses")?.symbol, "azure");
  assert.equal(resolveProviderIcon("totally-unknown"), null);
  assert.equal(resolveProviderIcon(""), null);
  assert.equal(resolveProviderIcon(null), null);
  assert.equal(resolveProviderIcon(undefined), null);
  // Substrings without a separator boundary do not match.
  assert.equal(resolveProviderIcon("notopenai"), null);
});

test("theme-aware neutral marks retain brand accents and meet light/dark contrast", () => {
  const marks = [
    { id: "kimi-coding", symbol: "kimi", mark: '<path fill="currentColor" d="M11.065', accent: '#1783FF' },
    { id: "amazon-bedrock", symbol: "aws", mark: '<path fill="currentColor" d="M6.763', accent: '#F90' },
    { id: "cerebras", symbol: "cerebras", mark: '<path fill="currentColor" d="M15.407', accent: '#F15A29' },
  ];

  for (const { id, symbol, mark, accent } of marks) {
    const icon = ProviderIcon({ id, size: 18 });
    assert.equal(resolveProviderIcon(id)?.color, true, `${id} remains a full-color provider icon`);
    assert.equal(icon.props.children.props.href, `/provider-icons.svg#${symbol}`);
    assert.equal(icon.props.fill, undefined, `${id} keeps the sprite's brand colors`);
    assert.equal(icon.props.style.color, "var(--text-muted)");

    const markup = symbolMarkup(symbol);
    assert.ok(markup.includes(mark), `${symbol} neutral mark follows currentColor`);
    assert.ok(markup.includes(`fill="${accent}"`), `${symbol} brand accent remains unchanged`);
  }

  const monochrome = ProviderIcon({ id: "anthropic", size: 18 });
  assert.equal(monochrome.props.fill, "currentColor");
  assert.equal(monochrome.props.style.color, "var(--text-muted)");

  for (const selector of [":root", "html.dark"]) {
    const foreground = themeColor(selector, "text-muted");
    for (const surface of ["bg", "bg-panel", "bg-hover", "bg-selected", "user-bg", "assistant-bg", "tool-bg"]) {
      const background = themeColor(selector, surface);
      assert.ok(
        contrastRatio(foreground, background) >= 4.5,
        `${selector} muted icon foreground must meet 4.5:1 contrast against --${surface}`,
      );
    }
  }
});

test("ProviderGlyph renders the provider icon at the requested size, default chip otherwise", () => {
  const known = ProviderGlyph({ id: "deepseek", size: 14 });
  assert.equal(known.type, ProviderIcon);
  const knownRendered = known.type(known.props);
  assert.equal(knownRendered.type, "svg");
  assert.equal(knownRendered.props.width, 14);
  assert.equal(knownRendered.props.height, 14);
  assert.equal(knownRendered.props.children.props.href, "/provider-icons.svg#deepseek");

  const custom = ProviderGlyph({ id: "custom-openai", size: 14 }).type({ id: "custom-openai", size: 14 });
  assert.equal(custom.props.children.props.href, "/provider-icons.svg#openai");

  for (const id of ["unknown-provider", null, undefined]) {
    const glyph = ProviderGlyph({ id, size: 14 });
    assert.equal(glyph.type, DefaultModelIcon);
    const rendered = glyph.type(glyph.props);
    assert.equal(rendered.type, "svg");
    assert.equal(rendered.props.width, 14);
    assert.equal(rendered.props.viewBox, "0 0 24 24");
  }
});
