/** Actual stats/detail/layer/timeline components, isolated storage, and inert external boundaries. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { DesktopToolOptimizationStats } from '../src/desktop/protocol.js';
import type { SessionEvent } from '../src/session/recorder.js';
import type { ToolOptimizationEntry } from '../src/session/toolOptimization.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutionCoordinator } from '../src/agent/toolExecutionCoordinator.js';
import { SessionRecorder } from '../src/session/recorder.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { PermissionManager } from '../src/permission/PermissionManager.js';
import { defaultConfig } from '../src/config/schema.js';
import { ensureAgentDirs } from '../src/session/store.js';
import { readStoredSessionEvents } from '../src/session/events.js';
import { forkSession } from '../src/session/fork.js';
import { DesktopStateStore } from '../src/desktop/electron/main/DesktopStateStore.js';
import { DesktopUserDataStore } from '../src/desktop/electron/main/DesktopUserDataStore.js';
import { DesktopProjectService } from '../src/desktop/electron/main/DesktopProjectService.js';

import { vercelAgentLoopContinue } from '../src/agent/core/vercelAgentLoop.js';
import { replaySessionEvents } from '../src/session/replay.js';


import { z } from 'zod';
import { ToolAccesses } from '../src/tools/access.js';
import type { RunCommandToolResult } from '../src/tools/shell/runCommand.js';



type Origin = NonNullable<ToolOptimizationEntry['origin']>;
const origin = (projectId: string, sessionId = `session-${projectId}`, toolCallId = 'same-call'): Origin => ({ projectId, sessionId, toolCallId });
const row = (id: string, source = origin(id)): ToolOptimizationEntry => ({ time: new Date().toISOString(), origin: source,
  optimization: { id, kind: 'rtk', estimator: 'rtk', beforeTokens: 100, afterTokens: 10, savedTokens: 90, toolCalls: 1, command: 'git status', originalCommand: `git status -- ${id}` } });
const stats = (...entries: ToolOptimizationEntry[]): DesktopToolOptimizationStats => ({ entries, incompleteSessions: 0, rtk: { path: '/inert/rtk' } });
const events = (source: Origin, tag: string): SessionEvent[] => [
  { type: 'tool_call', tool: 'Bash', toolCallId: source.toolCallId, args: { command: `git status -- ${tag}` }, time: '2026-10-20T12:00:00.000Z' },
  { type: 'tool_result', tool: 'Bash', toolCallId: source.toolCallId, result: { command: `git status -- ${tag}`, stdout: `${tag}-result`, stderr: '', exitCode: 0, executedCommand: `rtk git status -- ${tag}` }, optimization: row(tag).optimization, time: '2026-10-20T12:00:01.000Z' }
];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function harness(t: TestContext) {
  const hooks = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : next(url, context); } });
  const { JSDOM } = await import('jsdom'); const React = await import('react');
  const dom = new JSDOM('<!doctype html><div id="root"></div><div id="detail-host"></div>', { url: 'https://biny.invalid', pretendToBeVisual: true });
  const restore: Array<() => void> = [];
  const set = (target: object, key: string, value: unknown) => { const descriptor = Object.getOwnPropertyDescriptor(target, key); Object.defineProperty(target, key, { value, writable: true, configurable: true }); restore.push(() => descriptor ? Object.defineProperty(target, key, descriptor) : Reflect.deleteProperty(target, key)); };
  const mounted: { root?: import('react-dom/client').Root } = {};
  const statsReads: ReturnType<typeof deferred<DesktopToolOptimizationStats>>[] = [];
  const detailReads: Array<ReturnType<typeof deferred<{ events: SessionEvent[] }>> & { args: string[] }> = [];
  const external: string[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    try { if (mounted.root) await React.act(() => mounted.root!.unmount()); } catch (error) { errors.push(error); }
    try { await React.act(async () => { statsReads.forEach(r => r.resolve(stats())); detailReads.forEach(r => r.resolve({ events: [] })); await Promise.allSettled([...statsReads, ...detailReads].map(r => r.promise)); }); } catch (error) { errors.push(error); }
    try { dom.window.close(); } catch (error) { errors.push(error); }
    hooks.deregister(); restore.reverse().forEach(undo => undo());
    assert.deepEqual(external, [], 'No network, filesystem-opening, or external navigation');
    if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
  });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) set(globalThis, key, value);
  t.mock.method(globalThis, 'fetch', async () => { external.push('fetch'); throw new Error('Unexpected fetch'); });
  t.mock.method(Socket.prototype, 'connect', () => { external.push('socket'); throw new Error('Unexpected network'); });
  set(dom.window, 'biny', {
    toolOptimizationStats(...args: unknown[]) { assert.deepEqual(args, ['all']); const gate = deferred<DesktopToolOptimizationStats>(); statsReads.push(gate); return gate.promise; },
    toolOptimizationDetail(...args: string[]) { const gate = { ...deferred<{ events: SessionEvent[] }>(), args }; detailReads.push(gate); return gate.promise; },
    openWorkspaceFile() { external.push('openWorkspaceFile'); throw new Error('Unexpected file open'); },
    openExternal() { external.push('openExternal'); throw new Error('Unexpected external navigation'); }
  });
  const { createRoot } = await import('react-dom/client');
  const { SettingsToolOptimization } = await import('../src/desktop/renderer/src/components/settings/SettingsToolOptimization.js');
  const { OptimizationCallDetail } = await import('../src/desktop/renderer/src/components/settings/OptimizationCallDetail.js');
  const { SettingsDetailHostContext } = await import('../src/desktop/renderer/src/components/settings/SettingsDetailHostContext.js');
  const host = document.getElementById('detail-host')!;
  const provider = (child: React.ReactNode) => React.createElement(SettingsDetailHostContext.Provider, { value: host }, child);
  mounted.root = createRoot(document.getElementById('root')!);
  const render = async () => React.act(() => mounted.root!.render(provider(React.createElement(SettingsToolOptimization))));
  const click = async (text: string) => { const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text); assert.ok(button, `Missing button ${text}`); await React.act(() => { button.focus(); button.click(); }); };
  const detailText = () => host.textContent ?? '';
  return { statsReads, detailReads, document, React, render, click, detailText,
    settleStats: async (index: number, value: DesktopToolOptimizationStats) => React.act(async () => statsReads[index]!.resolve(value)),
    settleDetail: async (index: number, value: SessionEvent[] | Error) => React.act(async () => value instanceof Error ? detailReads[index]!.reject(value) : detailReads[index]!.resolve({ events: value })),
    escape: async () => React.act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))),
    backdrop: async () => React.act(() => host.querySelector('.settings-detail-layer')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))),
    leave: async () => React.act(() => mounted.root!.render(null)),
    renderDetail: async (source: Origin, optimizationId = source.projectId) => React.act(() => mounted.root!.render(provider(React.createElement(OptimizationCallDetail, { origin: source, optimizationId, onClose() {} }))))
  };
}

test('real recent-command links retain original project/session when toolCallIds match', async t => {
  const h = await harness(t); await h.render(); await h.settleStats(0, stats(row('alpha'), row('beta')));
  await h.click('git status -- alpha'); assert.deepEqual(h.detailReads[0]!.args, ['alpha', 'session-alpha', 'same-call']);
  assert.match(h.detailText(), /正在读取调用/); await h.settleDetail(0, events(origin('alpha'), 'alpha'));
  assert.equal(h.document.querySelector('.tool-details')?.getAttribute('data-project-id'), 'alpha'); assert.match(h.detailText(), /alpha-result/); assert.doesNotMatch(h.detailText(), /beta-result/);
  await h.click('关闭'); assert.equal(h.detailText(), ''); assert.equal(h.document.activeElement?.textContent, 'git status -- alpha');
  await h.click('git status -- beta'); assert.deepEqual(h.detailReads[1]!.args, ['beta', 'session-beta', 'same-call']);
  await h.settleDetail(1, events(origin('beta'), 'beta')); assert.match(h.detailText(), /beta-result/); assert.doesNotMatch(h.detailText(), /alpha-result/);
});

for (const oldFails of [false, true]) for (const oldFirst of [false, true]) {
  test(`close A, open B: late ${oldFails ? 'failure' : 'success'} ${oldFirst ? 'before' : 'after'} B cannot replace B`, async t => {
    const h = await harness(t); await h.render(); await h.settleStats(0, stats(row('alpha'), row('beta')));
    await h.click('git status -- alpha'); await h.click('关闭'); await h.click('git status -- beta');
    const old = oldFails ? new Error('alpha-stale-error') : events(origin('alpha'), 'alpha');
    if (oldFirst) { await h.settleDetail(0, old); assert.match(h.detailText(), /正在读取调用/); }
    await h.settleDetail(1, events(origin('beta'), 'beta')); if (!oldFirst) await h.settleDetail(0, old);
    assert.match(h.detailText(), /beta-result/); assert.doesNotMatch(h.detailText(), /alpha-result|alpha-stale-error/); assert.equal(h.document.querySelector('[role="alert"]'), null);
  });
}

test('current failed or unrenderable call is explicit, reopen retries and Escape/backdrop restore focus', async t => {
  const h = await harness(t); await h.render(); await h.settleStats(0, stats(row('alpha')));
  await h.click('git status -- alpha'); await h.settleDetail(0, new Error('inert missing history'));
  assert.match(h.document.querySelector('[role="alert"]')?.textContent ?? '', /inert missing history/);
  await h.escape(); assert.equal(h.detailText(), ''); assert.equal(h.document.activeElement?.textContent, 'git status -- alpha');
  await h.click('git status -- alpha'); await h.settleDetail(1, []); assert.match(h.detailText(), /对应调用无法还原/);
  await h.backdrop(); assert.equal(h.detailText(), ''); assert.equal(h.document.activeElement?.textContent, 'git status -- alpha'); await h.click('git status -- alpha');
  await h.settleDetail(2, events(origin('alpha'), 'alpha')); assert.match(h.detailText(), /alpha-result/); assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test('refresh begun before opening detail does not rebind the open source snapshot', async t => {
  const h = await harness(t); await h.render(); await h.settleStats(0, stats(row('alpha')));
  await h.click('刷新'); await h.click('git status -- alpha');
  await h.settleStats(1, stats(row('replacement', origin('other-project', 'other-session', 'other-call'))));
  assert.equal(h.detailReads.length, 1); await h.settleDetail(0, events(origin('alpha'), 'alpha')); assert.match(h.detailText(), /alpha-result/);
  assert.equal(h.document.querySelector('.tool-details')?.getAttribute('data-project-id'), 'alpha');
  await h.click('关闭'); await h.click('git status -- replacement'); assert.deepEqual(h.detailReads[1]!.args, ['other-project', 'other-session', 'other-call']);
});

for (const failure of [false, true]) test(`whole settings unmount/reopen ignores prior detail ${failure ? 'failure' : 'success'}`, async t => {
  const h = await harness(t); await h.render(); await h.settleStats(0, stats(row('alpha'))); await h.click('git status -- alpha');
  await h.leave(); await h.render(); await h.settleStats(1, stats(row('beta'))); await h.click('git status -- beta');
  await h.settleDetail(1, events(origin('beta'), 'beta')); await h.settleDetail(0, failure ? new Error('old-unmounted-error') : events(origin('alpha'), 'alpha'));
  assert.match(h.detailText(), /beta-result/); assert.doesNotMatch(h.detailText(), /alpha-result|old-unmounted-error/);
});

for (const failure of [false, true]) test(`component origin replacement ignores superseded ${failure ? 'failure' : 'success'} (component contract only)`, async t => {
  const h = await harness(t); await h.renderDetail(origin('alpha')); await h.renderDetail(origin('beta'));
  await h.settleDetail(1, events(origin('beta'), 'beta')); await h.settleDetail(0, failure ? new Error('old-origin-error') : events(origin('alpha'), 'alpha'));
  assert.match(h.detailText(), /beta-result/); assert.doesNotMatch(h.detailText(), /alpha-result|old-origin-error/);
});

/**
 * Real SDK model loop, coordinator, operation IDs, recorder, fork, index, service, and timeline.
 * Only model and Bash system-tool boundary are inert. No real command or RTK execution is claimed.
 * Product Linux deny-path sandbox was respected; this helper neither invokes nor disables it.
 */
async function createRtkIdentityFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biny-inert-rtk-identity-'));
  const prior = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, 'state');
  const recorders: SessionRecorder[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    const settlements = await Promise.allSettled(recorders.map(rec => rec.close()));
    try { await rm(root,{recursive:true,force:true}); }
    finally { if(prior === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = prior; }
    const failures = settlements.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    if(failures.length) throw new AggregateError(failures.map(item=>item.reason),'Fixture recorder cleanup failed');
  };
  try {
    const projectRoot = path.join(root, 'project');
    await mkdir(projectRoot); await ensureAgentDirs(projectRoot);
    const config = structuredClone(defaultConfig); // No permission/sandbox changes.
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.registerBuiltinTool({
      name:'Bash', description:'Inert system-tool boundary fixture; no command execution',risk:'execute',
      parameters:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false},
      schema:z.object({command:z.string()}),
      resolveExecution: (args:{command:string}) => ({
        accesses:ToolAccesses.none(), approvalRule:`Bash(${args.command})`, retrySafety:'safe',
        async execute(): Promise<RunCommandToolResult> {
          assert.ok(['git status','git diff'].includes(args.command));
          calls.push(args.command);
          const original = args.command === 'git status';
          const stdout = original ? 'ORIGINAL COMMAND OUTPUT\n' : 'NEW FORK COMMAND OUTPUT\n';
          return {background:false,status:'completed',stdout,stderr:'',exitCode:0,
            stdoutBytes:Buffer.byteLength(stdout),stdoutRetainedBytes:Buffer.byteLength(stdout),stdoutTruncated:false,
            stderrBytes:0,stderrRetainedBytes:0,stderrTruncated:false,
            rtk:{beforeTokens:original?400:1200,afterTokens:original?100:200,command:args.command,originalCommand:args.command,durationMs:1}};
        }
      })
    });
    const recorder = new SessionRecorder(projectRoot, 'identity-source'); recorders.push(recorder);
  const run = async (rec: SessionRecorder, marker: string, code: string) => {
    rec.setRuntimeContext({runId: `${marker}-run`, turnId: `${marker}-turn`});
    await rec.recordAndFlush({type:'user_message', content:marker});
    const coordinator = new ToolExecutionCoordinator({workspaceRoot:projectRoot, config, recorder:rec, toolRegistry:registry}, new PermissionManager(config.permission), () => {}, () => ({}), new Set(['Bash']));
    // This is an ordinary fresh-turn provider ID, not a duplicate inside one coordinator.
    assert.equal(coordinator.observeToolCall('call_0'), undefined);
    const codeTool = coordinator.createCodeModeTool();
    let requests = 0;
    const model = {provider:'inert-provider', modelId:'turn-local-call-ids', stream: async () => {
      const invocation = requests++;
      return (async function*() {
        yield {type:'start' as const};
        if (invocation === 0) {
          yield {type:'tool-call' as const,id:'call_0',name:'run_script',arguments:{description:marker,code}};
          yield {type:'finish' as const,reason:'tool-calls' as const};
        } else {yield {type:'text-delta' as const,text:'done'}; yield {type:'finish' as const,reason:'stop' as const};}
      })();
    }};
    const historical = replaySessionEvents((await readStoredSessionEvents(projectRoot,rec.sessionId)).events).messages;
    const completed = [];
    try {
      for await (const event of vercelAgentLoopContinue({messages:historical,tools:[codeTool]}, {model,tools:[codeTool],maxSteps:2})) {
        if(event.type === 'tool_execution_end') completed.push(event);
        if(event.type === 'error') throw new Error(event.error);
      }
    } finally {
      await coordinator.waitForIdle();
      await rec.flush();
    }
    assert.equal(requests,2); assert.equal(completed.length,1);
    assert.equal(completed[0].toolCallId,'call_0');
    assert.equal(completed[0].result.isError,false,JSON.stringify(completed[0].result));
    return completed[0].result;
  };

    await run(recorder, 'source-original', "const r = await tools.Bash({command:'git status'}); return r.stdout.length;");
    await recorder.close();
    const fork = await forkSession(projectRoot, recorder.sessionId);
    const resumed = new SessionRecorder(projectRoot, fork.sessionId); recorders.push(resumed);
    const copied = (await readStoredSessionEvents(projectRoot, fork.sessionId)).events;
    resumed.restoreToolCallSequence(Math.max(0,...copied.map(e=>'sequence' in e?e.sequence??0:0)));
    await run(resumed, 'fork-new', "const r = await tools.Bash({command:'git diff'}); return r.stdout.length;");
    await resumed.close();
    assert.deepEqual(calls,['git status','git diff']);
    const state = new DesktopStateStore(path.join(root,'desktop-state.json'));
    const project = {id:'fixture-project',path:projectRoot,name:'project',dirty:false,missing:false,pinned:false,addedAt:new Date().toISOString(),lastOpenedAt:new Date().toISOString()};
    await state.upsertProject(project);
    const service = new DesktopProjectService(state,new DesktopUserDataStore(path.join(root,'desktop')),{load:async()=>{throw new Error('Unexpected config read')}} as any);
    const stats = await service.toolOptimizationStats('all');
    assert.equal(stats.incompleteSessions,0);
    const receipts = stats.entries.filter(e=>e.optimization.kind === 'rtk');
    assert.equal(receipts.length,2);
    const oldEntry = receipts.find(e=>e.optimization.originalCommand === 'git status')!;
    const newEntry = receipts.find(e=>e.optimization.originalCommand === 'git diff')!;
    assert.ok(oldEntry); assert.ok(newEntry);
    assert.notEqual(oldEntry.optimization.id,newEntry.optimization.id);
    assert.equal(newEntry.origin!.sessionId,fork.sessionId);
    return { service, stats, oldEntry, newEntry, close };
  } catch(error) { await close(); throw error; }
}


test('clicking a fork RTK receipt with a reused tool call ID renders that operation, not its copied ancestor', async t => {
  const data = await createRtkIdentityFixture();
  t.after(data.close);
  const h = await harness(t); await h.render();
  await h.settleStats(0, { ...data.stats, rtk: { path: '/inert/rtk' } });
  await h.click('git diff');
  const source = data.newEntry.origin!;
  assert.deepEqual(h.detailReads[0]!.args, [source.projectId, source.sessionId, source.toolCallId]);
  await h.settleDetail(0, (await data.service.toolOptimizationDetail(...h.detailReads[0]!.args as [string, string, string])).events);
  assert.match(h.detailText(), /NEW FORK COMMAND OUTPUT/);
  assert.doesNotMatch(h.detailText(), /ORIGINAL COMMAND OUTPUT/);
  assert.ok(h.detailText().includes(`≈${(1200).toLocaleString()} → ≈200`));
  await h.click('关闭'); await h.click('git status');
  await h.settleDetail(1, (await data.service.toolOptimizationDetail(...h.detailReads[1]!.args as [string, string, string])).events);
  assert.match(h.detailText(), /ORIGINAL COMMAND OUTPUT/);
  assert.doesNotMatch(h.detailText(), /NEW FORK COMMAND OUTPUT/);
});

test('a disappeared selected operation fails closed even when another receipt has the same tool call ID', async t => {
  const h = await harness(t); await h.render(); await h.settleStats(0, stats(row('selected', origin('project'))));
  await h.click('git status -- selected');
  await h.settleDetail(0, events(origin('project'), 'replacement'));
  assert.match(h.detailText(), /对应调用无法还原/);
  assert.equal(h.document.querySelector('.tool-details'), null);
});

test('component contract: changing only the selected operation retires the old read with the same origin object', async t => {
  const h = await harness(t); const source = origin('project');
  await h.renderDetail(source, 'old'); await h.renderDetail(source, 'new');
  assert.equal(h.detailReads.length, 2);
  await h.settleDetail(1, [...events(source, 'old'), ...events(source, 'new')]);
  await h.settleDetail(0, new Error('superseded-receipt-failure'));
  assert.match(h.detailText(), /new-result/);
  assert.doesNotMatch(h.detailText(), /old-result|superseded-receipt-failure/);
});
