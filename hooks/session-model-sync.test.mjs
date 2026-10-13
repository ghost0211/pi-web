import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { parseFallbackModel, parseModelFallbackNotice } = await jiti.import('../lib/model-fallback.ts');
const { normalizeThinkingLevelOption } = await jiti.import('../lib/thinking-level-options.ts');
const text = await readFile(new URL('./useAgentSession.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('hook.ts', text, ts.ScriptTarget.Latest, true);
const nodes = [];
(function visit(node) { nodes.push(node); ts.forEachChild(node, visit); })(source);
function callback(name) {
  const node = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === name);
  assert.ok(node, name);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, {compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText);
}
const gpt = {provider:'fixture',modelId:'gpt-sol',thinkingLevel:'xhigh'};
const deepseek = {provider:'fixture',modelId:'deepseek',thinkingLevel:'low'};
function fixture() {
  const writes = {models:[],levels:[],runtime:[],usage:[],notices:[]}, requests=[];
  const context = createContext({
    parseFallbackModel, parseModelFallbackNotice, normalizeThinkingLevelOption, AbortController, setTimeout, clearTimeout,
    parseRuntimeModel: v => v?.provider && v?.id ? {provider:v.provider,modelId:v.id} : null,
    modelSwitchPendingRef:{current:false}, fallbackChangePendingRef:{current:false},
    contextUsageRequestIdRef:{current:0}, contextUsageAppliedIdRef:{current:0}, modelMetadataAppliedIdRef:{current:0},
    sessionHookMountedRef:{current:true}, sessionIdRef:{current:'a'}, promptRunIdRef:{current:1}, agentRunningRef:{current:false},
    modelThinkingLevelsRef:{current:{}}, modelThinkingLevelPinsRef:{current:{}}, displayModelRef:{current:gpt}, contextModelRef:{current:gpt}, modelListRef:{current:[]},
    fallbackPreferenceInitializedRef:{current:false}, fallbackSelectionKnownRef:{current:false}, fallbackModelRef:{current:null},
    fallbackNoticeAnnouncementRef:{current:{initialized:false,fingerprint:null}}, fallbackNoticeTimestampRef:{current:-1}, fallbackNoticeFingerprintRef:{current:null},
    autoAdvanceSuppressCompletionRef:{current:false}, applyAutoAdvanceState(){},
    setCurrentModelOverride: v => {writes.models.push(v);context.displayModelRef.current=v},
    setThinkingLevel:v=>writes.levels.push(v), setRuntimeModel:v=>writes.runtime.push(v), setContextUsage:v=>writes.usage.push(v), setFallbackModelState(){},
    dispatchNotice:v=>writes.notices.push(v),createNoticeId:()=> 'notice',t:k=>k,
    fetch: (url,options)=>{const request=Promise.withResolvers();requests.push({...request,url,options});return request.promise},
  });
  for(const name of ['applyPrimaryThinkingLevel','applyPrimaryModelSelection','applyRuntimeModel','applyFallbackModelSelection','applyFallbackNotice','applyAgentStateMetadata','applyContextUsage','syncSessionModel','refreshContextUsage','invalidateModelReads']) context[name]=callback(name).runInContext(context);
  const reply=(index,data,status=200)=>requests[index].resolve(Response.json(data,{status}));
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {context,writes,requests,reply,flush};
}
const state=(model=deepseek)=>({state:{primaryModel:model,model:{provider:model.provider,id:model.modelId},thinkingLevel:model.thinkingLevel}});
test('an idle authoritative snapshot replaces an old selected model without an SSE connection',async()=>{
  const f=fixture();const pending=f.context.syncSessionModel('a');f.reply(0,state());await pending;
  assert.equal(f.writes.models.at(-1).modelId,deepseek.modelId);assert.deepEqual(f.writes.levels,['low']);
  assert.equal(f.requests.length,1);assert.deepEqual(f.writes.notices,[]);
});
test('dormant sessions use a one-entry deferred disk snapshot, never start a wrapper or rewrite UI history',async()=>{
  const f=fixture();const pending=f.context.syncSessionModel('a');f.reply(0,{running:false});await f.flush();
  assert.match(f.requests[1].url,/\/api\/sessions\/a\?tail=1&deferThinking=1&deferMedia=1/);
  f.reply(1,{primaryModel:deepseek,context:{model:deepseek,thinkingLevel:'low',messages:[{role:'assistant',model:'historical-gpt'}]}});await pending;
  assert.equal(f.writes.models.at(-1).modelId,deepseek.modelId);assert.ok(f.requests.every(r=>r.url.startsWith('/api/')));
});
test('idle polling never repeatedly downloads dormant history or tree snapshots',async()=>{
  const f=fixture();const pending=f.context.syncSessionModel('a',false);f.reply(0,{running:false});await pending;
  assert.equal(f.requests.length,1);assert.deepEqual(f.writes.models,[]);
});
test('a stalled mobile read times out without mutations and a later read can recover',async()=>{
  const f=fixture();let timeout,cleared=0;
  f.context.setTimeout=(fn,ms)=>{assert.equal(ms,5000);timeout=fn;return 1};f.context.clearTimeout=()=>cleared++;
  const pending=f.context.syncSessionModel('a');
  f.requests[0].options.signal.addEventListener('abort',()=>f.requests[0].reject(new Error('timeout')));
  timeout();await pending;assert.deepEqual(f.writes.models,[]);assert.equal(cleared,1);
  const retry=f.context.syncSessionModel('a');f.reply(1,state(deepseek));await retry;assert.equal(f.writes.models.at(-1).modelId,deepseek.modelId);assert.equal(cleared,2);
});
test('a newer model-only snapshot beats a delayed old reply even if neither has usage',async()=>{
  const f=fixture();const old=f.context.syncSessionModel('a'),latest=f.context.syncSessionModel('a');
  f.reply(1,state(deepseek));await latest;f.reply(0,state(gpt));await old;
  assert.deepEqual(f.writes.models,[deepseek]);assert.equal(f.context.modelMetadataAppliedIdRef.current,2);assert.equal(f.context.contextUsageAppliedIdRef.current,0);
});
test('failed or empty newer reads do not suppress an older valid model snapshot',async()=>{
  for(const newer of [{status:503,data:{error:'offline'}},{status:200,data:{state:{}}}]){
    const f=fixture();const old=f.context.syncSessionModel('a'),latest=f.context.syncSessionModel('a');
    f.reply(1,newer.data,newer.status);await latest;f.reply(0,state(deepseek));await old;
    assert.equal(f.writes.models.at(-1).modelId,deepseek.modelId);
  }
});
test('manual switches invalidate both pre-switch reads and reads started while optimistic controls were locked',async()=>{
  const f=fixture();const old=f.context.syncSessionModel('a');f.context.invalidateModelReads();
  f.reply(0,state(gpt));await old;assert.deepEqual(f.writes.models,[]);
  f.context.modelSwitchPendingRef.current=true;await f.context.syncSessionModel('a');assert.equal(f.requests.length,1);
  const during=f.context.refreshContextUsage('a');f.context.invalidateModelReads();f.context.modelSwitchPendingRef.current=false;
  f.reply(1,state(gpt));await during;assert.deepEqual(f.writes.models,[]);
  const fresh=f.context.syncSessionModel('a');f.reply(2,state(deepseek));await fresh;assert.equal(f.writes.models.at(-1).modelId,deepseek.modelId);
});
test('model metadata from old runs, another session, pending selection or unmount cannot update controls',async()=>{
  for(const invalidate of [c=>c.promptRunIdRef.current++,c=>c.sessionIdRef.current='b',c=>c.sessionHookMountedRef.current=false,c=>c.modelSwitchPendingRef.current=true]){
    const f=fixture();const pending=f.context.syncSessionModel('a');invalidate(f.context);f.reply(0,state(deepseek));await pending;assert.deepEqual(f.writes.models,[]);
  }
});
test('assistant usage refreshes also calibrate the configured model, not just the context ring',async()=>{
  const f=fixture();const pending=f.context.refreshContextUsage('a');f.reply(0,state());await pending;
  assert.equal(f.writes.models.at(-1).modelId,deepseek.modelId);
});
test('quota backup execution never becomes a primary choice or replaces independent primary thinking',async()=>{
  const f=fixture();const pending=f.context.syncSessionModel('a');
  f.reply(0,{state:{primaryModel:gpt,model:{provider:deepseek.provider,id:deepseek.modelId},thinkingLevel:'low',fallbackModel:deepseek}});await pending;
  assert.deepEqual(f.writes.models,[gpt]);assert.deepEqual(f.writes.levels,['xhigh']);assert.equal(f.writes.runtime.at(-1).modelId,deepseek.modelId);
});
test('idle wake-up and visible polling synchronize models without holding an EventSource open',async()=>{
  const node=nodes.find(n=>ts.isCallExpression(n)&&n.expression.getText(source)==='useEffect'&&n.arguments[0]?.getText(source).includes('let idleReadPending'));
  assert.ok(node);const effect=new Script(ts.transpileModule(`(${node.arguments[0].getText(source)})`,{compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText);
  const calls=[],listeners=new Map(),timers=[];
  const context=createContext({agentRunning:false,agentRunningRef:{current:false},sessionIdRef:{current:'a'},bashRunningRef:{current:false},
    document:{visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:()=>{}},
    window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:()=>{}},
    eventConnectionRef:{current:{refresh:()=>{throw Error('idle wake-up must not reconnect SSE')}}},
    syncSessionModel:async sid=>calls.push(sid),loadSession:()=>{throw Error('idle wake-up must preserve visible history')},reconcileAgentState:()=>{},
    setInterval:(fn,ms)=>{timers.push({fn,ms});return 1},clearInterval(){},AGENT_STATE_RECONCILE_MS:15000,
  });
  const cleanup=effect.runInContext(context)();
  for(const name of ['visibilitychange','online','pageshow'])listeners.get(name)();
  await timers[0].fn();assert.deepEqual(calls,['a','a','a','a']);assert.equal(timers[0].ms,15000);
  context.document.visibilityState='hidden';listeners.get('visibilitychange')();await timers[0].fn();assert.equal(calls.length,4);cleanup();
});
test('all asynchronous model-metadata application paths carry a read watermark',()=>{
  const calls=nodes.filter(n=>ts.isCallExpression(n)&&n.expression.getText(source)==='applyAgentStateMetadata');
  assert.ok(calls.length>=8);
  assert.ok(calls.every(n=>n.arguments.length===3), 'system/tools panels, SSE grace and auto-advance reads must not bypass ordering guards');
});
test('existing prompt dispatch triggers observation without replaying set_model or delaying submission',()=>{
  const send=text.slice(text.indexOf('const handleSend = useCallback'),text.indexOf('const executeBash = useCallback'));
  assert.match(send,/else if \(session\) \{[\s\S]*?void syncSessionModel\(session.id\);[\s\S]*?type: "prompt"/);
  assert.doesNotMatch(send.slice(send.indexOf('} else if (session)')),/type: "set_model"/);
});
