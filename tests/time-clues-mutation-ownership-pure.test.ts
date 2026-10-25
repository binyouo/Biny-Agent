/** Native source extraction; inert hooks, IPC and timers. No product module imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = new URL('../src/desktop/renderer/src/components/overlays/TimeCluesDialog.tsx', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile('TimeCluesDialog.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'TimeCluesDialog');
assert.ok(component && ts.isFunctionDeclaration(component) && component.body);
const declarations = component.body.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations]);
const groups = declarations.find(n => n.name.getText(ast) === 'groups');
assert.ok(groups);
const prefix = source.slice(component.body.getStart(ast) + 1, groups.parent.parent.getStart(ast));
const extracted = stripTypeScriptTypes(`function renderComponent({open,currentSessionId,refreshKey,onClose,onSource}) { ${prefix}\nreturn {load,ignore,markSeen,setRangeKind,offset}; }`, { mode: 'strip' });
const stateNames = declarations.filter(n => n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(ast) === 'useState').map(n => {
  assert.ok(ts.isArrayBindingPattern(n.name)); const first = n.name.elements[0]; assert.ok(first && ts.isBindingElement(first)); return first.name.getText(ast);
});
assert.deepEqual(stateNames, ['rangeKind','now','page','offset','busy','error','aboutOpen','custom','calendarError']);

const setup = `'use strict';
let slots=[],work,cursor=0,plans=[],pendingPassive=[],api,candidate,rendering=false,mounted=false;
let props={open:true,currentSessionId:'session-A',refreshKey:'0',onClose(){},onSource(){}},stateCells=[];
let setterCalls=0,postUnmountSetters=0,reads=[],mutations=[],timers=new Map(),listeners=new Map(),nextTimer=0;
const PAGE_SIZE=50;
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
function useRef(initial){const i=cursor++;work[i]??={kind:'ref',value:{current:initial}};return work[i].value;}
function useState(initial){const i=cursor++;if(!work[i]){const cell={kind:'state',value:typeof initial==='function'?initial():initial};cell.set=value=>{setterCalls++;if(!mounted)postUnmountSetters++;cell.value=typeof value==='function'?value(cell.value):value;};work[i]=cell;stateCells.push(cell);}return [work[i].value,work[i].set];}
function useCallback(fn,deps){const i=cursor++,old=slots[i];if(old&&same(old.deps,deps)){work[i]=old;return old.value;}work[i]={kind:'callback',value:fn,deps};return fn;}
function registerEffect(type,setup,deps){const i=cursor++,old=slots[i];if(old&&same(old.deps,deps)){work[i]=old;return;}const next={kind:'effect',type,setup,deps,cleanup:undefined};work[i]=next;plans.push({old,next});}
const useEffect=(fn,deps)=>registerEffect('passive',fn,deps);
const useLayoutEffect=(fn,deps)=>registerEffect('layout',fn,deps);
const usePopover=()=>({triggerRef:{current:null},triggerProps:{},toggle(){},hide(){},isOpen:false,render(){throw Error('JSX unavailable');}});
const naturalTemporalRanges=()=>({today:{startDate:'2026-10-24',endDate:'2026-10-25'},thisWeek:{startDate:'2026-10-19',endDate:'2026-10-26'},nextWeek:{startDate:'2026-10-26',endDate:'2026-11-02'}});
const Intl={DateTimeFormat:()=>({resolvedOptions:()=>({timeZone:'UTC'})})};
function request(list,input){const entry={input,settled:false};list.push(entry);return new Promise((resolve,reject)=>{entry.resolve=value=>{if(entry.settled)throw Error('already settled');entry.settled=true;resolve(value);};entry.reject=message=>{if(entry.settled)throw Error('already settled');entry.settled=true;reject(new Error(message));};});}
const window={biny:{temporalClues:input=>request(reads,input),temporalIgnoreClue:id=>request(mutations,{kind:'ignore',id}),temporalMarkTodaySeen:(day,timeZone)=>request(mutations,{kind:'seen',day,timeZone})},setInterval(fn,ms){if(ms!==60000)throw Error('unexpected interval');const id=++nextTimer;timers.set(id,fn);return id;},clearInterval(id){timers.delete(id);},addEventListener(type,fn){listeners.set('window:'+type,fn);},removeEventListener(type,fn){if(listeners.get('window:'+type)===fn)listeners.delete('window:'+type);}};
const document={visibilityState:'visible',addEventListener(type,fn){listeners.set('document:'+type,fn);},removeEventListener(type,fn){if(listeners.get('document:'+type)===fn)listeners.delete('document:'+type);}};
${extracted}
function begin(next={}){if(rendering)throw Error('nested render');rendering=true;work=slots.slice();plans=[];cursor=0;const nextProps={...props,...next};candidate={api:renderComponent(nextProps),props:nextProps};}
function runPlan(plan){plan.old?.cleanup?.();plan.next.cleanup=plan.next.setup();}
function commit(passive=true){if(!rendering)throw Error('no render');slots=work;api=candidate.api;props=candidate.props;mounted=true;rendering=false;for(const plan of plans){if(plan.next.type==='layout')runPlan(plan);else pendingPassive.push(plan);}plans=[];if(passive)flushPassive();}
function flushPassive(){for(const plan of pendingPassive.splice(0))runPlan(plan);}
function discard(){rendering=false;work=undefined;plans=[];candidate=undefined;}
function render(next={},passive=true){begin(next);commit(passive);}
function unmount(){if(pendingPassive.length)throw Error('flush before unmount');for(const slot of slots)if(slot.kind==='effect')slot.cleanup?.();mounted=false;}
function readSuccess(i,label){const input=reads[i].input;reads[i].resolve({clues:[],scheduled:[],unread:1,hasMore:true,nextOffset:input.offset+50,coverage:label});}
function settleMutation(i,ok){if(ok)mutations[i].resolve(mutations[i].input.kind==='ignore'?true:1);else mutations[i].reject('mutation-'+i+'-failed');}
function start(kind){if(kind==='ignore')void api.ignore('clue-A');else void api.markSeen();}
function snapshot(){return JSON.stringify({state:Object.fromEntries(${JSON.stringify(stateNames)}.map((name,i)=>[name,stateCells[i].value])),reads:reads.map(x=>x.input),mutations:mutations.map(x=>({input:x.input,settled:x.settled})),setterCalls,postUnmountSetters,timers:timers.size,committedOffset:api.offset});}
render();readSuccess(0,'initial');`;

interface Snapshot {
  state: { rangeKind: string; page?: { coverage: string }; offset: number; busy: boolean; error?: string };
  reads: Array<{ startDate: string; endDate: string; currentSessionId?: string; offset: number }>;
  mutations: Array<{ input: { kind: string; id?: string; day?: string; timeZone?: string }; settled: boolean }>;
  setterCalls: number; postUnmountSetters: number; timers: number; committedOffset: number;
}
function harness() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const run = (text: string): unknown => new vm.Script(text).runInContext(context, { timeout: 1000 });
  run(setup); run('render()');
  return { run, snapshot: (): Snapshot => JSON.parse(run('snapshot()') as string) as Snapshot };
}
function noStaleEffect(h: ReturnType<typeof harness>, command: string): void {
  const before=h.snapshot(); h.run(command); const after=h.snapshot();
  assert.equal(after.reads.length,before.reads.length,'obsolete mutation must not issue a captured-view refresh');
  assert.equal(after.setterCalls,before.setterCalls,'obsolete continuation must not write current view state');
  assert.deepEqual(after.state,before.state);
  assert.equal(after.mutations[0]!.settled,true,'original mutation response still settles');
}

for (const kind of ['ignore','seen']) {
  test(kind+' same-owner success refreshes exact page',()=>{const h=harness();h.run(`start('${kind}');settleMutation(0,true)`);assert.equal(h.snapshot().reads.length,2);assert.deepEqual(h.snapshot().reads[1],h.snapshot().reads[0]);h.run("readSuccess(1,'updated')");h.run("render()");assert.equal(h.snapshot().state.page?.coverage,'updated');assert.equal(h.snapshot().state.busy,false);});
  test(kind+' same-owner failure displays error without extra read',()=>{const h=harness();h.run(`start('${kind}');settleMutation(0,false)`);assert.equal(h.snapshot().state.error,'mutation-0-failed');assert.equal(h.snapshot().reads.length,1);});
  for(const ok of [true,false])test(kind+' same-owner settled page50 '+(ok?'success':'failure')+' retains offset',()=>{const h=harness();h.run("void api.load(50);readSuccess(1,'page-50')");h.run('render()');assert.equal(h.snapshot().committedOffset,50);h.run(`start('${kind}');settleMutation(0,${ok})`);if(ok){assert.equal(h.snapshot().reads.length,3);assert.equal(h.snapshot().reads[2]!.offset,50);h.run("readSuccess(2,'updated-50')");h.run('render()');assert.equal(h.snapshot().state.page?.coverage,'updated-50');}else{assert.equal(h.snapshot().reads.length,2);assert.equal(h.snapshot().state.error,'mutation-0-failed');assert.equal(h.snapshot().state.page?.coverage,'page-50');}assert.equal(h.snapshot().state.offset,50);});
  for(const ok of [true,false]) {
    for(const transition of [
      {name:'range change',steps:["api.setRangeKind('nextWeek');render();readSuccess(1,'next-week')","render()"]},
      {name:'ABA range change',steps:["api.setRangeKind('nextWeek');render();api.setRangeKind('today');render();readSuccess(2,'new-today')","render()"]},
      {name:'session change',steps:["render({currentSessionId:'session-B'});readSuccess(1,'session-B')","render()"]},
      {name:'pagination change',steps:["void api.load(50);readSuccess(1,'page-50')","render()"]},
      {name:'close',steps:["render({open:false})"]},
      {name:'close and reopen',steps:["render({open:false});render({open:true});readSuccess(1,'reopened')","render()"]},
      {name:'unmount',steps:["unmount()"]}
    ])test(kind+' '+transition.name+' ignores obsolete '+(ok?'success':'failure'),()=>{const h=harness();h.run(`start('${kind}')`);for(const step of transition.steps)h.run(step);if(transition.name==='pagination change')assert.equal(h.snapshot().committedOffset,50);noStaleEffect(h,`settleMutation(0,${ok})`);assert.equal(h.snapshot().postUnmountSetters,0);});
  }
  test(kind+' stale read cannot replace newer range even if current read was pending',()=>{const h=harness();h.run(`start('${kind}');api.setRangeKind('nextWeek');render();settleMutation(0,true)`);assert.equal(h.snapshot().reads.length,2,'no old-range read starts');h.run("readSuccess(1,'next-week')");h.run("render()");assert.equal(h.snapshot().state.page?.coverage,'next-week');assert.equal(h.snapshot().state.rangeKind,'nextWeek');});
  for(const ok of [true,false])test(kind+' pending pagination retires old-page '+(ok?'success':'failure'),()=>{const h=harness();h.run(`start('${kind}');void api.load(50);render()`);assert.equal(h.snapshot().committedOffset,0,'page-50 has not settled');noStaleEffect(h,`settleMutation(0,${ok})`);h.run("readSuccess(1,'page-50')");h.run('render()');assert.equal(h.snapshot().state.offset,50);assert.equal(h.snapshot().state.page?.coverage,'page-50');});
  test(kind+' same-view refresh-key update preserves admitted mutation',()=>{const h=harness();h.run(`start('${kind}');render({refreshKey:'1'});readSuccess(1,'refreshed')`);h.run('render();settleMutation(0,true)');assert.equal(h.snapshot().reads.length,3);h.run("readSuccess(2,'after-mutation')");h.run("render()");assert.equal(h.snapshot().state.page?.coverage,'after-mutation');});
  test(kind+' background read does not invalidate same-view mutation',()=>{const h=harness();h.run(`start('${kind}');listeners.get('window:focus')();readSuccess(1,'focus-refresh')`);h.run('render();settleMutation(0,true)');assert.equal(h.snapshot().reads.length,3);h.run("readSuccess(2,'after-mutation')");h.run("render()");assert.equal(h.snapshot().state.page?.coverage,'after-mutation');});
  test(kind+' concurrent same-view mutations both refresh without cancelling writes',()=>{const h=harness();h.run(`start('${kind}');start('${kind}');settleMutation(1,true)`);h.run("readSuccess(1,'second')");h.run("render();settleMutation(0,true)");assert.equal(h.snapshot().reads.length,3);h.run("readSuccess(2,'first')");h.run("render()");assert.equal(h.snapshot().state.page?.coverage,'first');assert.ok(h.snapshot().mutations.every(x=>x.settled));});
  test(kind+' discarded render cannot retire current mutation',()=>{const h=harness();h.run(`start('${kind}');begin({currentSessionId:'discarded'});discard();settleMutation(0,true)`);assert.equal(h.snapshot().reads.length,2);h.run("readSuccess(1,'updated')");h.run("render()");assert.equal(h.snapshot().state.page?.coverage,'updated');});
  test(kind+' same-view harmless rerender preserves mutation',()=>{const h=harness();h.run(`start('${kind}');render();settleMutation(0,true)`);assert.equal(h.snapshot().reads.length,2);});
}
test('existing direct read guard preserves newer range',()=>{const h=harness();h.run("void api.load(0);api.setRangeKind('nextWeek');render();readSuccess(2,'next-week')");h.run('render()');const before=h.snapshot();h.run("readSuccess(1,'old-today')");assert.deepEqual(h.snapshot().state,before.state);assert.equal(h.snapshot().setterCalls,before.setterCalls);});
test('existing direct read guard suppresses stale read errors',()=>{const h=harness();h.run("void api.load(0);api.setRangeKind('nextWeek');render();readSuccess(2,'next-week')");h.run('render()');const before=h.snapshot();h.run("reads[1].reject('old-read-error')");assert.deepEqual(h.snapshot().state,before.state);});
test('original mutation payloads remain captured rather than retargeted',()=>{const h=harness();h.run("start('ignore');start('seen');render({currentSessionId:'B'});api.setRangeKind('nextWeek');render()");assert.deepEqual(h.snapshot().mutations.map(x=>x.input),[{kind:'ignore',id:'clue-A'},{kind:'seen',day:'2026-10-24',timeZone:'UTC'}]);});
