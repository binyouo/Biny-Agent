/**
 * Executes the production whole-session branch -> adoption -> session-read chain.
 * IPC/read completion, React setters and user navigation scheduling are inert.
 * This is source-bound workflow coverage, not mounted DOM or real Host coverage.
 */
import assert from 'node:assert/strict';

import fs from 'node:fs';

import vm from 'node:vm';

import {stripTypeScriptTypes} from 'node:module';

import { test } from 'node:test';

const renderer = new URL('../src/desktop/renderer/src/', import.meta.url);

const source = fs.readFileSync(new URL('App.tsx', renderer), 'utf8');

const navigationSource = fs.readFileSync(new URL('navigationHistory.ts', renderer), 'utf8');

const nav = new Function(stripTypeScriptTypes(navigationSource.replaceAll('export ', ''), { mode: 'transform' })
  + '\nreturn { createNavigationState, pushNavigation, moveNavigation };')();

function callback(name,next) {let a=source.indexOf(`  const ${name} = useCallback(`);
assert.ok(a>=0);
a+=`  const ${name} = useCallback(`.length;
const end=source.indexOf(`\n  const ${next}`,a);
let x=source.slice(a,end).trim();
 x=x.slice(0,x.lastIndexOf('\n  },')+4);
return stripTypeScriptTypes(`(${x})`,{mode:'transform'});
}
function defer(){let resolve,reject;
const promise=new Promise((a,b)=>{resolve=a;
reject=b});
return {promise,resolve,reject};
}
function fixture(){const copies=[],selects=[],reads=[],commits=[],warnings=[],toasts=[];
const refs={projectRef:{current:'a'},selectedRef:{current:'source'},loadRequestRef:{current:1},projectRemovalRef:{current:new Map()},navigationRef:{current:nav.pushNavigation(nav.createNavigationState(),{projectId:'a',sessionId:'source'})}};
const state={project:'a',session:'source',document:'source'};

 const ctx={...refs,console,useCallback:x=>x,setPendingNavigation:()=>{},setLoading:()=>{},setWarning:x=>warnings.push(x),errorMessage:e=>e.message,commitNavigation:x=>{refs.navigationRef.current=x},pushNavigation:nav.pushNavigation,setToast:x=>toasts.push(x),setRuntimePanelOpen:()=>{},memoryToggleRequestRef:{current:0},permissionModeRequestRef:{current:0},setMemoryToggleBusy:()=>{},setDraftProjectId:()=>{},setDraftMemoryOverride:()=>{},setWriterConflict:()=>{},setContextBudget:()=>{},setComposerDraft:()=>{},setSelectedSessionId:x=>{state.session=x},setDocument:x=>{state.document=x?.session.id},setSidebarSessions:()=>{},setWorkspace:()=>{},sessionTreePages:{observe:()=>{}},mergeProjectSessionPage:()=>{},mergeWorkspaceProject:x=>{state.project=x.project.id},window:{biny:{duplicateSession:()=>{const d=defer();
copies.push(d);
return d.promise},selectProject:()=>{const d=defer();
selects.push(d);
return d.promise},commitSelection:(p,s)=>{commits.push([p,s]);
return Promise.resolve()}}},readDesktopSession:(_api,p,s,w)=>{const d=defer();
reads.push({d,p,s,w});
return d.promise}};

 vm.createContext(ctx);
 ctx.openSession=vm.runInContext(callback('openSession','adoptWorkspace'),ctx);
ctx.adoptWorkspace=vm.runInContext(callback('adoptWorkspace','openNavigationTarget'),ctx);
ctx.run=vm.runInContext(callback('createBranch','rollbackFiles'),ctx);

 const navigate=(p,s)=>{refs.loadRequestRef.current++;
refs.projectRef.current=p;
refs.selectedRef.current=s;
state.project=p;
state.session=s;
state.document=s;
refs.navigationRef.current=nav.pushNavigation(refs.navigationRef.current,{projectId:p,sessionId:s})};

 const tick=async()=>{for(let i=0;
i<10;
i++)await Promise.resolve()};

 const resolveRead=async(index=0)=>{const r=reads[index];
r.d.resolve({document:{session:{id:r.s}},workspace:r.w});
await tick()};

 return {ctx,state,refs,copies,selects,reads,commits,warnings,toasts,navigate,tick,resolveRead,run:()=>ctx.run()};
}
// Exercise Forward from the state returned by Back, not from the end of history.
function assertHistoryRoundTrip(actual, expected) {
  if (expected.index < 1) return;
  const back = nav.moveNavigation(actual, -1);
  assert.ok(back.target, 'Back must select an actual previous entry');
  assert.deepEqual(back.target, expected.entries[expected.index - 1]);
  assert.equal(back.state.index, expected.index - 1);
  const forward = nav.moveNavigation(back.state, 1);
  assert.ok(forward.target, 'Forward after Back must select an actual entry');
  assert.deepEqual(forward.target, expected.entries[expected.index]);
  assert.deepEqual(forward.state, expected);
}

const snap=(p='a',s='child')=>({project:{id:p},selectedSessionId:s});

const cases=[
 ['normal branch commits child and success toast',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
await f.resolveRead();
await p;
assert.equal(f.state.session,'child');
assert.equal(f.refs.navigationRef.current.entries.at(-1).sessionId,'child');
assert.equal(f.toasts.length,1)}],
 ['newer session during child read preserves history and no toast',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
f.navigate('a','newer');
const expected=structuredClone(f.refs.navigationRef.current);
await f.resolveRead();
await p;
assert.equal(f.state.session,'newer');
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}],
 ['newer project during child read preserves history and no toast',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
f.navigate('b','newer');
const expected=structuredClone(f.refs.navigationRef.current);
await f.resolveRead();
await p;
assert.equal(f.state.session,'newer');
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}],
 ['new draft during child read preserves history and no toast',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
f.navigate('a',undefined);
const expected=structuredClone(f.refs.navigationRef.current);
await f.resolveRead();
await p;
assert.equal(f.state.session,undefined);
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}],
 ['A-B-A during child read preserves all history entries',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
f.navigate('b','b');
f.navigate('a','source');
const expected=structuredClone(f.refs.navigationRef.current);
await f.resolveRead();
await p;
assert.equal(f.state.session,'source');
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}],
 ['late read rejection does not overwrite newer navigation',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
f.navigate('b','b');
const expected=structuredClone(f.refs.navigationRef.current);
f.reads[0].d.reject(new Error('read failed'));
await p;
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}],
 ['selection before duplicate return remains protected',async f=>{const p=f.run();
f.navigate('b','b');
const expected=structuredClone(f.refs.navigationRef.current);
f.copies[0].resolve(snap());
await p;
assert.equal(f.reads.length,0);
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}],
 ['Back during pending child read retains the real Forward destination', async f => {
  const pending = f.run();
  f.copies[0].resolve(snap());
  await f.tick();
  f.navigate('b', 'middle');
  f.navigate('c', 'future');
  // User presses Back while the obsolete branch document is still being read.
  const back = nav.moveNavigation(f.refs.navigationRef.current, -1);
  assert.deepEqual(back.target, { projectId: 'b', sessionId: 'middle' });
  f.refs.loadRequestRef.current++;
  f.refs.navigationRef.current = back.state;
  f.refs.projectRef.current = back.target.projectId;
  f.refs.selectedRef.current = back.target.sessionId;
  f.state.project = back.target.projectId;
  f.state.session = back.target.sessionId;
  f.state.document = back.target.sessionId;
  const expected = structuredClone(back.state);
  await f.resolveRead();
  await pending;
  assert.equal(f.state.session, 'middle');
  assert.deepEqual(f.refs.navigationRef.current, expected);
  assert.equal(f.toasts.length, 0);
  const forward = nav.moveNavigation(f.refs.navigationRef.current, 1);
  assert.ok(forward.target, 'Forward from the middle must remain available');
  assert.deepEqual(forward.target, { projectId: 'c', sessionId: 'future' });
  assert.equal(forward.state.index, expected.index + 1);
  const roundTrip = nav.moveNavigation(forward.state, -1);
  assert.deepEqual(roundTrip.target, { projectId: 'b', sessionId: 'middle' });
  assert.deepEqual(roundTrip.state, expected);
 }],
 ['project removed during child read does not publish history',async f=>{const p=f.run();
f.copies[0].resolve(snap());
await f.tick();
const expected=structuredClone(f.refs.navigationRef.current);
f.refs.projectRemovalRef.current.set('a',1);
await f.resolveRead();
await p;
assert.deepEqual(f.refs.navigationRef.current,expected);
assertHistoryRoundTrip(f.refs.navigationRef.current, expected);
assert.equal(f.toasts.length,0)}]
];

for (const [name, run] of cases) test(name, async () => { await run(fixture());
 });

