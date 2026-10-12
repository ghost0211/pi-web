import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
const {beginSessionDeletion}=await jiti.import('./session-deletion-guard.ts');
const {applySessionManagementAction}=await jiti.import('./session-management-store.ts');
const {PATCH}=await jiti.import('../app/api/session-management/route.ts');
const {POST}=await jiti.import('../app/api/agent/[id]/route.ts');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await sleep(5);}throw new Error('Timed out waiting for fixture');};
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const usage={input:30,output:20,cacheRead:0,cacheWrite:0,totalTokens:50};
const surrogate={provider:'fixture',id:'surrogate/model',contextWindow:32000,maxTokens:4096};
const config={goal:'Implement and verify a bounded local change',scope:'Local edits and tests only, no commit/release/delete',model:{provider:surrogate.provider,modelId:surrogate.id},maxRounds:3,maxMinutes:10,tokenBudget:20000};
const decision=(action='continue',nextPrompt='Verify the local tests')=>({decision:action,reason:'Use test evidence',nextPrompt,requiresConfirmation:false});
function response(value=decision()){return {role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(value)}],usage};}
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'pi-web-auto-advance-rpc-'));const prevDir=process.env.PI_CODING_AGENT_DIR,prevTimeout=process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;
 process.env.PI_CODING_AGENT_DIR=dir;process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS='0';
 const sm=SessionManager.inMemory();sm.appendMessage({role:'user',content:'Do the local task',timestamp:Date.now()});
 sm.appendMessage({role:'assistant',content:[{type:'text',text:'Implementation needs verification'}],stopReason:'stop',usage,timestamp:Date.now()});
 let listener=()=>{},streaming=false;let run=null;let autoFinish=options.autoFinish??true;let evaluations=0,aborts=0,prompts=0;const requests=[],custom=[],events=[];let completions=0;
 let evaluate=async()=>response(evaluations===1?decision():decision('complete'));
 const rt={getAvailable:async()=>[surrogate],getPhysicalModel:()=>surrogate,completeSimple:async(...args)=>{evaluations++;requests.push(args);return evaluate(...args);}};
 const inner={sessionId:sm.getSessionId(),sessionManager:sm,sessionFile:undefined,
 get isStreaming(){return streaming;},isCompacting:false,isBashRunning:false,model:{provider:'fixture',id:'main'},agent:{state:{thinkingLevel:'high'}},modelRuntime:rt,settingsManager:{getEnabledModels:()=>undefined,getDefaultTools:()=>[]},extensionRunner:{},get messages(){return sm.buildSessionContext().messages;},
 getContextUsage:()=>undefined,getSteeringMessages:()=>[],getFollowUpMessages:()=>[],getActiveToolNames:()=>[],getAllTools:()=>[],setActiveToolsByName:()=>{},
 subscribe:cb=>{listener=cb;return()=>{listener=()=>{};};},dispose(){},
 prompt(text,opts){prompts++;opts.preflightResult?.('started');return startRun({role:'user',content:text});},
 sendCustomMessage(message,opts){assert.equal(opts.triggerTurn,true);custom.push(message);return startRun({role:'custom',...message});},
 abort:async()=>{aborts++;if(run)await finish(true);},
 };
 function startRun(message){streaming=true;listener({type:'agent_start'});if(message.role==='custom')sm.appendCustomMessageEntry(message.customType,message.content,message.display,message.details);else sm.appendMessage({...message,timestamp:Date.now()});run=deferred();const promise=run.promise;if(autoFinish)setTimeout(()=>void finish(),2);return promise;}
 async function finish(aborted=false,{resolve=true,settled=true}={}){const pending=run;if(!pending)return;const msg={role:'assistant',content:[{type:'text',text:aborted?'Stopped':'Tests passed'}],stopReason:aborted?'aborted':'stop',usage,timestamp:Date.now()};sm.appendMessage(msg);listener({type:'message_end',message:msg});streaming=false;listener({type:'agent_end'});if(settled)listener({type:'agent_settled',aborted});if(resolve){run=null;pending.resolve();}await sleep(0);}
 const wrapper=new AgentSessionWrapper(inner,{onAgentRunComplete:()=>{completions++;},...options.wrapperOptions});wrapper.onEvent(e=>events.push(e));wrapper.start();
 t.after(async()=>{wrapper.destroy();if(prevDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prevDir;if(prevTimeout===undefined)delete process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;else process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS=prevTimeout;await rm(dir,{recursive:true,force:true});});
 return {sm,inner,wrapper,rt,requests,custom,events,finish,emit:e=>listener(e),evaluate:fn=>{evaluate=fn;},setAutoFinish:v=>{autoFinish=v;},resolveRun:()=>{const p=run;run=null;p?.resolve();},get evaluations(){return evaluations;},get aborts(){return aborts;},get prompts(){return prompts;},get completions(){return completions;},state:async()=>(await wrapper.send({type:'get_state'})).autoAdvance};
}
test('surrogate is tool-less, continuation has explicit custom provenance and exact timing; only one completion',async t=>{
 const f=await fixture(t);const main=f.inner.model;await f.wrapper.send({type:'start_auto_advance',config});
 await until(()=>f.events.some(e=>e.type==='auto_advance_finished'));
 const state=await f.state();assert.equal(state.phase,'completed');assert.equal(state.round,1);assert.equal(state.tokensUsed,150);
 assert.equal(f.custom.length,1);assert.equal(f.prompts,0);assert.match(f.custom[0].content,/NOT A HUMAN MESSAGE/);assert.match(f.custom[0].content,/not new user approval/);
 assert.equal(f.custom[0].customType,'pi-web:auto-advance');assert.equal(f.custom[0].details.model.modelId,config.model.modelId);
 assert.equal(f.inner.model,main);assert.equal(f.inner.agent.state.thinkingLevel,'high');assert.equal(f.wrapper.getFallbackModel(),null);
 assert.equal(f.requests[0][1].tools,undefined);assert.equal(f.requests[0][2].toolChoice,'none');assert.ok(f.requests[0][2].signal instanceof AbortSignal);
 assert.equal(f.completions,1);assert.equal(f.events.filter(e=>e.type==='auto_advance_finished').length,1);
 assert.ok(f.events.filter(e=>e.type==='agent_settled').every(e=>e.suppressCompletionNotification===true));
 const timing=f.sm.getEntries().filter(e=>e.customType==='pi-web:run-timing');assert.equal(timing.length,1);assert.ok(timing[0].data.durationMs>=0);
 assert.equal(f.sm.getEntries().filter(e=>e.type==='message'&&e.message.role==='user').length,1,'no impersonated human prompt');
 assert.equal(f.wrapper.isRunning(),false);
});
test('arming during an existing RPC prompt waits for its full promise, not agent_end or settled alone',async t=>{
 const f=await fixture(t,{autoFinish:false});await f.wrapper.send({type:'prompt',message:'Initial work'});
 await f.wrapper.send({type:'start_auto_advance',config});await sleep(15);assert.equal(f.evaluations,0);
 await f.finish(false,{resolve:false});await sleep(20);assert.equal(f.evaluations,0,'pending RPC finish still blocks');
 f.evaluate(async()=>response(decision('complete')));f.resolveRun();await until(()=>f.events.some(e=>e.type==='auto_advance_finished'));
 assert.equal(f.evaluations,1);assert.equal(f.custom.length,0);assert.equal(f.completions,1);
 assert.ok(f.events.find(e=>e.type==='prompt_done')?.suppressCompletionNotification);
});
test('stop and manual prompt discard a late non-cooperative surrogate response',async t=>{
 for(const type of ['stop_auto_advance','prompt']){
  const f=await fixture(t);const pending=deferred();f.evaluate(()=>pending.promise);
  await f.wrapper.send({type:'start_auto_advance',config});await until(()=>f.evaluations===1);
  const signal=f.requests[0][2].signal;await f.wrapper.send({type,message:'Human takeover'});assert.equal(signal.aborted,true);
  pending.resolve(response());await sleep(25);assert.equal(f.custom.length,0);assert.ok(['stopped','paused'].includes((await f.state()).phase));
 }
});
test('stop aborts only the controller-owned main run; manual takeover/archival preserve it',async t=>{
 for(const reason of ['manual_takeover','archived','user_stop']){
  const f=await fixture(t,{autoFinish:false});await f.wrapper.send({type:'start_auto_advance',config});await until(()=>f.custom.length===1);
  if(reason==='user_stop')await f.wrapper.send({type:'stop_auto_advance'});else f.wrapper.pauseAutoAdvance(reason);
  await sleep(10);assert.equal(f.aborts,reason==='user_stop'?1:0);
  if(reason!=='user_stop'){assert.equal(f.inner.isStreaming,true);await f.finish();}
  assert.equal((await f.state()).reason,reason);assert.equal(f.custom.length,1);
 }
});
test('extension confirm pauses advancement and keeps its existing user dialog alive',async t=>{
 const f=await fixture(t,{autoFinish:false});await f.wrapper.send({type:'start_auto_advance',config});await until(()=>f.custom.length===1);
 const confirm=f.wrapper['createExtensionUiContext']().confirm('Approve?','Needs a real person');
 assert.equal((await f.state()).reason,'extension_ui');assert.equal(f.aborts,0);assert.equal(f.inner.isStreaming,true);
 const event=f.events.find(e=>e.type==='extension_ui_request'&&e.method==='confirm');assert.ok(event);
 await f.wrapper.send({type:'extension_ui_response',id:event.id,confirmed:false});assert.equal(await confirm,false);
 await f.finish();assert.equal(f.custom.length,1);
});
test('archive API pauses the live controller; archived sessions are refused by the agent route',async t=>{
 const f=await fixture(t);const pending=deferred();f.evaluate(()=>pending.promise);await f.wrapper.send({type:'start_auto_advance',config});await until(()=>f.evaluations===1);
 const old=globalThis.__piSessions;globalThis.__piSessions=new Map([[f.inner.sessionId,f.wrapper]]);t.after(()=>{globalThis.__piSessions=old;});
 const res=await PATCH(new Request('http://localhost/api/session-management',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'sessions',ids:[f.inner.sessionId],status:'archived'})}));assert.equal(res.status,200);
 assert.equal((await f.state()).reason,'archived');pending.resolve(response());await sleep(10);assert.equal(f.custom.length,0);
 const blocked=await POST(new Request('http://localhost/api/agent/'+f.inner.sessionId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'start_auto_advance',config,requireLiveSession:true})}),{params:Promise.resolve({id:f.inner.sessionId})});
 assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/archived/);
 await applySessionManagementAction({type:'sessions',ids:[f.inner.sessionId],status:'active'});
 const observer=await fixture(t,{wrapperOptions:{suppressCompletionNotifications:true}});await assert.rejects(observer.wrapper.send({type:'start_auto_advance',config}),/observational/);
 f.sm.appendCustomEntry('pi-web:subagent',{version:1,parentSessionId:'parent',parentSessionPath:'parent.jsonl'});
 await assert.rejects(f.wrapper.send({type:'start_auto_advance',config}),/subagent/);
});
test('delete barrier guards start and automated continuation; destroy drops late surrogate results',async t=>{
 const f=await fixture(t);const barrier=beginSessionDeletion([f.inner.sessionId]);await assert.rejects(f.wrapper.send({type:'start_auto_advance',config}),/deleted/);barrier.release();
 const pending=deferred();f.evaluate(()=>pending.promise);await f.wrapper.send({type:'start_auto_advance',config});await until(()=>f.evaluations===1);
 const barrier2=beginSessionDeletion([f.inner.sessionId]);pending.resolve(response());await until(()=>f.events.some(e=>e.type==='auto_advance_finished'));barrier2.release();assert.equal(f.custom.length,0);
 const other=await fixture(t);const p=deferred();other.evaluate(()=>p.promise);await other.wrapper.send({type:'start_auto_advance',config});await until(()=>other.evaluations===1);other.wrapper.destroy();p.resolve(response());await sleep(20);assert.equal(other.custom.length,0);assert.equal(other.completions,0);
});
test('stop while model resolution is pending invalidates startup instead of rearming later',async t=>{
 const f=await fixture(t);const catalog=deferred();f.rt.getAvailable=()=>catalog.promise;
 const start=f.wrapper.send({type:'start_auto_advance',config});await sleep(5);await f.wrapper.send({type:'stop_auto_advance'});catalog.resolve([surrogate]);
 await assert.rejects(start,/operation changed/);assert.equal(await f.state(),null);assert.equal(f.evaluations,0);
});
