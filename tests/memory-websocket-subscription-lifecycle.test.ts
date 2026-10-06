/** Isolated lifecycle audit: fake WebSockets, timers and watchers; only temporary directory metadata. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { attachMemoryWebSocket } from '../src/runtime/host/memory-websocket.js';

type Client = Parameters<typeof attachMemoryWebSocket>[1];
type Frame = { type: string; data: Record<string, unknown>; timestamp: string };
class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: Frame[] = [];
  pings = 0;
  terminations = 0;
  closeCode?: number;
  sendError?: Error;
  send(frame: string, callback: (error?: Error) => void): void { this.frames.push(JSON.parse(frame) as Frame); callback(this.sendError); }
  ping(): void { this.pings++; }
  terminate(): void { this.terminations++; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  close(code: number): void { this.closeCode = code; this.terminate(); }
}
class FakeWatcher extends EventEmitter {
  closed = 0;
  unreferenced = false;
  constructor(readonly change: (event: string, name: string | Buffer | null) => void) { super(); }
  close(): void { this.closed++; }
  unref(): this { this.unreferenced = true; return this; }
}
type Timer = { callback: () => void; delay: number; repeat: boolean; unreferenced: boolean; unref: () => Timer };
class Clock {
  readonly timers = new Set<Timer>();
  add(callback: () => void, delay: number, repeat: boolean): Timer {
    const timer: Timer = { callback, delay, repeat, unreferenced: false, unref() { this.unreferenced = true; return this; } };
    this.timers.add(timer); return timer;
  }
  fire(delay: number): void {
    for (const timer of [...this.timers].filter(timer => timer.delay === delay)) {
      if (!timer.repeat) this.timers.delete(timer);
      timer.callback();
    }
  }
}
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const embedding = () => ({ models: [], localModels: [], index: {}, totalEntries: 0, indexedEntries: 0, pendingEntries: 0, needsRebuild: false });
function sleepRun(id: string, status: 'running' | 'completed', sequences = [1, 2]) {
  return { state: status === 'running' ? 'running' : 'idle', lastRun: {
    id, status, trigger: 'manual', examined: 2, archivedExact: 0, archivedExpired: 0, archivedSimilarity: 0, archivedLlm: 0,
    progressEvents: sequences.map(sequence => ({ sequence, stage: 'similarity', examined: sequence, archivedExact: 0, archivedExpired: 0, archivedSimilarity: 0, archivedLlm: 0, purged: 0 }))
  } };
}
async function fixture(t: TestContext, options: { watchThrows?: boolean; authorize?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'biny-memory-live-audit-'));
  const priorDir = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = root;
  const clock = new Clock(); const watchers: FakeWatcher[] = [];
  const server = new EventEmitter();
  let next: FakeWebSocket | undefined;
  let revision = 0; let sleep: unknown = { state: 'idle' };
  let overviewRead: (() => Promise<unknown>) | undefined;
  let sleepRead: (() => Promise<unknown>) | undefined;
  let embeddingRead: (() => Promise<ReturnType<typeof embedding>>) | undefined;
  const calls = { overview: 0, sleep: 0, embedding: 0, upgrades: 0, authorization: 0 };
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => clock.add(callback, delay, false));
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => clock.add(callback, delay, true));
  t.mock.method(globalThis, 'clearTimeout', (timer: Timer) => clock.timers.delete(timer));
  t.mock.method(globalThis, 'clearInterval', (timer: Timer) => clock.timers.delete(timer));
  t.mock.method(fs, 'watch', (_directory: unknown, callback: FakeWatcher['change']) => {
    if (options.watchThrows) throw new Error('watch unavailable');
    const watcher = new FakeWatcher(callback); watchers.push(watcher); return watcher;
  });
  syncBuiltinESMExports();
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_request: unknown, _socket: unknown, _head: unknown, callback: (ws: FakeWebSocket) => void) => {
    calls.upgrades++; assert.ok(next); callback(next);
  });
  const client: Client = {
    async memory<T>(action: string): Promise<T> {
      if (action === 'overview') { calls.overview++; return (overviewRead ? await overviewRead() : { overview: { revision } }) as T; }
      assert.equal(action, 'sleep-status'); calls.sleep++; return (sleepRead ? await sleepRead() : sleep) as T;
    },
    async memoryEmbeddingStatus() { calls.embedding++; return embeddingRead ? await embeddingRead() : embedding(); }
  };
  const attach = () => attachMemoryWebSocket(server as Parameters<typeof attachMemoryWebSocket>[0], client, () => { calls.authorization++; return options.authorize; });
  let close = await attach();
  t.after(async () => {
    await close(); t.mock.restoreAll(); syncBuiltinESMExports();
    if (priorDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = priorDir;
    await rm(root, { recursive: true, force: true });
  });
  function connect(url = '/ws/memory', ws = new FakeWebSocket()) {
    ws.readyState = WebSocket.OPEN; next = ws;
    const socket = Object.assign(new EventEmitter(), { response: '', destroyed: false, end(value: string) { this.response = value; }, destroy() { this.destroyed = true; } });
    server.emit('upgrade', { url }, socket, Buffer.alloc(0)); return { ws, socket };
  }
  const flush = async () => { clock.fire(50); await settle(); };
  const sample = async () => { clock.fire(1_000); await flush(); };
  return { root, clock, watchers, calls, server, connect, flush, sample,
    setRevision(value: number) { revision = value; }, setSleep(value: unknown) { sleep = value; },
    setOverviewRead(value?: () => Promise<unknown>) { overviewRead = value; },
    setSleepRead(value?: () => Promise<unknown>) { sleepRead = value; },
    setEmbeddingRead(value?: () => Promise<ReturnType<typeof embedding>>) { embeddingRead = value; },
    close: () => close(), async reopen() { close = await attach(); }
  };
}
const types = (ws: FakeWebSocket) => ws.frames.map(frame => frame.type);

test('idle subscriptions perform no reads, watcher and timers are unreferenced', async t => {
  const f = await fixture(t); await f.sample();
  assert.equal(f.calls.overview, 0); assert.equal(f.watchers[0]?.unreferenced, true);
  assert.equal(f.clock.timers.size, 2); assert.ok([...f.clock.timers].every(timer => timer.unreferenced));
});
test('connect publishes exactly three snapshots then deduplicates unchanged samples', async t => {
  const f = await fixture(t); const { ws } = f.connect(); await f.flush(); await f.sample();
  assert.deepEqual(types(ws), ['memory-changed', 'memory-sleep-status', 'memory-embedding-status']);
  assert.ok(ws.frames.every(frame => Number.isFinite(Date.parse(frame.timestamp))));
});
test('watch filters unrelated paths and coalesces SQLite/WAL/SHM and unnamed bursts', async t => {
  const f = await fixture(t); const { ws } = f.connect(); await f.flush(); f.setRevision(1);
  f.watchers[0]!.change('change', 'other.txt'); await f.flush(); assert.equal(f.calls.overview, 1);
  for (const name of ['agent.sqlite', 'agent.sqlite-wal', 'agent.sqlite-shm', null, Buffer.from('agent.sqlite')]) f.watchers[0]!.change('rename', name);
  await f.flush(); assert.equal(f.calls.overview, 2); assert.deepEqual(ws.frames.at(-1)?.data, { revision: 1 });
});
test('file change during pending read schedules one serialized reread', async t => {
  const f = await fixture(t); const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise);
  const { ws } = f.connect(); await f.flush(); f.setRevision(1); f.watchers[0]!.change('change', 'agent.sqlite-wal'); await f.flush();
  assert.equal(f.calls.overview, 1); f.setOverviewRead(); pending.resolve({ overview: { revision: 0 } }); await settle(); await f.flush();
  assert.equal(f.calls.overview, 2); assert.deepEqual(ws.frames.filter(frame => frame.type === 'memory-changed').map(frame => frame.data), [{ revision: 0 }, { revision: 1 }]);
});
test('subscriber joined during pending sample receives snapshots only after a fresh followup sample', async t => {
  const f = await fixture(t); const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise);
  f.connect(); await f.flush(); const { ws } = f.connect(); await f.flush(); pending.resolve({ overview: { revision: 0 } }); f.setOverviewRead(); await settle();
  assert.equal(ws.frames.length, 0, 'new subscriber must not inherit a pre-subscription read'); await f.flush();
  assert.equal(f.calls.overview, 2); assert.equal(ws.frames.length, 3);
});
test('watch construction failure falls back to sampling', async t => {
  const f = await fixture(t, { watchThrows: true }); const { ws } = f.connect(); await f.flush(); f.setRevision(1); await f.sample();
  assert.equal(f.watchers.length, 0); assert.deepEqual(ws.frames.at(-1)?.data, { revision: 1 });
});
test('watch error closes watcher once and sampling keeps publishing', async t => {
  const f = await fixture(t); const { ws } = f.connect(); await f.flush(); f.watchers[0]!.emit('error', new Error('watch failed'));
  f.setRevision(1); await f.sample(); await f.close(); assert.equal(f.watchers[0]!.closed, 1); assert.deepEqual(ws.frames.at(-1)?.data, { revision: 1 });
});
test('closing an individual socket stops its frames; reconnect gets fresh snapshot', async t => {
  const f = await fixture(t); const { ws: old } = f.connect(); await f.flush(); old.terminate(); f.setRevision(1); await f.sample();
  const { ws: fresh } = f.connect(); await f.flush(); assert.equal(old.frames.length, 3); assert.deepEqual(fresh.frames[0]?.data, { revision: 1 });
});
test('close is idempotent and removes timer, watcher, upgrade and client resources', async t => {
  const f = await fixture(t); const { ws } = f.connect(); const first = f.close(); assert.equal(f.close(), first); await first;
  assert.equal(f.clock.timers.size, 0); assert.equal(f.watchers[0]!.closed, 1); assert.equal(f.server.listenerCount('upgrade'), 0); assert.equal(ws.terminations, 1);
  f.watchers[0]!.change('change', 'agent.sqlite'); await f.sample(); assert.equal(f.calls.overview, 0);
});
test('late pending success after close publishes nothing and creates no timer', async t => {
  const f = await fixture(t); const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise); const { ws } = f.connect(); await f.flush();
  f.watchers[0]!.change('change', null); await f.flush(); await f.close(); pending.resolve({ overview: { revision: 1 } }); await settle();
  assert.equal(ws.frames.length, 0); assert.equal(f.clock.timers.size, 0);
});
test('late pending failure after close publishes nothing and creates no timer', async t => {
  const f = await fixture(t); const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise); const { ws } = f.connect(); await f.flush();
  await f.close(); pending.reject(new Error('late host error')); await settle(); assert.equal(ws.frames.length, 0); assert.equal(f.clock.timers.size, 0);
});
test('close and reattach use independent subscription, deduplication and watcher state', async t => {
  const f = await fixture(t); const { ws: old } = f.connect(); await f.flush(); await f.close(); await f.reopen(); const { ws: fresh } = f.connect(); await f.flush();
  assert.equal(old.frames.length, 3); assert.equal(fresh.frames.length, 3); assert.equal(f.watchers.length, 2); assert.equal(f.server.listenerCount('upgrade'), 1);
});
test('heartbeat permits pong responders and terminates silent subscribers', async t => {
  const f = await fixture(t); const { ws: good } = f.connect(); const { ws: silent } = f.connect(); f.clock.fire(30_000); good.emit('pong'); f.clock.fire(30_000);
  assert.equal(good.pings, 2); assert.equal(good.terminations, 0); assert.equal(silent.terminations, 1);
});
test('authorization precedes admission and query tokens do not bypass exact path', async t => {
  const f = await fixture(t, { authorize: 401 }); const rejected = f.connect(); assert.match(rejected.socket.response, /401 Rejected/u); assert.equal(f.calls.upgrades, 0);
});
test('wrong paths, including query token paths, never receive subscriptions', async t => {
  const f = await fixture(t); for (const url of ['/ws/memory?token=test-only', '/ws/memory/', '/other']) assert.match(f.connect(url).socket.response, /404 Rejected/u);
  assert.equal(f.calls.upgrades, 0); await f.flush(); assert.equal(f.calls.overview, 0);
});
test('connection limit rejects 33rd client and permits replacement after close', async t => {
  const f = await fixture(t); const sockets = Array.from({ length: 32 }, () => f.connect().ws); assert.match(f.connect().socket.response, /503 Rejected/u);
  sockets[0]!.terminate(); assert.equal(f.connect().socket.response, ''); assert.equal(f.calls.upgrades, 33);
});
test('client messages enforce read-only close code 1008', async t => {
  const f = await fixture(t); const { ws } = f.connect(); ws.emit('message', 'write'); assert.equal(ws.closeCode, 1008); await f.flush(); assert.equal(f.calls.overview, 0);
});
test('slow or failed consumer is terminated without blocking healthy clients', async t => {
  const f = await fixture(t); const { ws: slow } = f.connect(); slow.bufferedAmount = 1024 * 1024; const { ws: failed } = f.connect(); failed.sendError = new Error('send failed');
  const { ws: good } = f.connect(); await f.flush(); assert.equal(slow.terminations, 1); assert.equal(failed.terminations, 1); assert.equal(good.frames.length, 3);
});
test('source failure is deduplicated; recovery is signalled even when snapshot is unchanged', async t => {
  const f = await fixture(t); const { ws } = f.connect(); await f.flush(); f.setOverviewRead(async () => { throw new Error('host down'); }); await f.sample(); await f.sample();
  assert.equal(types(ws).filter(type => type === 'memory-stream-error').length, 1); f.setOverviewRead(); await f.sample();
  assert.equal(types(ws).filter(type => type === 'memory-stream-ready').length, 1); assert.equal(types(ws).filter(type => type === 'memory-changed').length, 1);
});
test('completed run at initial subscription is snapshot only, running subscription replays phases', async t => {
  const f = await fixture(t); f.setSleep(sleepRun('old', 'completed')); const { ws: old } = f.connect(); await f.flush(); assert.equal(old.frames.length, 3);
  f.setSleep(sleepRun('live', 'running')); const { ws: fresh } = f.connect(); await f.flush(); assert.equal(types(fresh).filter(type => type === 'memory-sleep-progress').length, 2);
  assert.ok(types(fresh).includes('memory-sleep-started'));
});
test('quick completed run is delivered once to existing subscribers, never replayed on reconnect', async t => {
  const f = await fixture(t); const { ws: existing } = f.connect(); await f.flush(); f.setSleep(sleepRun('quick', 'completed')); await f.sample(); await f.sample();
  assert.equal(types(existing).filter(type => type === 'memory-sleep-completed').length, 1); const { ws: fresh } = f.connect(); await f.flush(); assert.equal(fresh.frames.length, 3);
});
test('bounded sleep log advances without duplicating retained sequence keys', async t => {
  const f = await fixture(t); f.setSleep(sleepRun('running', 'running')); const { ws } = f.connect(); await f.flush(); f.setSleep(sleepRun('running', 'running', [2, 3])); await f.sample();
  assert.deepEqual(ws.frames.filter(frame => frame.type === 'memory-sleep-progress').map(frame => frame.data.sequence), [1, 2, 3]);
});
test('pending source blocks shared refresh until it settles (current design limit)', async t => {
  const f = await fixture(t); const pending = deferred<ReturnType<typeof embedding>>(); f.setEmbeddingRead(() => pending.promise); const { ws } = f.connect(); await f.flush();
  f.setRevision(1); await f.sample(); await f.sample(); assert.equal(ws.frames.length, 0); assert.equal(f.calls.overview, 1);
  pending.resolve(embedding()); f.setEmbeddingRead(); await settle(); await f.flush(); assert.equal(f.calls.overview, 2); assert.deepEqual(ws.frames.at(-1)?.data, { revision: 1 });
});

for (const disconnectOriginal of [false, true]) test(`new subscriber after completed Sleep receives no historical lifecycle, disconnectOriginal=${disconnectOriginal}`, async t => {
  const f = await fixture(t); const pending = deferred<ReturnType<typeof embedding>>();
  f.setSleep(sleepRun('completed-before-subscription', 'running')); f.setEmbeddingRead(() => pending.promise);
  const { ws: original } = f.connect(); await f.flush();
  f.setSleep(sleepRun('completed-before-subscription', 'completed'));
  if (disconnectOriginal) original.terminate();
  const { ws: late } = f.connect(); await f.flush();
  f.setEmbeddingRead(); pending.resolve(embedding()); await settle(); await f.flush();
  assert.deepEqual(types(late), ['memory-changed', 'memory-sleep-status', 'memory-embedding-status'], 'completed runs are status-only for late subscribers');
  assert.equal(late.frames[1]?.data.state, 'idle');
  if (!disconnectOriginal) {
    assert.deepEqual(types(original), ['memory-changed', 'memory-sleep-status', 'memory-sleep-started', 'memory-sleep-progress', 'memory-sleep-progress', 'memory-embedding-status', 'memory-sleep-status', 'memory-sleep-completed']);
    assert.deepEqual(original.frames.filter(frame => frame.type === 'memory-sleep-progress').map(frame => frame.data.sequence), [1, 2]);
  }
});

test('clients joining the initial debounce are included when reads actually start', async t => {
  const f = await fixture(t); f.setSleep(sleepRun('live', 'running')); const { ws: first } = f.connect(); const { ws: second } = f.connect(); await f.flush();
  assert.deepEqual(types(first), types(second)); assert.ok(types(second).includes('memory-sleep-started')); assert.equal(f.calls.overview, 1);
});
test('disconnected client identity cannot inherit old reads after synthetic re-admission', async t => {
  const f = await fixture(t); const pending = deferred<ReturnType<typeof embedding>>(); f.setEmbeddingRead(() => pending.promise); f.setSleep(sleepRun('old', 'running'));
  const { ws } = f.connect(); await f.flush(); ws.terminate(); f.setSleep(sleepRun('old', 'completed')); f.connect('/ws/memory', ws); await f.flush();
  pending.resolve(embedding()); f.setEmbeddingRead(); await settle(); assert.equal(ws.frames.length, 0); await f.flush(); assert.equal(ws.frames.length, 3); assert.equal(ws.frames[1]?.data.state, 'idle');
});
test('late subscribers do not inherit pre-subscription errors; fresh recovery keeps existing broadcast semantics', async t => {
  const f = await fixture(t); const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise); const { ws: original } = f.connect(); await f.flush();
  const { ws: late } = f.connect(); await f.flush(); pending.reject(new Error('old failure')); f.setOverviewRead(); await settle();
  assert.ok(types(original).includes('memory-stream-error')); assert.equal(late.frames.length, 0); await f.flush();
  assert.ok(types(original).includes('memory-stream-ready'));
  // Existing source-ready semantics broadcast recovery to the fresh sample's whole recipient group.
  assert.deepEqual(types(late), ['memory-stream-ready', 'memory-changed', 'memory-sleep-status', 'memory-embedding-status']);
});
test('late subscribers do not inherit an in-flight recovery frame', async t => {
  const f = await fixture(t); f.setOverviewRead(async () => { throw new Error('old failure'); }); const { ws: original } = f.connect(); await f.flush();
  const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise); await f.sample(); const { ws: late } = f.connect(); await f.flush();
  pending.resolve({ overview: { revision: 1 } }); f.setRevision(1); f.setOverviewRead(); await settle();
  assert.ok(types(original).includes('memory-stream-ready')); assert.equal(late.frames.length, 0); await f.flush(); assert.equal(late.frames.length, 3); assert.ok(!types(late).includes('memory-stream-ready'));
});
test('old closed group cannot publish into replacement attachment while old request completes', async t => {
  const f = await fixture(t); const pending = deferred<unknown>(); f.setOverviewRead(() => pending.promise); const { ws: old } = f.connect(); await f.flush(); await f.close();
  f.setOverviewRead(); f.setRevision(2); await f.reopen(); const { ws: fresh } = f.connect(); await f.flush(); pending.resolve({ overview: { revision: 0 } }); await settle();
  assert.equal(old.frames.length, 0); assert.equal(fresh.frames.length, 3); assert.deepEqual(fresh.frames[0]?.data, { revision: 2 }); assert.equal(f.clock.timers.size, 2);
});
