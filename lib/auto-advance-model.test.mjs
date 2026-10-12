import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { evaluateAutoAdvance, autoAdvanceTranscript, autoAdvanceInstruction, autoAdvanceUsageTokens, resolveAutoAdvanceModel } = await jiti.import('./auto-advance-model.ts');
const model = { provider: 'fixture', id: 'path/model', name: 'Fixture', contextWindow: 32768, maxTokens: 4096 };
const config = { goal: 'verify tests pass', scope: 'read and run local non-destructive tests; no publish', model: {provider: model.provider, modelId: model.id}, maxRounds: 3, maxMinutes: 10, tokenBudget: 20000 };
const usage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 36 };
const answer = { role: 'assistant', content: [{type: 'text', text: 'Tests pending'}], stopReason: 'stop' };
const decision = {decision:'continue', reason:'Need actual tests', nextPrompt:'Run the targeted tests', requiresConfirmation:false};
function runtime(response = {}) {
  let request;
  return { getAvailable: async () => [model], getPhysicalModel: () => model,
    completeSimple: async (...args) => { request = args; return {stopReason:'stop', content:[{type:'text',text:JSON.stringify(decision)}], usage, ...response}; },
    request: () => request,
  };
}
test('surrogate resolves scope/auth runtime, has no tools and carries cancellation without mutating the main session', async () => {
  const rt = runtime(); const ac = new AbortController();
  const result = await evaluateAutoAdvance(rt, ['fixture/*'], config, [answer], ac.signal, 20000);
  assert.deepEqual(result, { decision, tokens:36 });
  const [selected, ctx, options] = rt.request();
  assert.equal(selected,model); assert.equal(ctx.tools,undefined);
  assert.equal(options.toolChoice,'none'); assert.equal(options.signal,ac.signal);
  assert.equal(options.reasoning,undefined); assert.ok(options.maxTokens <= 1536);
  assert.match(ctx.systemPrompt,/NOT the human user/); assert.match(ctx.systemPrompt,/prior explicit HUMAN authorization/);
  const input = JSON.parse(ctx.messages[0].content); assert.equal(input.authorizedScope,config.scope);
  assert.equal(input.goal, config.goal);
});
test('missing/out-of-scope and virtual surrogate models fail closed', async () => {
  const rt=runtime();
  await assert.rejects(resolveAutoAdvanceModel(rt,['fixture/*'],{...config,model:{provider:'missing',modelId:'x'}}),/unavailable/);
  rt.getPhysicalModel=()=>undefined;
  await assert.rejects(resolveAutoAdvanceModel(rt,undefined,config),/physical/);
});
test('abort, terminal errors, tool calls and missing usage cannot submit automatic continuation', async () => {
  const signal=new AbortController().signal;
  for (const response of [{stopReason:'error',errorMessage:'quota'}, {stopReason:'length'}, {content:[{type:'toolCall',name:'write'}]}, {usage:undefined}]) {
    await assert.rejects(evaluateAutoAdvance(runtime(response),undefined,config,[answer],signal,20000));
  }
  const ac=new AbortController();ac.abort();
  const rt=runtime(); await assert.rejects(evaluateAutoAdvance(rt,undefined,config,[answer],ac.signal,20000)); assert.equal(rt.request(),undefined);
  for (const stopReason of ['error','length','aborted','deferred']) await assert.rejects(evaluateAutoAdvance(runtime(),undefined,config,[{...answer,stopReason}],signal,20000));
  await assert.rejects(evaluateAutoAdvance(runtime(),undefined,config,[],signal,20000));
  await assert.rejects(evaluateAutoAdvance(runtime(),undefined,config,[answer],signal,100),/budget/);
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
