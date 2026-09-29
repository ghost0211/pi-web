import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const logoutRoute = await readFile(new URL("./logout/[provider]/route.ts", import.meta.url), "utf8");
const loginRoute = await readFile(new URL("./login/[provider]/route.ts", import.meta.url), "utf8");
const apiKeyRoute = await readFile(new URL("./api-key/[provider]/route.ts", import.meta.url), "utf8");
const modelsConfig = await readFile(new URL("../../../components/ModelsConfig.tsx", import.meta.url), "utf8");

test("auth routes resolve providers through the extension-aware services runtime", () => {
  // Extension-registered providers (e.g. pi-commandcode-provider) only expose
  // auth.oauth/auth.apiKey via createAgentSessionServices; a plain
  // ModelRuntime.create() reports them as unknown and disconnect silently 400s.
  for (const [name, source] of [["logout", logoutRoute], ["login", loginRoute], ["api-key", apiKeyRoute]]) {
    assert.match(source, /createAgentSessionServices\(/, `${name} route must use createAgentSessionServices`);
    assert.doesNotMatch(source, /await\s+ModelRuntime\.create\(\)/, `${name} route must not use a plain ModelRuntime`);
    assert.match(source, /projectTrustReloadOptions\(/, `${name} route must keep project extensions gated`);
  }
});

test("oauth disconnect surfaces server errors instead of failing silently", () => {
  const handleLogout = modelsConfig.slice(modelsConfig.indexOf("const handleLogout"));
  assert.match(handleLogout, /if \(!res\.ok\)/);
  assert.match(handleLogout, /phase: "error"/);
});
