import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { collectProviderListingInputs } = await createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
}).import("./provider-listing-runtime.ts");

function syntheticSubscription(id, refresh) {
  return createProvider({
    id,
    models: [],
    auth: {
      oauth: {
        name: `Synthetic ${id}`,
        isSubscription: true,
        async login() { throw new Error("Fixture must never log in"); },
        refresh,
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    api: {
      stream() { throw new Error("Fixture must never call a model"); },
      streamSimple() { throw new Error("Fixture must never call a model"); },
    },
  });
}

async function fixture(t, credentials) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subscription-regression-"));
  const authPath = join(root, "auth.json");
  await writeFile(authPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  const runtimes = [];
  t.after(async () => {
    // Drain availability snapshots queued by native-provider registration before
    // removing the temporary store. No auth resolution/model request is made.
    await Promise.all(runtimes.map((runtime) => runtime.refresh({ allowNetwork: false })));
    await rm(root, { recursive: true, force: true });
  });
  return {
    authPath,
    async runtime() {
      const runtime = await ModelRuntime.create({
        authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

for (const id of ["openai-codex", "kimi-coding"]) {
  test(`${id} subscription listing is read-only and does not refresh expired tokens`, { timeout: 10000 }, async (t) => {
    const original = {
      [id]: { type: "oauth", access: "fixture-expired", refresh: "fixture-refresh", expires: 0 },
      unrelated: { type: "oauth", access: "fixture-other", refresh: "fixture-other-refresh", expires: 0 },
    };
    const f = await fixture(t, original);
    const before = await readFile(f.authPath, "utf8");
    let refreshes = 0;
    const runtime = await f.runtime();
    runtime.registerNativeProvider(syntheticSubscription(id, async () => {
      refreshes++;
      throw new Error("Listing must not refresh OAuth credentials");
    }));
    await runtime.refresh({ allowNetwork: false });
    const inputs = await collectProviderListingInputs(runtime);
    const provider = inputs.find((entry) => entry.id === id);
    assert.equal(provider.hasOAuth, true);
    assert.equal(provider.credentialType, "oauth");
    assert.equal(provider.status.configured, true);
    assert.equal(refreshes, 0);
    assert.equal(await readFile(f.authPath, "utf8"), before);
  });

  test(`${id} cancelled refresh still persists rotated tokens for the next runtime`, { timeout: 10000 }, async (t) => {
    const untouched = { type: "oauth", access: "fixture-other", refresh: "fixture-other-refresh", expires: 0 };
    const f = await fixture(t, {
      [id]: { type: "oauth", access: "fixture-expired", refresh: "fixture-old-refresh", expires: 0 },
      unrelated: untouched,
    });
    const first = await f.runtime();
    const second = await f.runtime();
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    t.after(() => finish.resolve());
    let refreshes = 0;
    let refreshSignal;
    const rotated = { type: "oauth", access: "fixture-rotated-access", refresh: "fixture-rotated-refresh", expires: Date.now() + 3600000 };
    const provider = syntheticSubscription(id, async (credential, signal) => {
      refreshes++;
      assert.equal(credential.refresh, "fixture-old-refresh");
      refreshSignal = signal;
      started.resolve();
      await finish.promise;
      signal.throwIfAborted();
      return rotated;
    });
    first.registerNativeProvider(provider);
    second.registerNativeProvider(provider);
    const abort = new AbortController();
    const request = first.getAuth(id, { signal: abort.signal });
    // Attach the rejection observer before aborting, including on slow runners.
    const rejected = assert.rejects(request, (error) => error === abort.signal.reason);
    try {
      await started.promise;
      abort.abort();
      await rejected;
      assert.equal(refreshSignal.aborted, false, "Caller cancellation must not discard a rotated refresh token");
    } finally {
      // Unblock SDK persistence even when an assertion fails; a cancelled
      // caller has already returned but the token rotation is still running.
      finish.resolve();
    }
    const next = await second.getAuth(id);
    assert.equal(next.auth.apiKey, rotated.access);
    assert.equal(refreshes, 1, "Concurrent runtimes must reuse the stored rotation, not double refresh");
    const stored = JSON.parse(await readFile(f.authPath, "utf8"));
    assert.deepEqual(stored[id], rotated);
    assert.deepEqual(stored.unrelated, untouched);
  });
}
