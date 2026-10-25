/** Source-extracted UI authority contracts. No React/product graph or real clipboard/DOM/timers. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = new URL('../src/desktop/renderer/src/components/MarkdownCodeBlock.tsx', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile('MarkdownCodeBlock.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'MarkdownCodeBlock');
assert.ok(component && ts.isFunctionDeclaration(component) && component.body);
const declarations = component.body.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations]);
const copyDeclaration = declarations.find(n => n.name.getText(ast) === 'copy');
const copy = copyDeclaration?.initializer;
assert.ok(copy && ts.isJsxElement(copy) && copy.openingElement.tagName.getText(ast) === 'button');
const attr = (name: string): ts.Expression => {
  const attribute = copy.openingElement.attributes.properties.find(n => ts.isJsxAttribute(n) && n.name.getText(ast) === name);
  assert.ok(attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
  return attribute.initializer.expression;
};
assert.equal(attr('aria-label').getText(ast), 'label');
assert.equal(attr('title').getText(ast), 'label');
const click = attr('onClick');
assert.ok(click && ts.isArrowFunction(click));
const label = declarations.find(n => n.name.getText(ast) === 'label')?.initializer;
assert.ok(label);
const stateNames = declarations.filter(n => n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(ast) === 'useState').map(n => {
  assert.ok(ts.isArrayBindingPattern(n.name));
  const first = n.name.elements[0];
  assert.ok(first && ts.isBindingElement(first));
  return first.name.getText(ast);
});
assert.deepEqual(stateNames, ['sticky', 'copied', 'copyFailed']);
const helperCalls: ts.CallExpression[] = [];
function visit(n: ts.Node): void {
  if (ts.isCallExpression(n) && n.expression.getText(ast) === 'copyToClipboard') helperCalls.push(n);
  ts.forEachChild(n, visit);
}
visit(click);
assert.equal(helperCalls.length, 1);
assert.equal(helperCalls[0]!.arguments[0]!.getText(ast), 'code');
// Selected arguments come from the chosen source, not an assumed old/new arity.
const expectedArguments = stripTypeScriptTypes(`function expectedArguments(code) { return [${helperCalls[0]!.arguments.map(n => n.getText(ast)).join(',')}]; }`, { mode: 'strip' });
const prefix = source.slice(component.body.getStart(ast) + 1, copyDeclaration!.parent.parent.getStart(ast));
const componentCode = stripTypeScriptTypes(`function renderComponent({code,language,dashed,isStreaming=false}) {${prefix}\n return {click:${click.getText(ast)},label,setSticky}; }`, { mode: 'strip' });
const labelCode = `function feedbackLabel(copied,copyFailed) { return ${label.getText(ast)}; }`;

const setup = `'use strict';
let slots=[],work,rendering=false,cursor=0,stateCells=[],plans=[],pendingPassive=[],api,props={code:'A',language:'js'},candidate;
let mounted=false,setterCalls=0,postUnmountSetters=0,timerCreations=0,timerClears=0,now=0,nextTimer=0,timers=new Map(),writes=[];
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
function useRef(initial){const i=cursor++;work[i]??={kind:'ref',value:{current:initial}};return work[i].value;}
function useState(initial){const i=cursor++;if(!work[i]){const cell={kind:'state',value:initial};cell.set=value=>{setterCalls++;if(!mounted)postUnmountSetters++;cell.value=typeof value==='function'?value(cell.value):value;};work[i]=cell;stateCells.push(cell);}return [work[i].value,work[i].set];}
function registerEffect(type,setup,deps){const i=cursor++,old=slots[i];if(old&&same(old.deps,deps)){work[i]=old;return;}const next={kind:'effect',type,setup,deps,cleanup:undefined};work[i]=next;plans.push({old,next});}
const useEffect=(fn,deps)=>registerEffect('passive',fn,deps);
const useLayoutEffect=(fn,deps)=>registerEffect('layout',fn,deps);
const useHighlightedCode=()=>({html:''});
const window={clearTimeout(id){timerClears++;timers.delete(id);},setTimeout(fn,ms){if(ms!==2000)throw Error('unexpected duration');timerCreations++;const id=++nextTimer;timers.set(id,{fn,due:now+ms});return id;}};
function copyToClipboard(...args){const entry={args};writes.push(entry);return new Promise(resolve=>entry.resolve=resolve);}
${componentCode}
${labelCode}
${expectedArguments}
function begin(next={}){if(rendering)throw Error('nested render');rendering=true;work=slots.slice();plans=[];const nextProps={...props,...next};candidate={api:renderComponentWithProps(nextProps),props:nextProps};}
function renderComponentWithProps(nextProps){cursor=0;return renderComponent(nextProps);}
function runPlan(plan){plan.old?.cleanup?.();plan.next.cleanup=plan.next.setup();}
function commit(passive=true){if(!rendering)throw Error('no render');slots=work;api=candidate.api;props=candidate.props;mounted=true;rendering=false;for(const plan of plans){if(plan.next.type==='layout')runPlan(plan);else pendingPassive.push(plan);}plans=[];if(passive)flushPassive();}
function flushPassive(){for(const plan of pendingPassive.splice(0))runPlan(plan);}
function discard(){if(!rendering)throw Error('no render');rendering=false;work=undefined;plans=[];candidate=undefined;}
function render(next={},passive=true){begin(next);commit(passive);}
function settle(i,result){writes[i].resolve(result);}
function unmount(){if(pendingPassive.length)throw Error('test must flush passive setup before unmount');for(const slot of slots)if(slot.kind==='effect')slot.cleanup?.();mounted=false;}
function replayEffects(){for(const slot of slots)if(slot.kind==='effect')slot.cleanup?.();for(const type of ['layout','passive'])for(const slot of slots)if(slot.kind==='effect'&&slot.type===type)slot.cleanup=slot.setup();}
function advance(ms){now+=ms;for(;;){const next=[...timers].filter(([,x])=>x.due<=now).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!next)break;timers.delete(next[0]);next[1].fn();}}
// Passive observations: never render, commit, or invoke effects to obtain state.
function snapshot(){const copied=stateCells[1].value,failed=stateCells[2].value;return JSON.stringify({copied,failed,label:feedbackLabel(copied,failed),setterCalls,postUnmountSetters,timerCreations,timers:timers.size,writes:writes.map(x=>x.args)});}
function argumentsFor(value){return JSON.stringify(expectedArguments(value));}
render();`;

interface Snapshot {
  copied: boolean;
  failed: boolean;
  label: string;
  setterCalls: number;
  postUnmountSetters: number;
  timerCreations: number;
  timers: number;
  writes: unknown[][];
}
function harness() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const run = (text: string): unknown => new vm.Script(text).runInContext(context, { timeout: 1000 });
  run(setup);
  return { run, snapshot: (): Snapshot => JSON.parse(run('snapshot()') as string) as Snapshot, args: (text: string): unknown[] => JSON.parse(run(`argumentsFor(${JSON.stringify(text)})`) as string) as unknown[] };
}
const expected = (result: boolean) => ({ copied: result, failed: !result, label: result ? '已复制' : '复制失败，点击重试' });
const neutral = { copied: false, failed: false, label: '复制代码' };
function feedback(h: ReturnType<typeof harness>, value: Partial<Snapshot>): void { const actual=h.snapshot();for(const [key,want]of Object.entries(value))assert.equal(actual[key as keyof Snapshot],want,key); }
function unchangedCompletion(h: ReturnType<typeof harness>, statement: string): void { const before=h.snapshot();h.run(statement);const after=h.snapshot();assert.equal(after.setterCalls,before.setterCalls,'stale continuation must not call state setters');assert.equal(after.timerCreations,before.timerCreations,'stale continuation must not create timers'); }

for (const result of [true,false]) {
  test('current result '+result,()=>{const h=harness();h.run('api.click()');h.run('settle(0,'+result+')');feedback(h,expected(result));assert.equal(h.snapshot().timers,1);});
  test('current result expiry '+result,()=>{const h=harness();h.run('api.click();settle(0,'+result+')');h.run('advance(1999)');feedback(h,expected(result));h.run('advance(1)');feedback(h,neutral);assert.equal(h.snapshot().timers,0);});
  test('pending completion after code commit '+result,()=>{const h=harness();h.run('api.click();render({code:"B"})');unchangedCompletion(h,'settle(0,'+result+')');feedback(h,neutral);assert.equal(h.snapshot().timers,0);});
  test('pending completion after ABA commit '+result,()=>{const h=harness();h.run('api.click();render({code:"B"});render({code:"A"})');unchangedCompletion(h,'settle(0,'+result+')');feedback(h,neutral);});
  test('settled feedback retired by code commit '+result,()=>{const h=harness();h.run('api.click();settle(0,'+result+')');h.run('render({code:"B"})');feedback(h,neutral);assert.equal(h.snapshot().timers,0);});
  test('code layout commit retires before passive effects '+result,()=>{const h=harness();h.run('api.click();render({code:"B"},false)');unchangedCompletion(h,'settle(0,'+result+')');feedback(h,neutral);h.run('flushPassive()');});
  test('pending completion after unmount '+result,()=>{const h=harness();h.run('api.click();unmount()');unchangedCompletion(h,'settle(0,'+result+')');assert.equal(h.snapshot().postUnmountSetters,0);assert.equal(h.snapshot().timers,0);});
  test('settled timer removed on unmount '+result,()=>{const h=harness();h.run('api.click();settle(0,'+result+')');h.run('unmount()');assert.equal(h.snapshot().timers,0);unchangedCompletion(h,'advance(2000)');assert.equal(h.snapshot().postUnmountSetters,0);});
  test('effect cleanup/setup retires pending work '+result,()=>{const h=harness();h.run('api.click();replayEffects()');unchangedCompletion(h,'settle(0,'+result+')');feedback(h,neutral);h.run('api.click();settle(1,'+result+')');feedback(h,expected(result));});
  test('discarded source render retains current request '+result,()=>{const h=harness();h.run('api.click();begin({code:"B"});discard();settle(0,'+result+')');feedback(h,expected(result));assert.equal(h.snapshot().timers,1);});
  test('discard then actual same target commit still retires '+result,()=>{const h=harness();h.run('api.click();begin({code:"B"});discard();render({code:"B"})');unchangedCompletion(h,'settle(0,'+result+')');feedback(h,neutral);});
  test('settled feedback survives discarded source render '+result,()=>{const h=harness();h.run('api.click();settle(0,'+result+')');h.run('begin({code:"B"});discard()');feedback(h,expected(result));assert.equal(h.snapshot().timers,1);});
}

for(const oldResult of [true,false])for(const newResult of [true,false])for(const changed of [true,false]) {
  test('latest completion owns feedback old='+oldResult+' new='+newResult+' changed='+changed,()=>{const h=harness();h.run('api.click();'+(changed?'render({code:"B"});':'')+'api.click();settle(1,'+newResult+')');feedback(h,expected(newResult));unchangedCompletion(h,'settle(0,'+oldResult+')');feedback(h,expected(newResult));assert.equal(h.snapshot().timers,1);});
  test('superseded completion cannot show while latest pending old='+oldResult+' new='+newResult+' changed='+changed,()=>{const h=harness();h.run('api.click();'+(changed?'render({code:"B"});':'')+'api.click()');unchangedCompletion(h,'settle(0,'+oldResult+')');feedback(h,neutral);h.run('settle(1,'+newResult+')');feedback(h,expected(newResult));});
}

test('success then failed retry clears success after settlement and expiry',()=>{const h=harness();h.run('api.click();settle(0,true)');h.run('api.click();settle(1,false)');feedback(h,expected(false));assert.equal(h.snapshot().timers,1);h.run('advance(2000)');feedback(h,neutral);});
test('failure then successful retry clears failure after settlement',()=>{const h=harness();h.run('api.click();settle(0,false)');h.run('api.click();settle(1,true)');feedback(h,expected(true));assert.equal(h.snapshot().timers,1);});
for(const prior of [true,false])test('explicit policy: new pending request retires old settled feedback '+prior,()=>{const h=harness();h.run('api.click();settle(0,'+prior+')');h.run('api.click()');feedback(h,neutral);assert.equal(h.snapshot().timers,0);});
test('cleared earlier timer cannot reset newer successful feedback',()=>{const h=harness();h.run('api.click();settle(0,true)');h.run('advance(1000);api.click();settle(1,true)');h.run('advance(1000)');feedback(h,expected(true));assert.equal(h.snapshot().timers,1);h.run('advance(1000)');feedback(h,neutral);});
for(const action of ['render({code:"A"})','render({language:"ts"})','api.setSticky({top:1,right:2,unit:"20px"});render()','render({isStreaming:true,dashed:true})']) {
  test('same payload pending rerender control '+action,()=>{const h=harness();h.run('api.click();'+action+';settle(0,true)');feedback(h,expected(true));assert.equal(h.snapshot().timers,1);});
  test('same payload settled rerender control '+action,()=>{const h=harness();h.run('api.click();settle(0,true)');h.run(action);feedback(h,expected(true));assert.equal(h.snapshot().timers,1);});
}
test('raw captured payload and source-selected helper options remain exact',()=>{const h=harness(),value='raw\u00a0😀\r\n';h.run('render({code:'+JSON.stringify(value)+'});api.click();render({code:"replacement"});api.click()');assert.deepEqual(h.snapshot().writes,[h.args(value),h.args('replacement')]);});
