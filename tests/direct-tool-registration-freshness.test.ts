/** Source-extracted production coordinator path. No application module imports.
 * Only the TypeScript compiler and Node built-ins load. Actual production envelope,
 * execute, prepareToolCall, executeResolvedTool, permission gate and resource
 * scheduler run unchanged; persistence, hooks, permission UI and tool effects are
 * inert memory-only boundaries. No Host, SDK, provider, socket or native browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p: string) => ts.createSourceFile(p, readFileSync(path.join(root, p), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const selected: ts.Node[] = [];
function decls(p: string, names: string[]) {
  const sf = read(p);
  return names.map(name => {
    const found = sf.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(sf) === name));
    assert.equal(found.length, 1, `${p}: ${name}`);
    selected.push(found[0]!);
    return found[0]!.getText(sf).replace(/^export\s+/u, '');
  }).join('\n');
}
function methods(p: string, className: string, names: string[]) {
  const sf = read(p), klass = sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === className);
  assert.ok(klass && ts.isClassDeclaration(klass), className);
  return `class ${className} {\n${names.map(name => {
    const found = klass.members.filter(n => n.name?.getText(sf) === name);
    assert.equal(found.length, 1, name); selected.push(found[0]!); return found[0]!.getText(sf);
  }).join('\n')}\n}`;
}
const coordinatorPath = 'src/agent/toolExecutionCoordinator.ts';
let source = methods(coordinatorPath, 'ToolExecutionCoordinator', ['createAgentTools', 'execute', 'prepareToolCall', 'executeResolvedTool', 'withPermissionGate', 'trackExecution']);
source += '\n' + decls(coordinatorPath, ['validateStrongConfirmation', 'isToolExecutionError', 'executionStateForResultStatus', 'terminalResultStatus', 'classifyCancellation', 'isSideEffectCommitted', 'exposeExecutionMetadata', 'formatToolError', 'isAbortError', 'abortedToolMessage', 'failedToolResultMessage', 'readStringField', 'attachToolSummary', 'waitForAbort']);
source += '\n' + decls('src/tools/exposure.ts', ['getToolExposure', 'isToolModelVisible', 'isToolModelVisibleInMode', 'isToolScriptCallable']);
source += '\n' + decls('src/tools/access.ts', ['ToolAccesses', 'file', 'conflicts', 'isWriteOperation', 'pathOverlaps', 'isWithin', 'normalizeAccessPath']);
source += '\n' + decls('src/tools/scheduler.ts', ['defaultMaxToolConcurrency', 'defaultMaxQueuedToolCalls', 'ToolSchedulerQueueFullError', 'ToolScheduler', 'abortReason']);
source += '\n' + methods('src/tools/registry.ts', 'ToolRegistry', ['register', 'unregister', 'list', 'listEntries']);
source += '\n' + decls('src/tools/file/editingMode.ts', ['routeEditingTools']);
// Extract the real closure for lease wiring separately; never initialize Runtime.
const runtime = read('src/runtime/CommandRuntime.ts');
let setter: ts.Expression | undefined;
function locate(n: ts.Node) { if (ts.isVariableDeclaration(n) && n.name.getText(runtime) === 'setBrowserAutomation') { assert.equal(setter, undefined); setter = n.initializer; } ts.forEachChild(n, locate); }
locate(runtime); assert.ok(setter); selected.push(setter);
  const setterSource = `function wiring(toolRegistry, config, createBrowserTools, createWebSearchTool, createWebFetchTool, resourceScope, attachDesktopComputerMcp, bindComputerTool) { const workspaceRoot = '/test-workspace'; const browserToolNames = ['BrowserOpen','BrowserListEnvironments','BrowserListProfiles','BrowserProfileHistory','BrowserReadDom','BrowserDOMSnapshot','BrowserDOMAction','BrowserLocatorRead','BrowserLocatorAction','BrowserCUA','BrowserScreenshot','BrowserTabFloat','BrowserClick','BrowserType','BrowserPress','BrowserWait','BrowserBack','BrowserForward','BrowserReload','BrowserClose','BrowserScroll','BrowserSelectOption','BrowserSetChecked','BrowserViewport','BrowserEval','BrowserCDP','BrowserDialogStatus','BrowserDialogRespond','BrowserDialogAutoReply','BrowserClipboardRead','BrowserClipboardWrite','BrowserUpload','BrowserDownload','BrowserExport','ComputerLaunch','ComputerMirror','ComputerList','ComputerObserve','ComputerAction','ComputerSequence']; const desktopComputerMcpName = 'computer-use'; let registeredMcpTools = []; let browserAutomationAttached = false; return ${setter.getText(runtime)}; }`;
source += '\n' + setterSource;
// Fail closed on newly introduced dynamic execution/imports and effectful globals.
for (const n of selected) {
  function check(node: ts.Node) {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node), 'No imports in extracted declarations');
    if (ts.isCallExpression(node)) assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword, 'No dynamic imports');
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) assert.ok(!['eval', 'Function', 'process', 'require', 'fetch', 'net', 'child_process', 'Worker', 'globalThis'].includes(node.text), `Forbidden identifier ${node.text}`);
    ts.forEachChild(node, check);
  }
  check(n);
}
const fail = (name: string) => () => { throw new Error(`Unexpected unsafe/uncovered boundary: ${name}`); };
class FixtureError extends Error {}
let routingDispatch: string[] = [];
const tool = (name: string, version: string, calls: string[]): any => ({ name, description: version, risk: 'execute', exposure: 'direct', parameters: {type:'object',properties:{}}, schema:{ parse: (x: unknown) => x }, resolveExecution: () => ({ approvalRule:name, accesses:[{kind:'browser',contextId:'inert-resource'}], async execute() { calls.push(version); return {version}; } }) });
const bindings = {
  path, Buffer, Error, DOMException, createHash, ZodError:FixtureError,
  CapabilityInvocationCancelledError:FixtureError, CapabilityOutcomeUnknownError:FixtureError,
  ToolOutcomeUnknownError:FixtureError, ExternalToolQuarantineError:FixtureError, FileChangeUncertainError:FixtureError,
  createToolOperationId:(session: string,id: string)=>`${session}/${id}`, serializeToolResult:JSON.stringify,
  toolResultPreview:(x: unknown)=>x, redactSecrets:(x: unknown)=>x, validateJsonSchema:()=>({ok:true}),
  isFullYesConfirmation:(x: string)=>x==='yes', isCodeModeReadTool:()=>false,
  isCodeModeTool:(entry: any)=>['Read','Write','Edit','apply_patch'].includes(entry.tool.name),
  createReadFileTool:()=>tool('Read','routed-read',routingDispatch),
  createEditFileTool:()=>tool('Edit','routed-edit',routingDispatch),
  createApplyPatchTool:()=>tool('apply_patch','routed-patch',routingDispatch),
  confirmPermissionRequest:fail('real confirmation'), waitForAbortWithDrain:fail('external drain'),
  parseFileChange:fail('file commit'), assertMatchingFileChange:fail('file commit'),
  toolSearchToolName:'ToolSearch', toolSearchResultNames:fail('discovery'),
};
const compiled = ts.transpileModule(source+'\n({ToolExecutionCoordinator, ToolRegistry, ToolScheduler, ToolAccesses, wiring});', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},reportDiagnostics:true});
assert.deepEqual((compiled.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error), []);
const {ToolExecutionCoordinator,ToolRegistry,ToolScheduler,ToolAccesses,wiring} = runInNewContext(compiled.outputText, bindings, {timeout:2000,contextCodeGeneration:{strings:false,wasm:false}});
const deferred = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(r=>resolve=r); return {promise,resolve}; };
function fixture() {
  const registry=Object.create(ToolRegistry.prototype); registry.tools=new Map();
  const c=Object.create(ToolExecutionCoordinator.prototype), audit: any[]=[], calls: string[]=[];
  const config={agent:{toolExecutionMode:'direct'},workspace:{ignore:[]}};
  Object.assign(c,{context:{toolRegistry:registry,config,workspaceRoot:'/inert',recorder:{sessionId:'inert'}},
    permissionManager:{evaluate:()=>({decision:'allow'}),applyResult:()=>{},revokeResult:()=>{},getDeniedPaths:()=>[]},
    allowedToolNames:undefined,executionToolNames:undefined,
    duplicateToolCallIds:new Set(),scriptParents:new Map(),toolImages:new Map(),imageBytes:0,
    codeModeToolChecks:new WeakMap(),pendingExecutions:new Map(),quarantinedCodeModeChildIds:new Set(),uncertainExecutions:new Map(),permissionTail:Promise.resolve(),
    getStepContext:()=>({}),nextSequence:()=>audit.length+1,recordAndFlush:async (e: any)=>{audit.push(e);return e;},emit:()=>{},
    assertCanContinue:()=>{},buildPermissionSnapshot:async (call: any)=>({request:{tool:call.name,toolCallId:call.id}}),
    runBeforeToolHooks:async()=>undefined,ensureCheckpoint:async()=>{},attachDiagnostics:async(_risk: unknown,_args: unknown,result: unknown)=>result,attachAfterToolHooks:async(_name: unknown,_args: unknown,result: unknown)=>result,
    finishSyntheticCall:async(_call: unknown,_seq: unknown,result: unknown)=>result,
    admissionScheduler:new ToolScheduler({maxConcurrency:4,maxQueuedTasks:8}),scheduler:new ToolScheduler({maxConcurrency:4,maxQueuedTasks:8})});
  registry.register(tool('BrowserClick','A',calls));
  const envelope=()=>c.createAgentTools().find((t: any)=>t.name==='BrowserClick');
  const change=(kind: string)=>{registry.unregister('BrowserClick');if(kind==='replace')registry.register(tool('BrowserClick','B',calls));};
  return {c,registry,calls,audit,envelope,change};
}
for (const kind of ['detach','replace']) for (const point of ['before-invoke','approval','resource-queue','admission-queue']) {
  test(`${kind}: stale direct envelope at ${point} must not dispatch`, {timeout:3000}, async()=>{
    const f=fixture(), old=f.envelope(); let pending: Promise<any>,blocker: Promise<any> | undefined,gate: ReturnType<typeof deferred>;
    if(point==='before-invoke'){ f.change(kind); pending=old.execute('stale',{}); }
    if(point==='approval'){
      gate=deferred();const reached=deferred();f.c.permissionManager.evaluate=()=>({decision:'ask'});
      f.c.context.confirmPermission=async()=>{reached.resolve();return gate.promise;};
      pending=old.execute('stale',{});await reached.promise;f.change(kind);gate.resolve({approved:true,scope:'once',confirmation:'yes'});
    }
    if(point==='admission-queue'){
      gate=deferred(); f.c.admissionScheduler=new ToolScheduler({maxConcurrency:1,maxQueuedTasks:8});
      blocker=f.c.admissionScheduler.schedule({accesses:ToolAccesses.none(),start:()=>gate.promise});
      const queued=deferred(),schedule=f.c.admissionScheduler.schedule.bind(f.c.admissionScheduler);
      f.c.admissionScheduler.schedule=(task: any)=>{const p=schedule(task);if(f.c.admissionScheduler.getSnapshot().queued===1)queued.resolve();return p;};
      pending=old.execute('stale',{});await queued.promise;f.change(kind);gate.resolve({});
    }
    if(point==='resource-queue'){
      gate=deferred();blocker=f.c.scheduler.schedule({accesses:ToolAccesses.browser('inert-resource'),start:()=>gate.promise});
      const queued=deferred(),schedule=f.c.scheduler.schedule.bind(f.c.scheduler);
      f.c.scheduler.schedule=(task: any)=>{const p=schedule(task);if(f.c.scheduler.getSnapshot().queued===1)queued.resolve();return p;};
      pending=old.execute('stale',{});await queued.promise;f.change(kind);gate.resolve({});
    }
    const result=await pending!;await blocker;
    assert.deepEqual(f.calls,[],`revoked ${kind}/${point} envelope dispatched ${JSON.stringify(f.calls)}`);
    assert.equal(result.isError,true,'obsolete envelope should return an audited failure');
    assert.match(JSON.stringify(result.details), /no longer available/, 'reject for registration freshness, not unrelated failure');
  });
}
test('unchanged registration executes once through real dispatch',async()=>{const f=fixture();const r=await f.envelope().execute('normal',{});assert.equal(r.isError,false,JSON.stringify(r));assert.deepEqual(f.calls,['A']);});
test('fresh replacement envelope executes B once',async()=>{const f=fixture();f.change('replace');const r=await f.envelope().execute('fresh',{});assert.equal(r.isError,false,JSON.stringify(r));assert.deepEqual(f.calls,['B']);});
test('direct routed editing envelopes remain callable',async()=>{
  const f=fixture();routingDispatch=[];for(const n of ['Read','Write','Edit'])f.registry.register(tool(n,'origin',f.calls));
  for(const mode of ['replace','patch']){
    const routed=f.c.createAgentTools({mode});
    for(const n of mode==='patch'?['Read','apply_patch']:['Read','Edit']){const r=await routed.find((t: any)=>t.name===n).execute(`${mode}-${n}`,{});assert.equal(r.isError,false,JSON.stringify(r));}
  }
  assert.deepEqual(routingDispatch,['routed-read','routed-edit','routed-read','routed-patch']);
});
test('actual browser lease setter replaces/removes inert built-in registrations',async()=>{
  const f=fixture(),events: string[]=[];
  const factories=(e: any)=>[tool('BrowserClick',e.label,events)];
  f.registry.registerBuiltinTool=function(this: any,t: any){this.register(t);};
  const setter=wiring(f.registry,{workspace:{ignore:[]},web:{search:{},cookies:{},fetch:{enabled:true}}},factories,(_a: unknown,_b: unknown,e: any)=>tool('WebSearch',e.label,events),(_a: unknown,_b: unknown,d: any)=>tool('WebFetch',d.browser?.label??'http',events),{mcp:{createTools:()=>[],detachLocalServer:async()=>{}}},async()=>{},(x: unknown)=>x);
  setter({label:'A'});const a=f.registry.listEntries().find((e: any)=>e.tool.name==='BrowserClick');
  setter({label:'B'});const b=f.registry.listEntries().find((e: any)=>e.tool.name==='BrowserClick');
  assert.notEqual(a,b);assert.equal(b.tool.description,'B');setter(undefined);
  assert.equal(f.registry.listEntries().some((e: any)=>e.tool.name==='BrowserClick'||e.tool.name==='WebSearch'),false);
  assert.equal(f.registry.listEntries().find((e: any)=>e.tool.name==='WebFetch').tool.description,'http');assert.deepEqual(events,[]);
});
test('already-dispatched call may complete after removal; no retroactive cancellation',async()=>{
  const f=fixture(),entered=deferred(),gate=deferred();
  f.registry.unregister('BrowserClick');
  const active=tool('BrowserClick','A',f.calls);
  active.resolveExecution=()=>({approvalRule:'BrowserClick',accesses:ToolAccesses.browser('inert-resource'),async execute(){f.calls.push('A');entered.resolve();await gate.promise;return {version:'A'};}});
  f.registry.register(active);
  const pending=f.envelope().execute('already-started',{});
  await entered.promise;f.change('replace');gate.resolve();
  const result=await pending!;assert.equal(result.isError,false,JSON.stringify(result));assert.deepEqual(f.calls,['A']);
});

test('model-only direct tool is not subject to script eligibility',async()=>{
  const f=fixture(); f.registry.unregister('BrowserClick');const current=tool('BrowserClick','model-only',f.calls);current.exposure='model-only';f.registry.register(current);
  const result=await f.envelope().execute('model-only',{});assert.equal(result.isError,false,JSON.stringify(result));assert.deepEqual(f.calls,['model-only']);
});
for(const origin of ['Write','Edit'])test(`routed apply_patch rejects revoked ${origin} origin`,async()=>{
  const f=fixture();routingDispatch=[];for(const name of ['Write','Edit'])f.registry.register(tool(name,'original',f.calls));
  const patch=f.c.createAgentTools({mode:'patch'}).find((t: any)=>t.name==='apply_patch');
  f.registry.unregister(origin);const result=await patch.execute('revoked-edit-origin',{});
  assert.deepEqual(routingDispatch,[]);assert.equal(result.isError,true);assert.match(JSON.stringify(result.details),/no longer available/);
});
