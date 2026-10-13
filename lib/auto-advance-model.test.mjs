import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { evaluateAutoAdvance, autoAdvanceTranscript, autoAdvanceInstruction, autoAdvanceUsageTokens, resolveAutoAdvanceModel } = await jiti.import('./auto-advance-model.ts');
const model = { provider: 'fixture', id: 'path/model', name: 'Fixture', contextWindow: 32768, maxTokens: 4096 };
const config = { goal: 'verify tests pass', scope: 'read and run local non-destructive tests; no publish', model: {provider: model.provider, modelId: model.id}, maxRounds: 3 };
const usage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 36 };
const answer = { role: 'assistant', content: [{type: 'text', text: 'Tests pending'}], stopReason: 'stop' };
const decision = {decision:'continue', reason:'Need actual tests', nextPrompt:'Run the targeted tests', requiresConfirmation:false};
function runtime(response = {}, selectedModel = model) {
  let request;
  return { getAvailable: async () => [selectedModel], getPhysicalModel: () => selectedModel,
    completeSimple: async (...args) => { request = args; return {stopReason:'stop', content:[{type:'text',text:JSON.stringify(decision)}], usage, ...response}; },
    request: () => request,
  };
}
test('surrogate resolves scope/auth runtime, has no tools and carries cancellation without mutating the main session', async () => {
  const rt = runtime(); const ac = new AbortController();
  const result = await evaluateAutoAdvance(rt, ['fixture/*'], config, [answer], ac.signal);
  assert.deepEqual(result, { decision, tokens:36 });
  const [selected, ctx, options] = rt.request();
  assert.equal(selected,model); assert.equal(ctx.tools,undefined);
  assert.equal(options.toolChoice,'none'); assert.equal(options.signal,ac.signal);
  assert.equal(options.reasoning,undefined); assert.ok(options.maxTokens <= 1536);
  assert.match(ctx.systemPrompt,/NOT the human user/); assert.match(ctx.systemPrompt,/prior explicit HUMAN authorization/);
  const input = JSON.parse(ctx.messages[0].content); assert.equal(input.authorizedScope,config.scope);
  assert.equal(input.goal, config.goal);
});
const reasoner = { ...model, reasoning: true, thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: '1024', high: '2048', xhigh: '4096', max: '8192' } };

test('surrogate thinking forwards canonical levels and never reads or mutates primary/backup preferences', async () => {
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const rt = runtime({}, reasoner);
    rt.setModel = rt.setThinkingLevel = () => assert.fail('surrogate may not mutate a session preference');
    Object.defineProperty(rt, 'thinkingLevel', { get: () => assert.fail('surrogate may not inherit session thinking') });
    Object.defineProperty(rt, 'fallbackModel', { get: () => assert.fail('surrogate may not inherit backup thinking') });
    const selected = { ...config, thinkingLevel };
    await evaluateAutoAdvance(rt, undefined, selected, [answer], new AbortController().signal);
    assert.equal(rt.request()[2].reasoning, thinkingLevel === 'off' ? undefined : thinkingLevel);
    assert.equal(selected.thinkingLevel, thinkingLevel, 'provider mapping does not rewrite the canonical preference');
    assert.ok(rt.request()[2].maxTokens <= 1536);
  }
});

test('legacy and explicit auto use the surrogate scope pin or SDK medium default, not the main level', async () => {
  for (const selected of [config, { ...config, thinkingLevel: 'auto' }]) {
    for (const [patterns, expected] of [[undefined, 'medium'], [['fixture/path/model:low'], 'low'], [['fixture/path/model:xhigh'], 'xhigh'], [['fixture/path/model:off'], undefined]]) {
      const rt = runtime({}, reasoner);
      await evaluateAutoAdvance(rt, patterns, selected, [answer], new AbortController().signal);
      assert.equal(rt.request()[2].reasoning, expected);
    }
  }
  const rt = runtime({}, reasoner);
  await evaluateAutoAdvance(rt, ['fixture/path/model:high'], { ...config, thinkingLevel: 'off' }, [answer], new AbortController().signal);
  assert.equal(rt.request()[2].reasoning, undefined, 'explicit off overrides the surrogate scope pin');
});

test('unsupported or malformed explicit surrogate thinking fails before a model request', async () => {
  const limited = { ...reasoner, thinkingLevelMap: { ...reasoner.thinkingLevelMap, high: null, xhigh: null, max: null } };
  for (const thinkingLevel of ['high', 'xhigh', 'max', 'invalid', null, 1]) {
    const rt = runtime({}, limited);
    const selected = { ...config, thinkingLevel };
    await assert.rejects(evaluateAutoAdvance(rt, undefined, selected, [answer], new AbortController().signal), /thinking level/i);
    assert.equal(rt.request(), undefined);
  }
  const noReasoning = runtime();
  await assert.rejects(resolveAutoAdvanceModel(noReasoning, undefined, { ...config, thinkingLevel: 'low' }), /not supported/);
  assert.equal(noReasoning.request(), undefined);
  await evaluateAutoAdvance(noReasoning, undefined, { ...config, thinkingLevel: 'off' }, [answer], new AbortController().signal);
  assert.equal(noReasoning.request()[2].reasoning, undefined);
});

test('reasoning statistics count once, without any total-budget admission gate', async () => {
  const rt = runtime({ usage: { input: 5, output: 800, reasoning: 700, cacheRead: 50, cacheWrite: 0, totalTokens: 855 } }, reasoner);
  const selected = { ...config, thinkingLevel: 'high' };
  const result = await evaluateAutoAdvance(rt, undefined, selected, [answer], new AbortController().signal);
  assert.equal(result.tokens, 855);
  const large = runtime({ usage: { input: 1000000, output: 2000000 } }, reasoner);
  const bigConfig = { ...selected, goal: 'g'.repeat(4000), scope: 's'.repeat(2000), tokenBudget: 1 };
  const largeResult = await evaluateAutoAdvance(large, undefined, bigConfig, [answer, ...Array.from({length: 10}, () => ({role: 'toolResult', content: 'e'.repeat(4000)}))], new AbortController().signal);
  assert.equal(largeResult.tokens, 3000000);
  assert.equal(large.request()[2].maxTokens, 1536, 'concise decision output is independent of conversation consumption');
});

test('missing/out-of-scope and virtual surrogate models fail closed', async () => {
  const rt=runtime();
  await assert.rejects(resolveAutoAdvanceModel(rt,['fixture/*'],{...config,model:{provider:'missing',modelId:'x'}}),/unavailable/);
  rt.getPhysicalModel=()=>undefined;
  await assert.rejects(resolveAutoAdvanceModel(rt,undefined,config),/physical/);
});
test('abort, terminal errors and tool calls still reject automatic continuation', async () => {
  const signal=new AbortController().signal;
  for (const response of [{stopReason:'error',errorMessage:'quota'}, {stopReason:'length'}, {content:[{type:'toolCall',name:'write'}]}]) {
    await assert.rejects(evaluateAutoAdvance(runtime(response),undefined,config,[answer],signal));
  }
  const ac=new AbortController();ac.abort();
  const rt=runtime(); await assert.rejects(evaluateAutoAdvance(rt,undefined,config,[answer],ac.signal)); assert.equal(rt.request(),undefined);
  for (const stopReason of ['error','length','aborted','deferred']) await assert.rejects(evaluateAutoAdvance(runtime(),undefined,config,[{...answer,stopReason}],signal));
  await assert.rejects(evaluateAutoAdvance(runtime(),undefined,config,[],signal));
  const tooSmall = runtime({}, {...model, maxTokens: 128});
  await assert.rejects(evaluateAutoAdvance(tooSmall,undefined,config,[answer],signal),/output capacity/);
  assert.equal(tooSmall.request(),undefined);
});
test('unavailable or invalid usage is reported as partial statistics without losing a valid decision', async () => {
  for (const usage of [undefined, {input: -1, output: 2}, {input: 2}, {input: 1, output: NaN}, {input: 2, output: 1, cacheRead: 'bad'}]) {
    const result = await evaluateAutoAdvance(runtime({usage}),undefined,config,[answer],new AbortController().signal);
    assert.deepEqual(result, {decision, tokens: undefined});
  }
});
test('bounded evidence omits images/thinking/tool input/system instructions and marks surrogate provenance', () => {
  const messages=[{role:'system',content:'secret system'}, {role:'user',content:'task'}, {role:'assistant',content:[{type:'thinking',thinking:'secret thought'},{type:'toolCall',arguments:{apiKey:'secret'}},{type:'image',data:'base64'},{type:'text',text:'actual result'}]}, {role:'custom',customType:'pi-web:auto-advance',content:'AI suggestion'}, ...Array.from({length:100},(_,i)=>({role:'toolResult',content:[{type:'text',text:`result${i} ${'x'.repeat(4000)}`}]}))];
  const excerpt=autoAdvanceTranscript(messages); assert.ok(excerpt.length < 13000); assert.match(excerpt,/result99/);assert.doesNotMatch(excerpt,/secret|base64|apiKey/);
  assert.match(autoAdvanceTranscript(messages.slice(0,4)),/custom:pi-web:auto-advance \(NOT human\)/);
  const instruction=autoAdvanceInstruction(config,'verify',2);assert.match(instruction,/NOT A HUMAN MESSAGE/);assert.match(instruction,/not new user approval/);assert.match(instruction,/2\/3/);
});
test('usage includes cached input without double counting reasoning; invalid usage rejects', () => {
  assert.equal(autoAdvanceUsageTokens({...usage, reasoning:99}),36);
  assert.equal(autoAdvanceUsageTokens({...usage,totalTokens:40}),40);
  for (const invalid of [undefined,{...usage,input:-1},{...usage,output:NaN},{cacheWrite:1}]) assert.throws(()=>autoAdvanceUsageTokens(invalid));
  // Absent cache counters are zero, not untrustworthy evidence.
  assert.equal(autoAdvanceUsageTokens({input:3,output:4}),7);
  assert.equal(autoAdvanceUsageTokens({input:0,output:0,cacheRead:0,cacheWrite:0}),0);
});
