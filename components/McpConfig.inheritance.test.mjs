import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { componentHarness, tick } from "./mcp-test-harness.mjs";

const { McpConfig } = await createJiti(import.meta.url, { tsconfigPaths: true, jsx: true }).import("./McpConfig.tsx");
const base = { name: "private-tools", config: { url: "https://example.test/mcp", enabled: false, exposure: "hidden", toolExposure: { secret: "hidden" } } };
function fixture(t, existingOverride) {
  const data = { files: [
    { scope: "global", path: "/fixture/agent/mcp.json", revision: "global", servers: [base] },
    { scope: "project", path: "/fixture/.pi/mcp.json", revision: "project", servers: existingOverride ? [{ name: base.name, config: {} }] : [] },
  ], project: { cwd: "/fixture", trusted: true }, errors: [] };
  const calls = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return Response.json(url.startsWith("/api/mcp/runtime") ? { available: true, live: true, statusText: "private-tools: disabled" } : data);
  };
  const harness = componentHarness(McpConfig, { cwd: "/fixture", sessionId: "sid", embedded: true, onClose() {}, onSessionReloaded() {} });
  t.after(() => { harness.cleanup(); globalThis.fetch = fetch; });
  harness.render();
  return { harness, calls };
}
const select = (harness, label) => harness.find((node) => node.type === "select" && node.props?.["aria-label"] === label);
const enabled = (harness) => harness.find((node) => node.props?.role === "switch" && node.props?.["aria-label"] === "mcp.enabled");

function assertInherited(harness) {
  assert.equal(enabled(harness).props["aria-checked"], false);
  assert.equal(select(harness, "mcp.exposure").props.value, "hidden");
  assert.deepEqual(JSON.parse(harness.input("mcp.toolExposure").props.value), { secret: "hidden" });
  assert.equal(harness.button("mcp.reconnect").props.disabled, true);
}

test("editing an existing thin override displays inherited restrictions and does not activate tools on save", async (t) => {
  const { harness, calls } = fixture(t, true);
  await tick(); harness.render();
  const project = harness.find((node) => node.type === "button" && !node.props?.["aria-current"] && typeof node.props?.onClick === "function" && JSON.stringify(node).includes(base.name));
  assert.ok(project); project.props.onClick(); harness.render();
  assert.equal(select(harness, "mcp.serverType").props.disabled, true);
  assertInherited(harness);
  harness.button("mcp.save").props.onClick(); await tick(); harness.render();
  const request = calls.find((call) => call.options.method === "PUT");
  assert.deepEqual(JSON.parse(request.options.body).config, {});
  assertInherited(harness);
});

for (const nameFirst of [true, false]) {
  test(`new thin overrides inherit safely when ${nameFirst ? "name" : "type"} is entered first`, async (t) => {
    const { harness, calls } = fixture(t, false);
    await tick(); harness.render();
    // The existing full definition must retain its transport-editing control.
    assert.notEqual(select(harness, "mcp.serverType").props.disabled, true);
    harness.button("mcp.addProjectServer").props.onClick(); harness.render();
    const setName = () => { harness.input("mcp.serverName").props.onChange({ target: { value: base.name } }); harness.render(); };
    const setType = () => { select(harness, "mcp.serverType").props.onChange({ target: { value: "override" } }); harness.render(); };
    if (nameFirst) { setName(); setType(); } else { setType(); setName(); }
    assertInherited(harness);
    harness.button("mcp.save").props.onClick(); await tick(); harness.render();
    const request = calls.find((call) => call.options.method === "PUT");
    assert.deepEqual(JSON.parse(request.options.body).config, {});
  });
}
