import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
const loader = createJiti(import.meta.url);
const { recentDesktopTraySessions, normalizeTrayAction, isTrayMenu, createTrayActionPump, createTrayMenuSink } = await loader.import("./desktop-tray.ts");
const bridge = await loader.import("./desktop.ts");
const messages = await loader.import("./desktop-tray-messages.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const state = { version:1,revision:0,sessions:{archived:{status:"archived",pinned:false}},projects:{removed:{removed:true}},migrationIds:[] };
function session(id, modified, extra={}) { return {id,modified,name:id,cwd:"/isolated-fixture",messageCount:1,firstMessage:"prompt",...extra}; }
function menu(locale="en") { return { locale,labels:{show:"Show",newSession:"New",recentSessions:"Recent",emptyRecent:"None",minimizeOnClose:"Minimize",quit:"Quit"},recentSessions:[{id:"safe-id",title:"Fixture only"}] }; }
function fakeWindow(t, value) { const old=globalThis.window; globalThis.window=value;t.after(()=>{if(old===undefined) delete globalThis.window;else globalThis.window=old;}); }

test("recent menu waits for migration, excludes archives/subagents, keeps forks and limits to three", () => {
  const rows=[session("old","2025-01-01"),session("fork","2026-01-02",{parentSessionId:"old",relation:{kind:"fork"}}),session("new","2026-01-03"),session("removed-project","2026-01-04",{projectKey:"removed"}),session("archived","2027-01-01"),session("child","2028-01-01",{relation:{kind:"subagent"}}),session("https://bad.example","2029-01-01")];
  assert.deepEqual(recentDesktopTraySessions(rows,null),[]);
  assert.deepEqual(recentDesktopTraySessions(rows,state).map(x=>x.id),["removed-project","new","fork"]);
});
test("recent sessions deduplicate IDs and bound Unicode menu titles", () => {
  const rows=[session("one","2026-01-01"),session("one","2026-01-02",{name:"\n"+"你".repeat(100)+"\t\u0000"})];
  const recent=recentDesktopTraySessions(rows,state);assert.equal(recent.length,1);assert.equal(Array.from(recent[0].title).length,80);assert.doesNotMatch(recent[0].title,/[\n\t\u0000]/);
});
test("tray action boundary accepts only explicit types and opaque IDs", () => {
  assert.deepEqual(normalizeTrayAction({type:"new-session"}),{type:"new-session"});
  assert.deepEqual(normalizeTrayAction({type:"open-session",sessionId:"a-b_c.1:2"}),{type:"open-session",sessionId:"a-b_c.1:2"});
  for(const raw of [null,[],{type:"eval",url:"https://bad"},{type:"new-session",sessionId:"extra"},{type:"open-session",sessionId:"../file"},{type:"open-session",sessionId:"."},{type:"open-session",sessionId:".."},{type:"open-session",sessionId:"a".repeat(129)}]) assert.equal(normalizeTrayAction(raw),null);
});
test("menu payloads reject paths, excess items, duplicate IDs and oversized text", () => {
  assert.equal(isTrayMenu(menu()),true);
  for(const raw of [null,{}, {...menu(),recentSessions:[{id:"C:\\file",title:"x"}]},{...menu(),recentSessions:Array(4).fill({id:"a",title:"x"})},{...menu(),recentSessions:Array(2).fill({id:"a",title:"x"})},{...menu(),labels:{...menu().labels,show:"a".repeat(121)}},{...menu(),recentSessions:[{id:"a",title:"你".repeat(81)}]}]) assert.equal(isTrayMenu(raw),false);
});
test("bridge no-ops in browser/old shells and forwards bounded native menu data", async(t) => {
  fakeWindow(t,{});assert.equal(await bridge.syncDesktopTrayMenu(menu()),false);assert.equal(await bridge.takeDesktopTrayAction(),null);
  const calls=[];globalThis.window={__TAURI__:{core:{invoke:async(command,args)=>{calls.push([command,args]);if(command==="take_tray_action")return {type:"open-session",sessionId:"safe-id"};return null;}},event:{listen:async(name,handler)=>{calls.push([name]);handler({payload:{url:"https://ignored"}});return ()=>calls.push(["unlisten"]);}}}};
  assert.equal(await bridge.syncDesktopTrayMenu(menu()),true);assert.deepEqual(calls[0],["sync_tray_menu",{menu:menu()}]);
  assert.deepEqual(await bridge.takeDesktopTrayAction(),{type:"open-session",sessionId:"safe-id"});
  let wakes=0;const stop=await bridge.listenDesktopTrayActions(()=>wakes++);assert.equal(wakes,1);stop();
  const before=calls.length;assert.equal(await bridge.syncDesktopTrayMenu({...menu(),recentSessions:[{id:"../x",title:"x"}]}),false);assert.equal(calls.length,before);
  globalThis.window.__TAURI__.core.invoke=async()=>{throw Error("old shell");};assert.equal(await bridge.syncDesktopTrayMenu(menu()),false);assert.equal(await bridge.takeDesktopTrayAction(),null);
});
test("blocked settings operations retain explicit actions across asynchronous take and remount", async() => {
  let allowed=true,resolve;const handled=[];let takes=0;
  const pump=createTrayActionPump({take:async()=>{takes++;return takes===1?new Promise(r=>resolve=r):null;},canHandle:()=>allowed,handle:async a=>handled.push(a),onError:e=>{throw e;}});
  pump.start();allowed=false;pump.stop();resolve({type:"new-session"});await tick();assert.deepEqual(handled,[]);
  allowed=true;pump.start();await tick();assert.deepEqual(handled,[{type:"new-session"}]);pump.stop();
});
test("actions paused during a slow navigation are retried after the operation guard clears", async()=>{
  let allowed=true,attempts=0,takes=0;const handled=[];
  const pump=createTrayActionPump({take:async()=>++takes===1?{type:"new-session"}:null,canHandle:()=>allowed,handle:async action=>{if(++attempts===1){allowed=false;return false;}handled.push(action);},onError:e=>{throw e;}});
  pump.start();await tick();assert.equal(attempts,1);assert.deepEqual(handled,[]);allowed=true;await pump.resume();assert.equal(attempts,2);assert.deepEqual(handled,[{type:"new-session"}]);pump.stop();
});
test("menu writes are serialized, coalesced to latest language and deduplicated", async()=>{
  let resolve;const calls=[];
  const sink=createTrayMenuSink(async value=>{calls.push(value.locale);if(calls.length===1)await new Promise(r=>resolve=r);return true;});
  const first=sink.update(menu("en"));void sink.update(menu("zh-CN"));void sink.update(menu("zh-TW"));assert.deepEqual(calls,["en"]);resolve();await first;assert.deepEqual(calls,["en","zh-TW"]);await sink.update(menu("zh-TW"));assert.deepEqual(calls,["en","zh-TW"]);
});
test("tray actions do not create notification targets or bypass migration/confirmed-operation guards", async()=>{
  const app=await readFile(new URL("../components/AppShell.tsx",import.meta.url),"utf8"),hook=await readFile(new URL("../hooks/useDesktopTray.ts",import.meta.url),"utf8");
  assert.match(app,/enabled: management\.ready && !settingsOperationBusy && !projectTrustDialogOpen/);
  assert.match(app,/onOperationBusyChange=\{handleSettingsOperationBusyChange\}/);
  assert.match(app,/await management\.refresh\(\)/);
  assert.match(app,/settingsOperationBusyRef\.current \|\| projectTrustDialogOpenRef\.current\) return false/);
  assert.match(app,/handleNewSession\(`tray-/);
  assert.match(app,/navigationToken !== workspaceRestoreTokenRef\.current/);
  assert.match(hook,/options\.localeReady/);
  assert.match(hook,/window\.addEventListener\("focus", wake\)/);
  assert.doesNotMatch(hook,/sendAgentCommand|set_model|takeDesktopNotificationTarget/);
});
test("native tray commands and install-root producer are registered only on loopback",async()=>{
  const source=await readFile(new URL("../src-tauri/src/main.rs",import.meta.url),"utf8");
  const build=await readFile(new URL("../src-tauri/build.rs",import.meta.url),"utf8");
  const capability=JSON.parse(await readFile(new URL("../src-tauri/capabilities/desktop-remote.json",import.meta.url),"utf8"));
  for(const name of ["sync_tray_menu","take_tray_action"]) { assert.ok(build.includes(`"${name}"`)); assert.ok(capability.permissions.includes(`allow-${name.replaceAll("_","-")}`));assert.ok(source.includes(`fn ${name}(`)); }
  assert.deepEqual(capability.remote.urls,["http://127.0.0.1:*","http://localhost:*"]);
  assert.match(source,/\.env\("PI_WEB_DESKTOP_INSTALL_DIR", &installation_dir\)/);
  assert.match(source,/std::env::current_exe\(\)/);
  assert.match(source,/app\.emit\(TRAY_ACTION_EVENT, \(\)\)/);
  assert.match(source,/write_settings_atomic/);
});

test("all tray dictionaries have matching keys for English and both Chinese locales",()=>{
  const all=[messages.desktopTrayMessagesEn,messages.desktopTrayMessagesZhCN,messages.desktopTrayMessagesZhTW];
  assert.deepEqual(Object.keys(all[0]).sort(),Object.keys(all[1]).sort());assert.deepEqual(Object.keys(all[0]).sort(),Object.keys(all[2]).sort());for(const item of all)for(const text of Object.values(item))assert.ok(text.length>0&&Array.from(text).length<=120);
});

test("tray show labels use the Pi Desktop runtime display name",()=>{
  assert.equal(messages.desktopTrayMessagesEn["desktopTray.show"],"Show Pi Desktop");
  assert.equal(messages.desktopTrayMessagesZhCN["desktopTray.show"],"显示 Pi Desktop");
  assert.equal(messages.desktopTrayMessagesZhTW["desktopTray.show"],"顯示 Pi Desktop");
});
