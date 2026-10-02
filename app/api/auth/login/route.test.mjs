import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const tempStubDir = mkdtempSync(join(tmpdir(), "pi-web-auth-login-stub-"));
const stubPath = join(tempStubDir, "agent-stub.ts");
const realAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));

writeFileSync(
  stubPath,
  `
export * from ${JSON.stringify(realAgentEntry)};
export const getAgentDir = () => globalThis.__testAgentDir ?? ${JSON.stringify(tempStubDir)};
export const createAgentSessionServices = async () => ({
  modelRuntime: globalThis.__testModelRuntime,
});
`,
);

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": stubPath,
    "@": process.cwd(),
  },
  interopDefault: true,
  moduleCache: false,
});

const { GET, POST } = await jiti.import("./[provider]/route.ts");

afterEach(() => {
  delete globalThis.__testModelRuntime;
  delete globalThis.__testAgentDir;
  if (globalThis.__piLoginCallbacks) {
    globalThis.__piLoginCallbacks.clear();
  }
});

test.after(() => {
  rmSync(tempStubDir, { recursive: true, force: true });
});

/** Helper to parse line-delimited SSE data events from a ReadableStream. */
function createSseReader(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const doubleNewline = buffer.indexOf("\n\n");
        if (doubleNewline !== -1) {
          const rawMessage = buffer.slice(0, doubleNewline).trim();
          buffer = buffer.slice(doubleNewline + 2);
          for (const line of rawMessage.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              return JSON.parse(trimmed.slice(5).trim());
            }
          }
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error("Timed out waiting for next SSE event");
        }

        let timer;
        let chunk;
        try {
          chunk = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("Timeout reading SSE chunk")), remainingMs);
            }),
          ]);
        } finally { clearTimeout(timer); }
        const { value, done } = chunk;

        if (done) {
          if (buffer.trim()) {
            for (const line of buffer.trim().split("\n")) {
              const trimmed = line.trim();
              if (trimmed.startsWith("data:")) {
                buffer = "";
                return JSON.parse(trimmed.slice(5).trim());
              }
            }
          }
          return null;
        }

        buffer += decoder.decode(value, { stream: true });
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

function jsonRequest(url, body, options = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
}

test("standard oauth flow: select(copy_code/browser) -> auth_url -> manual_code -> POST submit -> success via SSE bridge", async () => {
  let promptCount = 0;
  let receivedSelectedOption = "";
  let receivedCode = "";

  globalThis.__testModelRuntime = {
    getProvider: (id) =>
      id === "anthropic"
        ? {
            id: "anthropic",
            name: "Anthropic",
            auth: { oauth: { name: "Anthropic (Claude Pro/Max)" } },
          }
        : undefined,
    login: async (provider, type, interaction) => {
      assert.equal(provider, "anthropic");
      assert.equal(type, "oauth");

      // 1. Initial select prompt: copy_code vs browser
      promptCount++;
      const selected = await interaction.prompt({
        type: "select",
        message: "Select Anthropic login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "copy_code", label: "Copy code login (headless)" },
        ],
      });
      receivedSelectedOption = selected;

      // 2. Headless copy-code branch: notify auth_url followed by manual_code prompt
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?state=verifier-test",
        instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
      });

      promptCount++;
      const code = await interaction.prompt({
        type: "manual_code",
        message: "Paste the code Anthropic shows after you sign in:",
        placeholder: "code#state",
        signal: interaction.signal,
      });
      receivedCode = code;

      interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
      return { type: "oauth", access: "mock-access-token" };
    },
  };

  const getReq = new Request("http://localhost/api/auth/login/anthropic");
  const getRes = await GET(getReq, { params: Promise.resolve({ provider: "anthropic" }) });

  assert.equal(getRes.status, 200);
  assert.match(getRes.headers.get("content-type") ?? "", /text\/event-stream/);

  const sse = createSseReader(getRes.body);

  // 1. Receive select_request
  const selectEvent = await sse.nextEvent();
  assert.equal(selectEvent.type, "select_request");
  assert.match(selectEvent.message, /Select Anthropic login method/);
  assert.deepEqual(selectEvent.options, [
    { id: "browser", label: "Browser login (default)" },
    { id: "copy_code", label: "Copy code login (headless)" },
  ]);
  assert.ok(selectEvent.token.startsWith("anthropic-"));
  assert.equal(globalThis.__piLoginCallbacks?.has(selectEvent.token), true);

  // 2. Client selects copy_code via POST
  const selectPostRes = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token: selectEvent.token,
      code: "copy_code",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(selectPostRes.status, 200);
  assert.deepEqual(await selectPostRes.json(), { ok: true, provider: "anthropic" });
  assert.equal(globalThis.__piLoginCallbacks?.has(selectEvent.token), false);

  // 3. Receive auth_url event
  const authUrlEvent = await sse.nextEvent();
  assert.equal(authUrlEvent.type, "auth");
  assert.match(authUrlEvent.url, /claude\.ai\/oauth\/authorize/);
  assert.match(authUrlEvent.instructions, /copy the code Anthropic shows/);
  assert.ok(authUrlEvent.token.startsWith("anthropic-"));

  // 4. Receive manual_code prompt_request event
  const manualPromptEvent = await sse.nextEvent();
  assert.equal(manualPromptEvent.type, "prompt_request");
  assert.match(manualPromptEvent.message, /Paste the code/);
  assert.equal(manualPromptEvent.placeholder, "code#state");
  // Crucial design invariant: auth_url and manual_code must share the exact same pending manual token
  assert.equal(manualPromptEvent.token, authUrlEvent.token);
  assert.equal(globalThis.__piLoginCallbacks?.has(manualPromptEvent.token), true);

  // 5. Client submits manual code via POST
  const codePostRes = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token: manualPromptEvent.token,
      code: "my-auth-code#my-state",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(codePostRes.status, 200);
  assert.deepEqual(await codePostRes.json(), { ok: true, provider: "anthropic" });

  // 6. Receive progress notification
  const progressEvent = await sse.nextEvent();
  assert.equal(progressEvent.type, "progress");
  assert.match(progressEvent.message, /Exchanging authorization code/);

  // 7. Receive final success event
  const successEvent = await sse.nextEvent();
  assert.equal(successEvent.type, "success");

  // 8. Stream terminates cleanly
  const endEvent = await sse.nextEvent();
  assert.equal(endEvent, null);

  assert.equal(promptCount, 2);
  assert.equal(receivedSelectedOption, "copy_code");
  assert.equal(receivedCode, "my-auth-code#my-state");
  assert.equal(globalThis.__piLoginCallbacks?.size ?? 0, 0, "No pending callbacks leaked in registry");
});

test("cancellation while waiting for select prompt cleans up active tokens and rejects pending input", async () => {
  const abortController = new AbortController();

  globalThis.__testModelRuntime = {
    getProvider: () => ({ auth: { oauth: { name: "Mock OAuth" } } }),
    login: async (_provider, _type, interaction) => {
      // Waiting on client select
      await interaction.prompt({
        type: "select",
        message: "Choose method:",
        options: [{ id: "copy_code", label: "Copy code" }],
      });
    },
  };

  const req = new Request("http://localhost/api/auth/login/anthropic", { signal: abortController.signal });
  const res = await GET(req, { params: Promise.resolve({ provider: "anthropic" }) });
  const sse = createSseReader(res.body);

  const selectEvent = await sse.nextEvent();
  assert.equal(selectEvent.type, "select_request");
  const token = selectEvent.token;
  assert.equal(globalThis.__piLoginCallbacks?.has(token), true);

  // Abort client connection before user answers
  abortController.abort();

  const cancelEvent = await sse.nextEvent();
  assert.equal(cancelEvent.type, "cancelled");

  const streamEnd = await sse.nextEvent();
  assert.equal(streamEnd, null);

  assert.equal(globalThis.__piLoginCallbacks?.has(token), false, "Pending token must be cleaned up on cancel");

  // Late POST attempt must be rejected with 404
  const latePost = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token,
      code: "copy_code",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(latePost.status, 404);
  assert.deepEqual(await latePost.json(), { error: "No pending login for token" });
  assert.equal(globalThis.__piLoginCallbacks?.size ?? 0, 0);
});

test("cancellation while waiting for manual_code prompt cleans up token and pending callbacks", async () => {
  const abortController = new AbortController();

  globalThis.__testModelRuntime = {
    getProvider: () => ({ auth: { oauth: { name: "Mock OAuth" } } }),
    login: async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Choose method:",
        options: [{ id: "copy_code", label: "Copy code" }],
      });
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.com",
      });
      await interaction.prompt({
        type: "manual_code",
        message: "Paste code:",
      });
    },
  };

  const req = new Request("http://localhost/api/auth/login/anthropic", { signal: abortController.signal });
  const res = await GET(req, { params: Promise.resolve({ provider: "anthropic" }) });
  const sse = createSseReader(res.body);

  // 1. Select prompt arrives and is resolved
  const selectEvent = await sse.nextEvent();
  await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token: selectEvent.token,
      code: "copy_code",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );

  // 2. Auth URL & manual code prompt arrive
  const authEvent = await sse.nextEvent();
  const manualPrompt = await sse.nextEvent();
  assert.equal(manualPrompt.type, "prompt_request");
  const manualToken = manualPrompt.token;
  assert.equal(manualToken, authEvent.token);
  assert.equal(globalThis.__piLoginCallbacks?.has(manualToken), true);

  // 3. User cancels / disconnects during code entry
  abortController.abort();

  const cancelEvent = await sse.nextEvent();
  assert.equal(cancelEvent.type, "cancelled");

  const streamEnd = await sse.nextEvent();
  assert.equal(streamEnd, null);

  assert.equal(globalThis.__piLoginCallbacks?.has(manualToken), false, "Manual code token must be pruned");

  // Late POST attempt must be rejected with 404
  const latePost = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token: manualToken,
      code: "my-code",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(latePost.status, 404);
  assert.deepEqual(await latePost.json(), { error: "No pending login for token" });
  assert.equal(globalThis.__piLoginCallbacks?.size ?? 0, 0);
});

test("POST endpoint validates request payload and rejects mismatched or non-existent tokens", async () => {
  // 1. Missing token or code
  const missingBoth = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {}),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(missingBoth.status, 400);
  assert.deepEqual(await missingBoth.json(), { error: "token and code required" });

  const missingCode = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", { token: "anthropic-123" }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(missingCode.status, 400);

  // 2. Non-existent token
  const nonExistent = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token: "anthropic-missing-token",
      code: "my-code",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(nonExistent.status, 404);
  assert.deepEqual(await nonExistent.json(), { error: "No pending login for token" });

  // 3. Token provider prefix mismatch
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  globalThis.__piLoginCallbacks.set("openai-999-abc", { resolve() {}, reject() {} });

  const mismatchProvider = await POST(
    jsonRequest("http://localhost/api/auth/login/anthropic", {
      token: "openai-999-abc",
      code: "my-code",
    }),
    { params: Promise.resolve({ provider: "anthropic" }) },
  );
  assert.equal(mismatchProvider.status, 400);
  assert.deepEqual(await mismatchProvider.json(), { error: "Token does not match provider" });
});

test("GET endpoint rejects unknown providers or providers without OAuth capability", async () => {
  globalThis.__testModelRuntime = {
    getProvider: (id) => {
      if (id === "api-key-only") {
        return { id: "api-key-only", auth: { apiKey: { login: async () => ({}) } } };
      }
      return undefined;
    },
    login: async () => {
      throw new Error("Should not be called");
    },
  };

  // Unknown provider
  const unknownRes = await GET(new Request("http://localhost/api/auth/login/unknown"), {
    params: Promise.resolve({ provider: "unknown" }),
  });
  const unknownSse = createSseReader(unknownRes.body);
  const unknownError = await unknownSse.nextEvent();
  assert.deepEqual(unknownError, { type: "error", message: "Unknown provider: unknown" });
  assert.equal(await unknownSse.nextEvent(), null);

  // Provider with only apiKey (no oauth)
  const noOAuthRes = await GET(new Request("http://localhost/api/auth/login/api-key-only"), {
    params: Promise.resolve({ provider: "api-key-only" }),
  });
  const noOAuthSse = createSseReader(noOAuthRes.body);
  const noOAuthError = await noOAuthSse.nextEvent();
  assert.deepEqual(noOAuthError, { type: "error", message: "Unknown provider: api-key-only" });
  assert.equal(await noOAuthSse.nextEvent(), null);
});

test("SSE bridge forwards device_code events and progress notifications faithfully", async () => {
  globalThis.__testModelRuntime = {
    getProvider: () => ({ auth: { oauth: { name: "Device Flow Provider" } } }),
    login: async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.com/device",
        intervalSeconds: 5,
        expiresInSeconds: 300,
      });
      interaction.notify({ type: "progress", message: "Waiting for user authorization..." });
      return { type: "oauth", access: "ok" };
    },
  };

  const res = await GET(new Request("http://localhost/api/auth/login/device-flow"), {
    params: Promise.resolve({ provider: "device-flow" }),
  });
  const sse = createSseReader(res.body);

  const deviceEvent = await sse.nextEvent();
  assert.deepEqual(deviceEvent, {
    type: "device_code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://example.com/device",
    intervalSeconds: 5,
    expiresInSeconds: 300,
  });

  const progressEvent = await sse.nextEvent();
  assert.deepEqual(progressEvent, {
    type: "progress",
    message: "Waiting for user authorization...",
  });

  const successEvent = await sse.nextEvent();
  assert.equal(successEvent.type, "success");
  assert.equal(await sse.nextEvent(), null);
});
