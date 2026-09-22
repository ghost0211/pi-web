import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatScrollbar } = await jiti.import("./ChatScrollbar.tsx");

test("renders an accessible empty rail before measurement", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatScrollbar, { scrollContainer: { current: null } }),
  );

  assert.match(html, /role="scrollbar"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-controls="/);
  assert.match(html, /aria-valuenow="0"/);
  // The thumb is only rendered once measured against a live scroll container.
  assert.doesNotMatch(html, /class="thumb"/);
});
