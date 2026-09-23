import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  computeEffectiveSystemPrompt,
  createSystemPromptExtension,
} = await jiti.import("./system-prompt-extension.ts");

function state(overrides = {}) {
  return { custom: null, ...overrides };
}

test("keeps Pi's natural prompt when nothing is customized", () => {
  assert.equal(computeEffectiveSystemPrompt("natural", state()), "natural");
  assert.equal(computeEffectiveSystemPrompt(undefined, state()), undefined);
});

test("appends the customization after the natural prompt", () => {
  const custom = { mode: "append", text: "extra rules" };
  assert.equal(
    computeEffectiveSystemPrompt("natural", state({ custom })),
    "natural\n\nextra rules",
  );
  // An empty base prompt leaves only the customization.
  assert.equal(computeEffectiveSystemPrompt("", state({ custom })), "extra rules");
  assert.equal(computeEffectiveSystemPrompt(undefined, state({ custom })), undefined);
});

test("replaces the whole prompt in replace mode", () => {
  const custom = { mode: "replace", text: "only this" };
  assert.equal(computeEffectiveSystemPrompt("natural", state({ custom })), "only this");
  assert.equal(computeEffectiveSystemPrompt(undefined, state({ custom })), "only this");
});

test("chat-only exact prompts win over any customization", () => {
  const sources = state({
    exact: () => "context files",
    custom: { mode: "replace", text: "ignored" },
  });
  assert.equal(computeEffectiveSystemPrompt("natural", sources), "context files");
});

/** Capture the handler the extension registers with the SDK. */
function handlerFor(promptState, onPrompts) {
  let handler;
  const extension = createSystemPromptExtension(promptState, onPrompts ? { onPrompts } : {});
  extension.factory({
    on(event, registered) {
      assert.equal(event, "before_agent_start");
      handler = registered;
      return () => {};
    },
  });
  return handler;
}

test("forces the effective prompt through before_agent_start", () => {
  const promptState = state({ custom: { mode: "append", text: "extra rules" } });
  const seen = [];
  const handler = handlerFor(promptState, (prompts) => seen.push(prompts));

  assert.deepEqual(handler({ systemPrompt: "natural" }), {
    systemPrompt: "natural\n\nextra rules",
  });
  assert.deepEqual(seen, [{ natural: "natural", effective: "natural\n\nextra rules" }]);
});

test("stays out of the way when the prompt is unchanged", () => {
  const seen = [];
  const handler = handlerFor(state(), (prompts) => seen.push(prompts));

  assert.equal(handler({ systemPrompt: "natural" }), undefined);
  assert.deepEqual(seen, [{ natural: "natural", effective: "natural" }]);
});

test("reads the live customization on every turn", () => {
  const promptState = state();
  const handler = handlerFor(promptState);

  assert.equal(handler({ systemPrompt: "natural" }), undefined);
  promptState.custom = { mode: "replace", text: "only this" };
  assert.deepEqual(handler({ systemPrompt: "natural" }), { systemPrompt: "only this" });
});
