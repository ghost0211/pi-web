/**
 * End-to-end check of the questionnaire feature against the real SDK session:
 * the tool must be declared to the model, its call must surface as an
 * `extension_ui_request` with `method: "questionnaire"`, the answer must travel
 * back through `extension_ui_response`, and the model must receive the
 * formatted answers as a tool result in the same run.
 *
 * The only thing stubbed is the model: everything else is the production path
 * (`createAskUserQuestionExtension` + `AgentSessionWrapper.requestQuestionnaire`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createAskUserQuestionExtension, ASK_USER_QUESTION_TOOL_NAME } = await jiti.import(
  "./ask-user-question-extension.ts",
);

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const QUESTIONNAIRE = {
  title: "执行前确认",
  questions: [
    {
      header: "目标环境",
      question: "本次迁移脚本要在哪个环境执行？",
      options: [
        { label: "测试环境", description: "先做一次完整演练", recommended: true },
        { label: "生产环境", description: "直接上线" },
      ],
    },
  ],
};

function assistantMessage(selected, content, stopReason = "stop") {
  return {
    role: "assistant",
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    timestamp: Date.now(),
    content,
    stopReason,
    usage,
  };
}

function streamOf(message) {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
  });
  return stream;
}

test("the questionnaire tool is declared, called, answered and reported back to the model", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-questionnaire-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("questionnaire-fixture", {
    api: "openai-completions",
    baseUrl: "https://fixture.invalid",
    apiKey: "fixture-not-real",
    models: [{
      id: "main",
      name: "Main",
      reasoning: false,
      input: ["text"],
      contextWindow: 50_000,
      maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  const model = runtime.getModel("questionnaire-fixture", "main");
  const manager = SessionManager.inMemory(root);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });

  // Same shape as the production wiring in startRpcSession: the extension gets a
  // host that routes the questionnaire through the wrapper.
  const host = { wrapper: null };
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createAskUserQuestionExtension({
        ask: (questions, toolCallId, signal, title) => {
          if (!host.wrapper) throw new Error("host not ready");
          return host.wrapper.requestQuestionnaire(questions, toolCallId, signal, title);
        },
      }),
    ],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    sessionManager: manager,
    settingsManager: settings,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    resourceLoader: loader,
    // No `tools` allow-list: that is what production does for a non-empty
    // preset, because an allow-list filters registered extension tools out.
  });
  const errors = [];
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });

  // The model must actually be offered the tool.
  const all = session.getAllTools();
  const declared = all.find((tool) => tool.name === ASK_USER_QUESTION_TOOL_NAME);
  assert.ok(declared, `ask_user_question must be registered (got ${all.map((tool) => tool.name).join(", ")})`);
  assert.equal(declared.exposure, "model-only");
  assert.ok(session.getActiveToolNames().includes(ASK_USER_QUESTION_TOOL_NAME), "a registered model-only tool is active");

  const contexts = [];
  let turn = 0;
  session.agent.streamFunction = (selected, context) => {
    contexts.push(context);
    turn += 1;
    if (turn === 1) {
      const message = assistantMessage(selected, [{
        type: "toolCall",
        id: "call-questionnaire",
        name: ASK_USER_QUESTION_TOOL_NAME,
        arguments: QUESTIONNAIRE,
      }], "toolUse");
      return streamOf(message);
    }
    return streamOf(assistantMessage(selected, [{ type: "text", text: "Fixture answer after the questionnaire" }]));
  };

  const wrapper = new AgentSessionWrapper(session);
  const requests = [];
  // Wait for the terminal lifecycle event rather than for the admission ack:
  // `prompt` resolves once accepted, which can be before the run even starts.
  let settleRun;
  const settled = new Promise((resolve) => { settleRun = resolve; });
  const unsubscribe = wrapper.onEvent((event) => {
    if (event.type === "agent_settled") settleRun();
    if (event.type !== "extension_ui_request") return;
    if (event.method !== "questionnaire") return;
    requests.push(event);
    // Answer the way the panel does: normalized answers on the same request id.
    void wrapper.send({
      type: "extension_ui_response",
      id: event.id,
      answers: [{ kind: "option", optionIndex: 0 }],
    });
  });
  t.after(() => { unsubscribe(); wrapper.destroy(); assert.deepEqual(errors, [], "no extension runtime errors"); });
  host.wrapper = wrapper;
  wrapper.start();
  await wrapper.waitUntilReady?.();

  await wrapper.send({ type: "prompt", message: "帮我确认一下再动手" });
  await Promise.race([
    settled,
    new Promise((_, reject) => setTimeout(() => reject(new Error("run did not settle")), 15_000)),
  ]);

  // The panel-facing request carries the parsed questions.
  assert.equal(requests.length, 1, `expected exactly one questionnaire request, got ${requests.length}`);
  const request = requests[0];
  assert.equal(request.method, "questionnaire");
  assert.equal(request.title, "执行前确认");
  assert.equal(request.questions.length, 1);
  assert.deepEqual(
    request.questions[0].options.map((option) => option.label),
    ["测试环境", "生产环境"],
  );
  assert.equal(request.questions[0].options[0].recommended, true);

  // The model's second request contains the answer as a tool result, so it can
  // continue in the same run instead of asking again.
  assert.equal(contexts.length, 2, "the run continues after the questionnaire");
  const secondRequest = JSON.stringify(contexts[1]);
  assert.match(secondRequest, /测试环境/, "the chosen option reaches the model");
  assert.match(secondRequest, /toolResult/, "it arrives as a tool result, not a user prompt");

  assert.match(session.getLastAssistantText() ?? "", /Fixture answer after the questionnaire/);
});
