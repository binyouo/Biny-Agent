/** Actual extracted callbacks in an explicit inert DOM model; not native DOM/keyboard acceptance. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const paths = ["copyToClipboard.ts", "components/CopyButton.tsx", "components/workspace/RenderingPreviewPanel.tsx"] as const;
const sources: Record<string, string> = Object.fromEntries(paths.map(path => [path, readFileSync(new URL(`../src/desktop/renderer/src/${path}`, import.meta.url), "utf8")]));
interface Scenario { name: string; api: "native" | "absent" | "reject"; ok: boolean; sink?: "true" | "false" | "throw"; move?: "outside"; text?: string; during?: "focus-outside" | "disconnect-previous" | "disable-previous"; focusThrows?: boolean; cleanupThrows?: boolean; legacy?: boolean; }
interface Check { name: string; pass: boolean; message?: string; }
interface Snapshot { copied: boolean; failed: boolean; pending: boolean; timers: number; appended: number; removed: number; removeAttempts: number; liveTemporary: boolean; modern: string[]; fallback: string[]; focus: string; focusCalls: Array<{ id: string; connected: boolean; disabled: boolean; options: unknown }>; escaped: number; keyPath: string[]; events: string[]; }
function source(path: string): string { const value = sources[path]; assert(value !== undefined); return value; }
function ast(path: string) { return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function findAll(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] { const found: ts.Node[] = []; function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); } visit(root); return found; }
function callback(path: string, name: string, tag: string): string {
  const tree = ast(path);
  const attrs = findAll(tree, n => ts.isJsxAttribute(n) && n.name.getText(tree) === name && ts.isJsxOpeningElement(n.parent.parent) && n.parent.parent.tagName.getText(tree) === tag);
  assert.equal(attrs.length, 1, `${path} ${tag} ${name}`);
  const attr = attrs[0];
  assert(attr && ts.isJsxAttribute(attr) && attr.initializer);
  assert(ts.isJsxExpression(attr.initializer) && attr.initializer.expression && ts.isArrowFunction(attr.initializer.expression));
  return stripTypeScriptTypes(attr.initializer.expression.getText(tree), { mode: 'strip' });
}
const helperTree = ast('copyToClipboard.ts');
assert.equal(helperTree.statements.length, 1);
const helper = helperTree.statements[0];
assert(helper && ts.isFunctionDeclaration(helper) && helper.name?.text === 'copyToClipboard');
const token = helper.modifiers?.find(n => n.kind === ts.SyntaxKind.ExportKeyword);
assert(token);
const helperCode = stripTypeScriptTypes(source('copyToClipboard.ts').slice(0, token.getStart(helperTree)) + source('copyToClipboard.ts').slice(token.end), { mode: 'strip' });
const clickCode = callback('components/CopyButton.tsx', 'onClick', 'button');
const keyCode = callback('components/workspace/RenderingPreviewPanel.tsx', 'onKeyDown', 'section');
for (const code of [helperCode, clickCode, keyCode]) assert(!/\b(?:require|import)\s*\(/u.test(code));
const panelTree = ast('components/workspace/RenderingPreviewPanel.tsx');
const sites = findAll(panelTree, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText(panelTree) === 'CopyButton');
assert.equal(sites.length, 1);
const site = sites[0];
assert(site && ts.isJsxSelfClosingElement(site));
const attrs = site.attributes.properties;
const flags: Record<string, boolean> = {};
for (const flag of ['preserveTrailingNewline', 'preserveNonBreakingSpaces']) {
  const attr = attrs.find(n => ts.isJsxAttribute(n) && n.name.getText(panelTree) === flag);
  if (attr) assert(ts.isJsxAttribute(attr) && attr.initializer === undefined, 'only literal true source flags are supported');
  flags[flag] = !!attr;
}
const valueAttr = attrs.find(n => ts.isJsxAttribute(n) && n.name.getText(panelTree) === 'value');
assert(valueAttr && ts.isJsxAttribute(valueAttr) && valueAttr.initializer && ts.isJsxExpression(valueAttr.initializer) && valueAttr.initializer.expression);
assert.equal(valueAttr.initializer.expression.getText(panelTree), 'preview.source');
assert(!findAll(ast('components/CopyButton.tsx'), n => ts.isJsxAttribute(n) && n.name.getText() === 'disabled').length);

const cases: Scenario[] = [
  { name: 'native success retains focused copy button', api: 'native', ok: true },
  { name: 'native success does not resurrect initiating button after focus moves', api: 'native', move: 'outside', ok: true },
  { name: 'empty input creates no fallback or focus change', api: 'absent', text: '', ok: false },
  ...(['absent', 'reject'] as const).flatMap(api => (['true', 'false', 'throw'] as const).map(sink => ({ name: `${api} fallback ${sink} restores copy focus without changing cleanup behavior`, api, sink, ok: sink === 'true' }))),
  ...(['true', 'false', 'throw'] as const).map(sink => ({ name: `delayed rejection snapshots current outside focus at fallback entry (${sink})`, api: 'reject' as const, sink, move: 'outside' as const, ok: sink === 'true' })),
  { name: 'fallback preserves newer synchronous sink focus ownership', api: 'absent', sink: 'true', during: 'focus-outside', ok: true },
  { name: 'throwing sink preserves newer synchronous sink focus ownership', api: 'absent', sink: 'throw', during: 'focus-outside', ok: false },
  { name: 'disconnected previous target is not refocused', api: 'absent', sink: 'true', during: 'disconnect-previous', ok: true },
  { name: 'disabled previous target is not refocused', api: 'absent', sink: 'true', during: 'disable-previous', ok: true },
  { name: 'restoration focus throws without changing successful copy result', api: 'absent', sink: 'true', focusThrows: true, ok: true },
  { name: 'temporary cleanup throw retains original false result and leftover node', api: 'absent', sink: 'true', cleanupThrows: true, ok: false },
  { name: 'actual source flags preserve existing NBSP CRLF Unicode policy through fallback', api: 'absent', sink: 'true', text: 'A["中文😀\u00a0"]\r\n\n', ok: true },
  { name: 'actual source flags preserve existing NBSP CRLF Unicode policy through native', api: 'native', text: 'A["中文😀\u00a0"]\r\n\n', ok: true },
  { name: 'legacy flags retain NBSP normalization and one-LF trim', api: 'absent', sink: 'true', legacy: true, text: 'a\u00a0b\r\n\n', ok: true }
];
function runCase(spec: Scenario) {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const run = (code: string): unknown => new vm.Script(code).runInContext(context, { timeout: 1000 });
  run(`'use strict';
    const spec = ${JSON.stringify(spec)};
    const events = [], modern = [], fallback = [], focusCalls = [];
    let copied=false, failed=false, timers=0, appended=0, removed=0, removeAttempts=0, fallbackNode, resolveWrite, rejectWrite;
    let escaped=0, activeElement, beforeFallback;
    // Explicit model: tree ancestry only; no browser default keyboard navigation.
    function element(id, parent=null) {
      return { id, parent, isConnected:true, disabled:false, style:{}, value:'',
        setAttribute(name, value) { if(name !== 'readonly' || value !== '') throw Error('attribute'); },
        focus(options) { focusCalls.push({id, connected:this.isConnected, disabled:this.disabled, options:options??null}); if(id==='copy' && spec.focusThrows && appended)throw Error('synthetic restoration focus throws'); if(this.isConnected && !this.disabled) { activeElement=this; events.push('focus:'+id); } },
        select() { events.push('select:'+id); },
        setSelectionRange(start,end) { if(start!==0 || end!==this.value.length) throw Error('selection bounds'); events.push('range:'+id); },
        remove() { document.body.removeChild(this); }
      };
    }
    const body=element('body'), section=element('panel',body), button=element('copy',section), outside=element('outside',body);
    activeElement=button;
    const document={ get activeElement(){return activeElement;}, body,
      createElement(tag){ if(tag!=='textarea')throw Error('tag'); fallbackNode=element('fallback');fallbackNode.isConnected=false; return fallbackNode; },
      execCommand(command){ if(command!=='copy')throw Error('command'); fallback.push(fallbackNode.value);
        if(spec.during==='focus-outside')outside.focus();
        if(spec.during==='disconnect-previous'){beforeFallback.isConnected=false;beforeFallback.parent=null;}
        if(spec.during==='disable-previous')beforeFallback.disabled=true;
        if(spec.sink==='throw')throw Error('synthetic copy sink throw');
        return spec.sink!=='false';
      }
    };
    body.appendChild=node=>{if(node!==fallbackNode)throw Error('append');beforeFallback=activeElement;node.parent=body;node.isConnected=true;appended++;events.push('append');};
    body.removeChild=node=>{if(node!==fallbackNode||node.parent!==body)throw Error('remove');removeAttempts++;if(spec.cleanupThrows)throw Error('synthetic removal throws');
      // HTML removing steps: focused area -> viewport; exposed here as body. NOT previous element.
      if(activeElement===node)activeElement=body;node.parent=null;node.isConnected=false;removed++;events.push('remove');return node;};
    const navigator={clipboard:spec.api==='absent'?undefined:{writeText:value=>{modern.push(value);return new Promise((resolve,reject)=>{resolveWrite=resolve;rejectWrite=reject;});}}};
    const window={clearTimeout(){},setTimeout(callback,delay){if(delay!==1200)throw Error('timer');timers++;return timers;}};
    const requestRef={current:undefined}, timerRef={current:undefined};
    const setCopied=value=>{copied=value;},setFailed=value=>{failed=value;};
    const value=spec.text??'flowchart TD\\nA-->B',resolveValue=undefined;
    const preserveTrailingNewline=${!spec.legacy && !!flags.preserveTrailingNewline};
    const preserveNonBreakingSpaces=${!spec.legacy && !!flags.preserveNonBreakingSpaces};
    const expanded=true,panel={current:section},onToggleExpanded=()=>{escaped++;};
    ${helperCode}
    const onClick=${clickCode};
    const onKeyDown=${keyCode};
    // Boundary is invocation of the actual enabled button activation callback; not fake Enter defaults.
    onClick();
  `);
  if (spec.move) run('outside.focus();');
  if (spec.api === 'native') run('resolveWrite();');
  if (spec.api === 'reject') run('rejectWrite(new Error("synthetic denied"));');
  const result = JSON.parse(run(`
    // Dispatch only Escape from model's actual current focus along its tree ancestors.
    const keyEvent={key:'Escape',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
    const keyPath=[];
    for(let node=activeElement;node;node=node.parent){keyPath.push(node.id);if(node===section)onKeyDown(keyEvent);}
    JSON.stringify({copied,failed,pending:!!requestRef.current,timers,appended,removed,removeAttempts,liveTemporary:!!fallbackNode?.isConnected,
      modern,fallback,focus:activeElement.id,focusCalls,escaped,keyPath,events});
  `) as string) as Snapshot;
  const text = spec.text ?? 'flowchart TD\nA-->B';
  const newlineText = !spec.legacy && flags.preserveTrailingNewline ? text : text.replace(/\n$/, '');
  const expectedText = !spec.legacy && flags.preserveNonBreakingSpaces ? newlineText : newlineText.replace(/\u00a0/g, ' ');
  const didFallback = !!text && spec.api !== 'native';
  const expectedFocus = spec.during === 'focus-outside' || spec.move ? 'outside'
    : spec.focusThrows || ['disconnect-previous', 'disable-previous'].includes(spec.during ?? '') ? 'body' : 'copy';
  const checks: Check[] = [];
  function check(name: string, fn: () => void): void { try{fn();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,message:error instanceof Error ? error.message : String(error)});} }
  check('feedback and pending ownership',()=>assert.deepEqual({copied:result.copied,failed:result.failed,pending:result.pending,timers:result.timers}, {copied:spec.ok,failed:!spec.ok,pending:false,timers:spec.ok?1:0}));
  check('native exact bytes',()=>assert.deepEqual(result.modern, text && spec.api!=='absent' ? [expectedText] : []));
  check('fallback exact bytes',()=>assert.deepEqual(result.fallback,didFallback?[expectedText]:[]));
  const reachesRemoval = didFallback && spec.sink !== 'throw';
  const removalSucceeds = reachesRemoval && !spec.cleanupThrows;
  check('original temporary lifecycle preserved',()=>assert.deepEqual({appended:result.appended,removed:result.removed,live:result.liveTemporary},{appended:didFallback?1:0,removed:removalSucceeds?1:0,live:didFallback&&!removalSucceeds}));
  check('cleanup attempted once',()=>assert.equal(result.removeAttempts,reachesRemoval?1:0));
  if(spec.focusThrows)check('restoration attempted before tolerating focus error',()=>assert.equal(result.focusCalls.filter(call=>call.id==='copy').length,1));
  // Cleanup-error case is an unchanged error/leftover-node CONTROL, not a new focus policy.
  if(!spec.cleanupThrows) {
    check('post-copy keyboard focus',()=>assert.equal(result.focus,expectedFocus));
    check('panel scoped Escape path only',()=>assert.equal(result.escaped,expectedFocus==='copy'?1:0));
  }
  if(['disconnect-previous','disable-previous'].includes(spec.during ?? ''))check('stale target never actually regains focus',()=>assert.notEqual(result.focus,'copy'));
  return {name:spec.name,pass:checks.every(item=>item.pass),checks,observed:result};
}
for (const spec of cases) test(spec.name, () => {
  const result = runCase(spec);
  for (const check of result.checks) assert.equal(check.pass, true, `${check.name}: ${check.message ?? ""}`);
});
