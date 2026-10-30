/**
 * Actual App session-read/deletion callbacks and Manager batch ordering.
 * IPC, React setters, filesystem deletion and read completion are inert boundaries.
 * This is source-bound coverage, not mounted React or native Electron coverage.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
const source=fs.readFileSync(new URL('../src/desktop/renderer/src/App.tsx',import.meta.url),'utf8');
function callback(name,next) {
  const marker=`  const ${name} = useCallback(`;
  const start=source.indexOf(marker)+marker.length;
  assert.ok(start>=marker.length);
  const end=source.indexOf(`\n  const ${next}`,start);
  assert.ok(end>start);
  const part=source.slice(start,end).trim();
  return stripTypeScriptTypes(`(${part.slice(0,part.lastIndexOf('\n  },')+4)})`,{mode:'transform'});
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {resolve,reject,promise};}
function fixture(){
  const reads=[],deletions=[],commits=[],warnings=[];
  const row=(id,projectId='P')=>({id,projectId});
  const state={selected:'B',document:{session:row('B')},workspace:{project:{id:'P'},selectedSessionId:'B',sessions:[row('A'),row('B'),row('C')]},sidebar:[row('A'),row('B'),row('C')]};
  const context={useRef:value=>({current:value}),projectRef:{current:'P'},selectedRef:{current:'B'},loadRequestRef:{current:0},projectRemovalRef:{current:new Map()},memoryToggleRequestRef:{current:0},permissionModeRequestRef:{current:0},navigationRef:{current:{}},setPendingNavigation:()=>{},setLoading:()=>{},setMemoryToggleBusy:()=>{},setRuntimePanelOpen:()=>{},setDraftProjectId:()=>{},setDraftMemoryOverride:()=>{},setContextBudget:()=>{},setWriterConflict:()=>{},setWarning:e=>warnings.push(e),errorMessage:e=>e.message,
    setSelectedSessionId:x=>state.selected=x,setDocument:x=>state.document=x,setWorkspace:f=>state.workspace=f(state.workspace),setSidebarSessions:f=>state.sidebar=f(state.sidebar),mergeWorkspaceProject:()=>{},sessionTreePages:{observe:()=>{},replaceProject:()=>{}},invalidateSessionRootPage:()=>{},mergeProjectSnapshot:()=>{},commitNavigation:()=>{},replaceNavigation:()=>{},mergeProjectSessionPage:(rows,p,incoming)=>[...rows.filter(x=>!incoming.some(y=>x.id===y.id&&x.projectId===y.projectId)),...incoming],
    readDesktopSession:(_api,p,s)=>{const d=deferred();reads.push({...d,p,s});return d.promise},
    window:{biny:{commitSelection:(p,s)=>{commits.push({p,s});return Promise.resolve()},deleteSessions:(_targets,_confirm,onStarted)=>{const d=deferred();let started=false;deletions.push({...d,onStarted:()=>{if(!started){started=true;onStarted()}}});return d.promise},refreshProject:()=>Promise.resolve({})}}};
  vm.createContext(context);
  for (const name of ['sessionRemovalRef','sessionDeletionsRef']) {
    const ref=source.match(new RegExp(`^  const ${name} = .*;$`,'m'))?.[0];
    if(ref) vm.runInContext(stripTypeScriptTypes(ref,{mode:'transform'}),context);
  }
  const open=vm.runInContext(callback('openSession','adoptWorkspace'),context);
  const remove=(ids)=>vm.runInContext(callback('deleteSidebarSessions','runSessionAction'),context)(ids.map(([p,s])=>row(s,p)),false);
  const success=(index=0,ids=[['P','A']],failures=[])=>{deletions[index].onStarted();deletions[index].resolve({cancelled:false,deleted:ids.map(([projectId,sessionId])=>({projectId,sessionId})),failures})};
  const finishRead=(index=0)=>{const r=reads[index];r.resolve({document:{session:row(r.s,r.p)}})};
  return {open,remove,success,finishRead,state,reads,deletions,commits,warnings,context};
}
function assertKeptB(f){assert.equal(f.state.selected,'B');assert.equal(f.state.document.session.id,'B');assert.equal(f.state.sidebar.some(x=>x.id==='A'),false);assert.equal(f.commits.length,0)}
test('successful deletion retires an earlier pending read without reselecting, repersisting or restoring its row',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.success();await remove;f.finishRead();assert.equal(await read,false);assertKeptB(f);
});
test('successful deletion also suppresses its stale read error',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.success();await remove;f.reads[0].reject(new Error('deleted while reading'));assert.equal(await read,false);assertKeptB(f);
});
test('a read started during deletion is retired once deletion succeeds',async()=>{
  const f=fixture(),remove=f.remove([['P','A']]);f.deletions[0].onStarted();const read=f.open('P','A');f.success();await remove;f.finishRead();assert.equal(await read,false);assertKeptB(f);
});
test('deleting A does not retire a pending read of C in the same project',async()=>{
  const f=fixture(),read=f.open('P','C'),remove=f.remove([['P','A']]);f.success();await remove;f.finishRead();assert.equal(await read,true);assert.equal(f.state.selected,'C');assert.equal(f.commits[0].s,'C');
});
test('deletion identity includes the project, not just session ID',async()=>{
  const f=fixture(),read=f.open('Q','A'),remove=f.remove([['P','A']]);f.success();await remove;f.finishRead();assert.equal(await read,true);assert.equal(f.commits[0].p,'Q');
});
test('cancelled deletion does not retire the pending read',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.deletions[0].resolve({cancelled:true,deleted:[],failures:[]});await remove;f.finishRead();assert.equal(await read,true);assert.equal(f.state.selected,'A');
});
test('failed deletion does not retire the pending read',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.success(0,[],[{projectId:'P',sessionId:'A',error:'busy'}]);await remove;f.finishRead();assert.equal(await read,true);assert.equal(f.state.selected,'A');assert.equal(f.warnings.length,1);
});
test('partially successful batch preserves a failed target read',async()=>{
  const f=fixture(),read=f.open('P','C'),remove=f.remove([['P','A'],['P','C']]);f.success(0,[['P','A']],[{projectId:'P',sessionId:'C',error:'busy'}]);await remove;f.finishRead();assert.equal(await read,true);assert.equal(f.state.selected,'C');
});
test('a read finishing during deletion cannot repersist a removed selection before the batch returns',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A'],['P','C']]);f.deletions[0].onStarted();f.finishRead();
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(f.commits.length,0,'main may already have deleted A while C is still pending');
  f.success(0,[['P','A'],['P','C']]);await remove;assert.equal(await read,false);assertKeptB(f);
});
test('a new read after completed deletion is not permanently blacklisted',async()=>{
  const f=fixture(),remove=f.remove([['P','A']]);f.success();await remove;const read=f.open('P','A');f.finishRead();assert.equal(await read,true);assert.equal(f.state.selected,'A');
});
test('later unrelated navigation still wins over the deleted read',async()=>{
  const f=fixture(),old=f.open('P','A'),remove=f.remove([['P','A']]);const current=f.open('P','C');f.success();await remove;f.finishRead(1);assert.equal(await current,true);f.finishRead(0);assert.equal(await old,false);assert.equal(f.state.selected,'C');assert.equal(f.commits.length,1);
});
test('ordinary read errors without a successful deletion still propagate',async()=>{
  const f=fixture(),read=f.open('P','A');f.reads[0].reject(new Error('disk failure'));await assert.rejects(read,/disk failure/);
});

test('failed deletion releases an already completed read to publish',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.deletions[0].onStarted();f.finishRead();
  for(let i=0;i<10;i++) await Promise.resolve();assert.equal(f.commits.length,0);
  f.success(0,[],[{projectId:'P',sessionId:'A',error:'busy'}]);await remove;assert.equal(await read,true);assert.equal(f.state.selected,'A');
});
test('rejected deletion releases its pending read and retains the deletion error',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.deletions[0].onStarted();f.finishRead();
  f.deletions[0].reject(new Error('IPC failed'));await assert.rejects(remove,/IPC failed/);assert.equal(await read,true);
});
test('a read error waits for deletion failure then propagates unchanged',async()=>{
  const f=fixture(),read=f.open('P','A'),remove=f.remove([['P','A']]);f.deletions[0].onStarted();const checked=assert.rejects(read,/read failed/);f.reads[0].reject(new Error('read failed'));
  f.success(0,[],[{projectId:'P',sessionId:'A',error:'busy'}]);await remove;await checked;
});
test('overlapping deletion batches keep a read gated until the last batch succeeds',async()=>{
  const f=fixture(),read=f.open('P','A'),first=f.remove([['P','A']]);f.deletions[0].onStarted();f.finishRead();
  const second=f.remove([['P','A']]);f.deletions[1].onStarted();f.success(0,[],[{projectId:'P',sessionId:'A',error:'busy'}]);await first;
  for(let i=0;i<10;i++) await Promise.resolve();assert.equal(f.commits.length,0);
  f.success(1);await second;assert.equal(await read,false);assertKeptB(f);
});
test('a newer deletion admitted while awaiting the old batch also gates the read',async()=>{
  const f=fixture(),read=f.open('P','A'),first=f.remove([['P','A']]);f.deletions[0].onStarted();f.finishRead();
  for(let i=0;i<10;i++) await Promise.resolve();
  const second=f.remove([['P','A']]);f.deletions[1].onStarted();f.success(0,[],[{projectId:'P',sessionId:'A',error:'busy'}]);await first;
  for(let i=0;i<10;i++) await Promise.resolve();assert.equal(f.commits.length,0);
  f.success(1,[],[{projectId:'P',sessionId:'A',error:'busy'}]);await second;assert.equal(await read,true);
});

test('actual Manager batch deletion clears A before C finishes, and the read cannot write A back',async()=>{
  const manager=fs.readFileSync(new URL('../src/desktop/electron/main/DesktopAgentManager.ts',import.meta.url),'utf8');
  const start=manager.indexOf('  async deleteSessions(');
  const end=manager.indexOf('\n  private async deleteSessionData(',start);
  assert.ok(start>=0&&end>start);
  const method=stripTypeScriptTypes(`({${manager.slice(start,end)}})`,{mode:'transform'});
  const f=fixture(),holdC=deferred();let stored='B',removedA=false;
  const receiver=vm.runInNewContext(method);
  receiver.deleteSessionData=async (_p,s)=>{if(s==='A'){removedA=true;stored=undefined;}else await holdC.promise;};
  f.context.window.biny.deleteSessions=async(targets,_confirm,onStarted)=>{onStarted();return await receiver.deleteSessions(targets)};
  f.context.window.biny.commitSelection=async(_p,s)=>{stored=s;f.commits.push({p:_p,s})};
  const read=f.open('P','A'),remove=f.remove([['P','A'],['P','C']]);
  for(let i=0;i<10;i++)await Promise.resolve();assert.equal(removedA,true);assert.equal(stored,undefined);
  f.finishRead();for(let i=0;i<10;i++)await Promise.resolve();
  const beforeBatchCompletes=stored;
  holdC.resolve();await remove;const opened=await read;
  assert.equal(beforeBatchCompletes,undefined,'do not restore A after Main has deleted it but is still deleting C');
  assert.equal(stored,undefined);assert.equal(opened,false);assertKeptB(f);
});
