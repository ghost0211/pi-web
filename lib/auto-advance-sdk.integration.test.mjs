import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,DefaultResourceLoader,SettingsManager,SessionManager,createAgentSession} from '@earendil-works/pi-coding-agent';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createJiti} from 'jiti';
const {AgentSessionWrapper}=await createJiti(import.meta.url,{tsconfigPaths:true}).import('./rpc-manager.ts');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
test('real SDK custom continuation persists provenance/timing, uses no network and reopening cannot rearm it',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pi-auto-advance-sdk-'));const oldDir=process.env.PI_CODING_AGENT_DIR,oldTimeout=process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;
 process.env.PI_CODING_AGENT_DIR=root;process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS='0';
 t.after(async()=>{if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;if(oldTimeout===undefined)delete process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;else process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS=oldTimeout;await rm(root,{recursive:true,force:true});});
 const runtime=await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:null,modelsStorePath:join(root,'model-store.json'),refreshOnCreate:false});
 runtime.registerProvider('advance-fixture',{api:'openai-completions',baseUrl:'https://fixture.invalid',apiKey:'fixture-not-real',models:['main','surrogate'].map(id=>({id,name:id,reasoning:false,input:['text'],contextWindow:50000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))});
 const main=runtime.getModel('advance-fixture','main');const surrogate=runtime.getModel('advance-fixture','surrogate');assert.ok(main&&surrogate);
 runtime.getAvailable=async()=>[main,surrogate];
 let evaluations=0;const proxyContexts=[];
 runtime.completeSimple=async(model,context,options)=>{evaluations++;assert.equal(model,surrogate);assert.equal(context.tools,undefined);assert.ok(options.signal instanceof AbortSignal);proxyContexts.push(context);return {role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',usage,content:[{type:'text',text:JSON.stringify(evaluations===1?{decision:'continue',nextPrompt:'Verify the local result once',requiresConfirmation:false,reason:'Need actual verification'}:{decision:'complete',requiresConfirmation:false,reason:'Verification returned a result'})}]};};
 const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});const manager=SessionManager.create(root,root);
 const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await loader.reload();
 const {session}=await createAgentSession({cwd:root,agentDir:root,sessionManager:manager,settingsManager:settings,modelRuntime:runtime,model:main,thinkingLevel:'off',resourceLoader:loader,noTools:true});
 const modelContexts=[];let requests=0;
 session.agent.streamFunction=(model,context)=>{requests++;modelContexts.push(context);assert.equal(model,main);const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:requests===1?'Need verification':'Verified local result'}],stopReason:'stop',usage};const stream=new AssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;};
 let completions=0;const wrapper=new AgentSessionWrapper(session,{onAgentRunComplete:()=>{completions++;}});wrapper.start();t.after(()=>wrapper.destroy());
 await session.prompt('Work on the bounded local task');assert.equal(requests,1);completions=0;
 const config={goal:'Verify the local result',scope:'Local verification only; no destructive commands or publication',model:{provider:'advance-fixture',modelId:'surrogate'},maxRounds:3,maxMinutes:10,tokenBudget:20000};
 await wrapper.send({type:'start_auto_advance',config});let state;
 for(let i=0;i<200;i++){state=(await wrapper.send({type:'get_state'})).autoAdvance;if(state?.phase==='completed')break;await sleep(5);}
 assert.equal(state.phase,'completed');assert.equal(requests,2);assert.equal(evaluations,2);assert.equal(completions,1);assert.equal(session.model,main);assert.equal(session.thinkingLevel,'off');
 const custom=manager.getEntries().filter(e=>e.type==='custom_message'&&e.customType==='pi-web:auto-advance');assert.equal(custom.length,1);assert.equal(custom[0].details.round,1);assert.match(custom[0].content,/NOT A HUMAN MESSAGE/);
 const userEntries=manager.getEntries().filter(e=>e.type==='message'&&e.message.role==='user');assert.equal(userEntries.length,1);
 const timings=manager.getEntries().filter(e=>e.type==='custom'&&e.customType==='pi-web:run-timing');assert.equal(timings.length,2);assert.notEqual(timings[0].data.runId,timings[1].data.runId);
 assert.match(JSON.stringify(modelContexts.at(-1)),/not new user approval/);assert.doesNotMatch(JSON.stringify(modelContexts),/pi-web:run-timing|finalAssistantEntryId/);
 assert.equal(proxyContexts.length,2);
 const reopened=SessionManager.open(manager.getSessionFile());assert.equal(reopened.getEntries().filter(e=>e.customType==='pi-web:auto-advance').length,1);
 assert.equal(reopened.getEntries().filter(e=>e.customType==='pi-web:run-timing').length,2);
 // No activation record is saved; a fresh wrapper starts disarmed.
 const observer=new AgentSessionWrapper({...session,sessionId:reopened.getSessionId(),sessionManager:reopened,agent:session.agent,getContextUsage:()=>undefined,getSteeringMessages:()=>[],getFollowUpMessages:()=>[]});
 assert.equal((await observer.send({type:'get_state'})).autoAdvance,null);
 // Do not dispose the same SDK instance twice; observer was never started.
 observer['autoAdvance'].destroy();observer['runTimingRuntime'].destroy();
});
