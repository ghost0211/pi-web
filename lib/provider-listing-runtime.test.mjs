import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { collectProviderListingInputs } = await jiti.import("./provider-listing-runtime.ts");
const { buildApiKeyProviderList, buildOAuthProviderList } = await jiti.import("./provider-listing.ts");

function createMockRuntime({
  providers = [],
  models = [],
  credentials = [],
  authStatuses = {},
  listCredentialsError = null,
} = {}) {
  return {
    getProviders() {
      return providers;
    },
    getModels() {
      return models;
    },
    async listCredentials() {
      if (listCredentialsError) {
        throw listCredentialsError;
      }
      return credentials;
    },
    getProviderAuthStatus(providerId) {
      return authStatuses[providerId] ?? { configured: false };
    },
  };
}

test("collectProviderListingInputs discovers Radius dual APIKey/OAuth capability automatically and lists once", async () => {
  // Radius defines both apiKey (with interactive login) and oauth in its auth declaration
  const radiusProvider = {
    id: "radius",
    name: "Radius",
    auth: {
      apiKey: {
        name: "Radius API key",
        login: async () => ({ type: "api_key", key: "mock" }),
      },
      oauth: {
        name: "Radius",
      },
    },
  };

  const models = [
    { id: "balanced", name: "Balanced", provider: "radius" },
    { id: "fast", name: "Fast", provider: "radius" },
  ];

  // Case 1: No credentials stored (unconfigured)
  const unconfiguredRuntime = createMockRuntime({
    providers: [radiusProvider],
    models,
    credentials: [],
    authStatuses: { radius: { configured: false } },
  });

  const unconfiguredInputs = await collectProviderListingInputs(unconfiguredRuntime);
  assert.equal(unconfiguredInputs.length, 1);
  assert.deepEqual(unconfiguredInputs[0], {
    id: "radius",
    name: "Radius",
    hasApiKeyLogin: true,
    hasOAuth: true,
    oauthName: "Radius",
    status: { configured: false },
    modelCount: 2,
  });

  const apiKeyListUnconf = buildApiKeyProviderList(unconfiguredInputs);
  const oauthListUnconf = buildOAuthProviderList(unconfiguredInputs);
  assert.equal(apiKeyListUnconf.length, 1);
  assert.equal(apiKeyListUnconf[0].id, "radius");
  assert.equal(apiKeyListUnconf[0].configured, false);
  assert.equal(apiKeyListUnconf[0].supportsOAuth, true);
  assert.equal(oauthListUnconf.length, 1);
  assert.equal(oauthListUnconf[0].id, "radius");
  assert.equal(oauthListUnconf[0].loggedIn, false);
  assert.equal(oauthListUnconf[0].supportsApiKey, true);

  // Case 2: Configured via API key
  const apiKeyRuntime = createMockRuntime({
    providers: [radiusProvider],
    models,
    credentials: [{ providerId: "radius", type: "api_key" }],
    authStatuses: { radius: { configured: true, source: "stored" } },
  });

  const apiKeyInputs = await collectProviderListingInputs(apiKeyRuntime);
  const apiKeyListConfigured = buildApiKeyProviderList(apiKeyInputs);
  const oauthListWithApiKey = buildOAuthProviderList(apiKeyInputs);
  assert.equal(apiKeyListConfigured[0].configured, true);
  assert.equal(apiKeyListConfigured[0].source, "stored");
  assert.equal(oauthListWithApiKey[0].loggedIn, false);

  // Case 3: Configured via OAuth
  const oauthRuntime = createMockRuntime({
    providers: [radiusProvider],
    models,
    credentials: [{ providerId: "radius", type: "oauth" }],
    authStatuses: { radius: { configured: true, source: "stored" } },
  });

  const oauthInputs = await collectProviderListingInputs(oauthRuntime);
  const apiKeyListWithOAuth = buildApiKeyProviderList(oauthInputs);
  const oauthListConfigured = buildOAuthProviderList(oauthInputs);
  assert.equal(apiKeyListWithOAuth[0].configured, false);
  assert.equal(oauthListConfigured[0].loggedIn, true);
});

test("collectProviderListingInputs survives credential listing errors without dropping Radius", async () => {
  const radiusProvider = {
    id: "radius",
    name: "Radius",
    auth: {
      apiKey: { name: "Radius API key", login: async () => ({}) },
      oauth: { name: "Radius" },
    },
  };

  const brokenRuntime = createMockRuntime({
    providers: [radiusProvider],
    listCredentialsError: new Error("Malformed auth.json file"),
    authStatuses: { radius: { configured: true, source: "stored" } },
  });

  const inputs = await collectProviderListingInputs(brokenRuntime);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].id, "radius");
  assert.equal(inputs[0].hasApiKeyLogin, true);
  assert.equal(inputs[0].hasOAuth, true);
});

test("buildApiKeyProviderList and buildOAuthProviderList deduplicate repeated Radius entries", async () => {
  const radiusProvider1 = {
    id: "radius",
    name: "Radius",
    auth: {
      apiKey: { name: "Radius API key", login: async () => ({}) },
      oauth: { name: "Radius" },
    },
  };
  const radiusProvider2 = {
    id: "radius",
    name: "Radius Custom Gateway",
    auth: {
      apiKey: { name: "Radius API key", login: async () => ({}) },
      oauth: { name: "Radius" },
    },
  };

  const duplicatedRuntime = createMockRuntime({
    providers: [radiusProvider1, radiusProvider2],
    authStatuses: { radius: { configured: false } },
  });

  const inputs = await collectProviderListingInputs(duplicatedRuntime);
  assert.equal(inputs.length, 2);

  const apiKeyList = buildApiKeyProviderList(inputs);
  const oauthList = buildOAuthProviderList(inputs);
  assert.equal(apiKeyList.length, 1, "API key list must deduplicate and list Radius only once");
  assert.equal(oauthList.length, 1, "OAuth list must deduplicate and list Radius only once");
});

test("SDK ModelRuntime integration discovers Radius dual capability in an isolated agent dir", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-web-radius-test-"));
  const authPath = join(tempDir, "auth.json");
  await writeFile(authPath, JSON.stringify({}));

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Verify dynamic ModelRuntime creation without network access or real user config
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  const inputs = await collectProviderListingInputs(runtime);
  const radiusInput = inputs.find((p) => p.id === "radius");
  assert.ok(radiusInput, "ModelRuntime must expose built-in radius provider");
  assert.equal(radiusInput.hasApiKeyLogin, true, "Radius must declare interactive API-key login");
  assert.equal(radiusInput.hasOAuth, true, "Radius must declare OAuth capability");

  const apiKeyList = buildApiKeyProviderList(inputs);
  const oauthList = buildOAuthProviderList(inputs);
  const radiusApiKey = apiKeyList.find((p) => p.id === "radius");
  const radiusOAuth = oauthList.find((p) => p.id === "radius");

  assert.ok(radiusApiKey, "Radius must appear in API key listing");
  assert.equal(radiusApiKey.supportsOAuth, true, "Radius in API key listing must signal supportsOAuth");
  assert.ok(radiusOAuth, "Radius must appear in OAuth listing");
  assert.equal(radiusOAuth.supportsApiKey, true, "Radius in OAuth listing must signal supportsApiKey");
});
