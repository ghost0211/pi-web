import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { serverToMcpForm, formToMcpServerPatch } = await createJiti(import.meta.url).import("./mcp-client.ts");
const globalServer = { name: "private-tools", config: { url: "https://example.test/mcp", enabled: false, exposure: "hidden", toolExposure: { secret: "hidden", search: "deferred" } } };
const catalog = { files: [{ scope: "global", servers: [globalServer] }], project: { trusted: true }, errors: [] };

function override(config = {}) {
  return serverToMcpForm("project", { name: globalServer.name, config }, catalog);
}

test("thin overrides display inherited permissions and unchanged saves do not materialize defaults", () => {
  const form = override();
  assert.equal(form.enabled, false);
  assert.equal(form.exposure, "hidden");
  assert.deepEqual(JSON.parse(form.toolExposure), globalServer.config.toolExposure);
  assert.deepEqual(formToMcpServerPatch(form), {});
});

test("changing one thin override field leaves inherited disabled and hidden tools untouched", () => {
  const form = override({ exposure: "direct" });
  assert.equal(form.exposure, "direct");
  assert.equal(form.enabled, false);
  assert.deepEqual(formToMcpServerPatch(form), {});
  assert.deepEqual(formToMcpServerPatch({ ...form, exposure: "deferred" }), { exposure: "deferred" });
  assert.deepEqual(formToMcpServerPatch({ ...form, enabled: true }), { enabled: true });
});

test("explicit default overrides and tool map clearing remain expressible", () => {
  const form = override();
  assert.deepEqual(formToMcpServerPatch({ ...form, enabled: true, exposure: "codemode", toolExposure: "{}" }), {
    enabled: true, exposure: "codemode", toolExposure: {},
  });
  assert.deepEqual(formToMcpServerPatch({ ...form, toolExposure: '{"search":"deferred","secret":"hidden"}' }), {});
});

test("new thin override drafts also preserve inheritance until a field is edited", () => {
  const form = { ...override(), isNew: true };
  assert.deepEqual(formToMcpServerPatch(form), {});
  assert.deepEqual(formToMcpServerPatch({ ...form, enabled: true }), { enabled: true });
});
