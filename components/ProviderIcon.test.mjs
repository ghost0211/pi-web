import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

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
