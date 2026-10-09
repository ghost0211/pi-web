import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  hasModelCostDraftValue,
  modelCostToDraft,
  parseCompleteModelCost,
  renameProviderEntry,
  serializeHeaderRows,
  setCompatBool,
  updateHeaderRow,
} = await jiti.import("./models-config-helpers.ts");

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

test("uses shared sidebar sizing for providers and matching indented model rows", () => {
  const sidebar = source.slice(source.indexOf("<ConfigSidebar>"), source.indexOf("</ConfigSidebar>"));

  assert.match(sidebar, /<ConfigSidebarItem[\s\S]*?active=\{isSelected\}/);
  assert.match(sidebar, /<ConfigSidebarItem[\s\S]*?active=\{isProviderSelected\}/);
  assert.match(sidebar, /className="models-sidebar-indented-item"/);
  assert.match(sidebar, /className="models-sidebar-indented-item models-sidebar-add-item"/);
  assert.match(cssSource, /\.models-sidebar-indented-item \{[\s\S]*?padding-left: 26px/);
});

test("ignores malformed auth provider responses", () => {
  assert.match(
    source,
    /if \(Array\.isArray\(d\.oauthProviders\)\) setOauthProviders\(d\.oauthProviders\)/,
  );
  assert.match(
    source,
    /if \(Array\.isArray\(d\.apiKeyProviders\)\) setApiKeyProviders\(d\.apiKeyProviders\)/,
  );
});

test("custom model config exposes provider-level request headers", () => {
  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  assert.match(providerDetail, /<HeaderListEditor/);
  assert.match(providerDetail, /headers=\{provider\.headers\}/);
  assert.match(providerDetail, /set\("headers", headers\)/);
});

test("custom model config exposes model headers and supportsDeveloperRole compat flag", () => {
  // Model-level headers editor, wired to the model entry.
  assert.match(source, /headers=\{model\.headers\}/);
  assert.match(source, /set\("headers", headers\)/);

  // Model-level compat toggle reads the effective (provider+model) value so
  // hand-edited models.json settings are reflected, while writes stay on the
  // model entry as an explicit per-model override.
  assert.match(source, /effectiveCompat\(provider, model\)\["supportsDeveloperRole"\] !== false/);
  assert.match(source, /setCompatBool\(model, "supportsDeveloperRole", v\)/);
});

test("disabling the developer role writes an explicit false override", () => {
  assert.deepEqual(
    setCompatBool({ compat: { supportsStore: true } }, "supportsDeveloperRole", false),
    { compat: { supportsStore: true, supportsDeveloperRole: false } },
  );
});

test("editing a header preserves row order and stable identities", () => {
  const rows = [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two" },
  ];
  const updated = updateHeaderRow(rows, 10, { name: "X-First-Edited" });

  assert.deepEqual(updated.map(({ id, name }) => ({ id, name })), [
    { id: 10, name: "X-First-Edited" },
    { id: 11, name: "X-Second" },
  ]);
  assert.deepEqual(serializeHeaderRows(updated), {
    "X-First-Edited": "one",
    "X-Second": "two",
  });
});

test("blank header drafts are omitted until they have a name", () => {
  const rows = [
    { id: 1, name: "X-Existing", value: "kept" },
    { id: 2, name: "", value: "draft value" },
  ];

  assert.deepEqual(serializeHeaderRows(rows), { "X-Existing": "kept" });
  assert.deepEqual(
    serializeHeaderRows(updateHeaderRow(rows, 2, { name: "X-Draft" })),
    { "X-Existing": "kept", "X-Draft": "draft value" },
  );
});

test("renames a provider key preserving its entry order", () => {
  const providers = {
    "a-first": { baseUrl: "https://a.example/v1", api: "openai-completions" },
    "b-second": { baseUrl: "https://b.example/v1" },
  };
  const renamed = renameProviderEntry(providers, "a-first", "renamed-a");

  assert.deepEqual(renamed, {
    "renamed-a": { baseUrl: "https://a.example/v1", api: "openai-completions" },
    "b-second": { baseUrl: "https://b.example/v1" },
  });
});

test("refuses to rename onto an existing provider key", () => {
  const providers = {
    "a-first": { baseUrl: "https://a.example/v1" },
    "b-second": { baseUrl: "https://b.example/v1" },
  };

  assert.equal(renameProviderEntry(providers, "a-first", "b-second"), null);
  // The source stays intact and the target is never overwritten.
  assert.deepEqual(providers, {
    "a-first": { baseUrl: "https://a.example/v1" },
    "b-second": { baseUrl: "https://b.example/v1" },
  });
});

test("refuses blank, unchanged, or missing-source renames", () => {
  const providers = {
    "a-first": { baseUrl: "https://a.example/v1" },
  };

  assert.equal(renameProviderEntry(providers, "a-first", "   "), null);
  assert.equal(renameProviderEntry(providers, "a-first", "a-first"), null);
  assert.equal(renameProviderEntry(providers, "missing", "new-name"), null);
  assert.equal(renameProviderEntry(undefined, "a-first", "new-name"), null);
});

test("a typed provider name is committed when clicking Save directly", () => {
  // The Provider 名称 field keeps a local draft; clicking 保存 must commit it
  // instead of silently saving under the old provider key. The panel reads the
  // draft through a ref snapshot captured from the detail's effect.
  assert.match(source, /pendingRenameRef\.current = \{ from, to \}/);
  assert.match(source, /typed name instead of silently writing it under the old key/);
  assert.match(source, /onNameDraft=\{\(draft\) => reportProviderNameDraft/);
  assert.match(source, /const pending = pendingRenameRef\.current/);
  assert.match(source, /setSaveError\(t\("models\.providerNameTaken"/);
});

test("model cost drafts default blank prices to zero unless all are blank", () => {
  const complete = {
    input: "1.25",
    output: "10",
    cacheRead: "0.125",
    cacheWrite: "0",
  };
  assert.deepEqual(parseCompleteModelCost(complete), {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });
  assert.deepEqual(parseCompleteModelCost({ ...complete, input: "", cacheWrite: "" }), {
    input: 0,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });
  assert.deepEqual(parseCompleteModelCost({ input: "1.25", output: "", cacheRead: "", cacheWrite: "" }), {
    input: 1.25,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(parseCompleteModelCost(modelCostToDraft()), undefined);
  assert.equal(parseCompleteModelCost({ ...complete, output: "not-a-price" }), undefined);
  assert.equal(parseCompleteModelCost({ ...complete, output: "-1" }), undefined);
  assert.equal(hasModelCostDraftValue(modelCostToDraft()), false);
  assert.equal(hasModelCostDraftValue({ ...complete, cacheWrite: "" }), true);
});

test("manual price editing commits completed costs and removes only an all-blank group", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.match(modelDetail, /const completeCost = parseCompleteModelCost\(nextDraft\)/);
  assert.match(modelDetail, /if \(completeCost\)/);
  assert.match(modelDetail, /delete nextModel\.cost/);
  assert.match(modelDetail, /const nextDraft = \{ \.\.\.costDraftRef\.current, \[key\]: value \}/);
  assert.match(modelDetail, /costDraftRef\.current = nextDraft/);
  assert.match(modelDetail, /costTemplateRef\.current/);
  assert.match(modelDetail, /value=\{costDraft\[key\]\}/);
});

test("catalog fill applies reasoning_options thinkingLevelMap only when absent", () => {
  const fill = source.slice(
    source.indexOf("function fillEmptyModelFields"),
    source.indexOf("function ModelDetail"),
  );

  assert.match(fill, /if \(!model\.thinkingLevelMap && preset\.thinkingLevelMap\)/);
  assert.match(fill, /next\.thinkingLevelMap = \{ \.\.\.preset\.thinkingLevelMap \}/);
  assert.match(fill, /next\.reasoning = true/);
});

test("model specs keep catalog-filled prices visible outside advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );
  const specsIndex = modelDetail.indexOf('t("models.modelSpecs")');
  const costIndex = modelDetail.indexOf('t("models.costPerMillion")');
  const advancedIndex = modelDetail.indexOf('t("models.advancedSettings")');

  assert.ok(specsIndex >= 0);
  assert.ok(costIndex > specsIndex);
  assert.ok(advancedIndex > costIndex);
  assert.match(modelDetail, /setCostEditing\(false\)/);
  assert.match(modelDetail, /formatCost\(key\)/);
});

test("per-model settings use one primary divider before advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.equal(
    (modelDetail.match(/borderTop: "1px solid var\(--border\)"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(modelDetail, /borderBottom: "1px solid var\(--border\)"/);
});

test("thinking level overrides keep explicit default, disabled, and custom controls", () => {
  const editor = source.slice(
    source.indexOf("function ThinkingLevelMapEditor"),
    source.indexOf("// ── Model detail"),
  );

  assert.match(editor, /THINKING_LEVELS\.map/);
  assert.match(editor, />\s*Default\s*</);
  assert.match(editor, />\s*Disabled\s*</);
  assert.match(editor, />\s*Custom\s*</);
  assert.match(editor, /state === "omit"/);
  assert.match(editor, /state === "null"/);
  assert.match(editor, /state === "string"/);
});

test("ModelEntry declares SDK public sampling parameters without provider-level leakage or wide index signatures", () => {
  const modelEntrySection = source.slice(
    source.indexOf("interface ModelEntry {"),
    source.indexOf("interface ProviderEntry {"),
  );
  const providerEntrySection = source.slice(
    source.indexOf("interface ProviderEntry {"),
    source.indexOf("interface ModelsJson {"),
  );

  // ModelEntry defines public SDK sampling types
  assert.match(modelEntrySection, /samplingParams\?: SamplingParams;/);
  assert.match(modelEntrySection, /samplingParamsByThinkingLevel\?: SamplingParamsByThinkingLevel;/);
  assert.match(source, /import type \{[^}]*\bSamplingParams\b[^}]*,\s*\bSamplingParamsByThinkingLevel\b[^}]*\} from "@earendil-works\/pi-ai"/);

  // ModelEntry does NOT define wide index signature
  assert.doesNotMatch(modelEntrySection, /\[\s*key\s*:\s*string\s*\]/);

  // ProviderEntry does NOT define samplingParams or samplingParamsByThinkingLevel
  assert.doesNotMatch(providerEntrySection, /samplingParams/);
});

test("custom model edits pass through samplingParams and samplingParamsByThinkingLevel untouched", () => {
  const modelWithSampling = {
    id: "qwen-custom",
    samplingParams: {
      temperature: 0.7,
      top_p: 0.9,
    },
    samplingParamsByThinkingLevel: {
      off: { temperature: 0.2, top_p: 0.8 },
      high: { temperature: 1.0, top_k: 20 },
    },
    compat: { supportsStore: true },
  };

  const updatedCompat = setCompatBool(modelWithSampling, "supportsDeveloperRole", false);

  assert.deepEqual(updatedCompat.samplingParams, {
    temperature: 0.7,
    top_p: 0.9,
  });
  assert.deepEqual(updatedCompat.samplingParamsByThinkingLevel, {
    off: { temperature: 0.2, top_p: 0.8 },
    high: { temperature: 1.0, top_k: 20 },
  });
  assert.deepEqual(updatedCompat.compat, {
    supportsStore: true,
    supportsDeveloperRole: false,
  });

  // Source-level verification that ModelDetail and fillEmptyModelFields use shallow copy preserving sampling fields
  assert.match(source, /const next = \{ \.\.\.model \};/);
  assert.match(source, /const set = <K extends keyof ModelEntry>\(k: K, v: ModelEntry\[K\]\) => onChange\(\{ \.\.\.model, \[k\]: v \}\);/);
});

test("omitted provider api protocol is preserved for catalog discovery and never auto-assigned", () => {
  // Opening an existing provider with no explicit api must not auto-fill a guessed protocol
  assert.doesNotMatch(
    source,
    /if\s*\(!provider\.api\)\s*onChange\(\{\s*\.\.\.provider,\s*api:\s*"openai-completions"\s*\}\)/,
  );
  // ProviderDetail API field allows empty value so catalog fallback takes effect
  assert.match(
    source,
    /<Select value=\{provider\.api \?\? ""\} onChange=\{\(v\) => set\("api", v \|\| undefined\)\} options=\{API_OPTIONS\} \/>/,
  );
});

test("unreadable models.json disables Save and surfaces error in footer", () => {
  // loadError state tracks read failures
  assert.match(source, /const \[loadError, setLoadError\] = useState<string \| null>\(null\);/);
  // Fetch /api/models-config catches non-ok or error responses into loadError
  assert.match(source, /if \(!r\.ok \|\| d\.error\) throw new Error\(d\.error \?\? `HTTP \$\{r\.status\}`\);/);
  assert.match(source, /\.catch\(\(e: unknown\) => setLoadError\(e instanceof Error \? e\.message : String\(e\)\)\)/);
  // Do not replace models.json before the read completes or after it fails.
  assert.match(source, /const handleSave = useCallback\(async \(\) => \{\s*if \(loading \|\| loadError\) return;/);
  assert.match(source, /disabled=\{loading \|\| saving \|\| savedOk \|\| loadError !== null\}/);
  // Footer surfaces unreadable error message
  assert.match(source, /loadError \? t\("models\.configUnreadable", \{ error: loadError \}\) : saveError/);
});
