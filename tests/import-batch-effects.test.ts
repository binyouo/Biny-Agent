import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";
import * as zod from "zod";
import type { ApplicationImportSnapshot } from "../src/imports/types.js";

// The VM is an explicit fail-closed import boundary, not full application integration.
// Source discovery, filesystem persistence and native locking are inert adapters.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const deny = (name: string) => () => { throw new Error(`Forbidden effect: ${name}`); };
const fakeRoot = '/synthetic-import-fixture';
function guard(p: string) { assert.ok(p === fakeRoot || p.startsWith(`${fakeRoot}/`), `Non-fixture path: ${p}`); return p; }
const fs = {
  mkdir: async (p: string) => { guard(p); },
  realpath: async (p: string) => guard(p),
  stat: async (p: string) => { guard(p); return { isDirectory: () => true }; },
  lstat: async (p: string) => { guard(p); return { isDirectory: () => true, isSymbolicLink: () => false }; }
};
const forbiddenProxy = new Proxy({}, { get: (_, key) => deny(String(key)) });
function load(relative: string, imports: Record<string, unknown> = {}): Record<string, any> {
  const filename = path.join(root, relative);
  const source = readFileSync(filename, 'utf8');
  const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports: Record<string, any> = {};
  const context = vm.createContext({ exports, structuredClone, Buffer, setInterval: deny('timer'), clearInterval: deny('timer'), require: (name: string) => {
    if (!Object.hasOwn(imports, name)) throw new Error(`Unreviewed module import: ${name}`);
    return imports[name];
  } });
  vm.runInContext(emitted, context, { filename, timeout: 2000 });
  return exports;
}
const types = load('src/imports/types.ts');
const { ApplicationImportService } = load('src/imports/service.ts', {
  'node:crypto': crypto, 'node:fs': { constants: {}, promises: fs },
  'node:os': { homedir: deny('real home') }, 'node:path': path, zod,
  '../config/paths.js': { globalConfigDir: deny('global config') },
  '../utils/syncDirectory.js': { syncDirectory: deny('directory sync') },
  '../utils/localFileLock.js': { withLocalFileWriteLock: async (root: string, name: string, action: () => Promise<unknown>) => { guard(root); assert.equal(name, '.imports.lock'); return action(); } },
  '../session/transfer.js': { ...forbiddenProxy, SessionImportCleanupError: class extends Error {} },
  '../session/store.js': forbiddenProxy, '../session/import/chatgpt.js': forbiddenProxy,
  './configuration.js': forbiddenProxy, './types.js': types
});
const { DesktopApplicationImports } = load('src/desktop/electron/main/DesktopApplicationImports.ts');

async function fixture(count: number, position: 'early' | 'late', outcome: 'imported' | 'skipped' | 'unknown' = 'imported', failure?: 'later-admission' | 'final-persistence') {
  let persisted: any = { version: 1, previews: [], history: [], receipts: [], sync: { enabled: false, selections: [] } };
  let failureUsed = false; let syncStarted = false;
  let config = { imported: false }; let writes = 0; let refreshes = 0; let applications = 0;
  const store = { configPath: () => `${fakeRoot}/config.json`, load: async () => structuredClone(config), save: deny('unversioned write'),
    loadVersioned: async () => ({ config: structuredClone(config), revision: String(writes) }),
    saveVersioned: async (next: { imported: boolean }, expected: string) => { assert.equal(expected, String(writes)); writes++; config = next; return { config, revision: String(writes) }; } };
  const service = new ApplicationImportService({ configStore: store, homeDir: `${fakeRoot}/home`, stateRoot: `${fakeRoot}/state` });
  // Guarded extraction seams: no real source discovery, state I/O or native lock.
  // Actual public admission, sync, execute, receipt and withState logic are retained.
  service.readState = async () => structuredClone(persisted);
  service.writeState = async (state: any) => {
    if (syncStarted && !failureUsed && failure === 'later-admission' && state.receipts.some((r: any) => r.itemId === 'effect' && r.status === 'imported') && state.receipts.some((r: any) => r.itemId === 'skip' && r.status === 'attempting')) {
      failureUsed = true; throw new Error('synthetic later admission failure');
    }
    if (syncStarted && !failureUsed && failure === 'final-persistence' && state.receipts.some((r: any) => r.status === 'imported') && JSON.stringify(state) === JSON.stringify(persisted)) {
      failureUsed = true; throw new Error('synthetic final persistence failure');
    }
 assert.ok(state.history.length <= 50); assert.ok(state.sync.selections.length <= 256); persisted = structuredClone(state); };
  const item = (id: string) => ({ id, configurationId: id, category: 'mcp', label: id, detail: 'synthetic', sourceHash: 'a'.repeat(64), digest: 'a'.repeat(64) });
  service.scan = async () => { syncStarted = true; return ({ preview: { id: crypto.randomUUID(), source: 'claude', label: 'fixture', items: [item('effect'), item('skip')], warnings: [] }, contents: new Map(), configurations: new Map([
    ['skip', { apply: async () => ({ status: 'skipped' }) }],
    ['effect', { apply: async (_workspace: string, store: any) => {
      applications++;
      if (outcome === 'unknown') throw new Error('synthetic uncertain write');
      if (outcome === 'skipped') return { status: 'skipped' };
      const prior = await store.loadVersioned();
      await store.saveVersioned({ imported: true }, prior.revision);
      return { status: 'imported' };
    } }]
  ]) }); };
  const preview = await service.preview('claude');
  for (let i = 0; i < count; i++) await service.configureSyncSelection({ previewId: preview.id, itemIds: failure === 'later-admission' ? ['effect', 'skip'] : [position === 'early' || i === count - 1 ? 'effect' : 'skip'], workspaceRoot: `${fakeRoot}/workspace-${i}` });
  await service.setSyncEnabled(true);
  const controller = new DesktopApplicationImports(service, async () => {}, async () => { assert.equal(persisted.receipts.some((r: any) => r.status === 'imported'), true); refreshes++; });
  return { controller, read: () => ({ persisted, config, writes, refreshes, applications }) };
}

for (const count of [49, 50, 51]) for (const position of ['early', 'late'] as const) {
  test(`${count} selections / ${position} MCP commit refreshes exactly once; unchanged repeat does not replay`, async () => {
    const f = await fixture(count, position);
    try {
      const first: ApplicationImportSnapshot = await f.controller.sync();
      const after = structuredClone(f.read());
      assert.equal(first.history.length, Math.min(count, 50));
      assert.equal(after.writes, 1);
      assert.equal(after.persisted.receipts.filter((r: any) => r.itemId === 'effect' && r.status === 'imported').length, 1);
      await f.controller.sync();
      assert.equal(f.read().writes, 1);
      assert.equal(f.read().applications, 1);
      assert.equal(f.read().refreshes, after.refreshes, 'unchanged sync must never replay effects');
      assert.equal(after.refreshes, 1, `Committed MCP effect lost at count=${count}, position=${position}`);
    } finally { await f.controller.close(); }
  });
}
for (const outcome of ['skipped', 'unknown'] as const) test(`51 ${outcome} outcomes never refresh and unchanged repeat never retries apply`, async () => {
  const f = await fixture(51, 'early', outcome);
  try {
    const first: ApplicationImportSnapshot = await f.controller.sync();
    assert.equal(first.history.length, 50);
    assert.equal(first.history.every(h => h.results[0]?.status === outcome), true);
    assert.equal(f.read().applications, 1);
    await f.controller.sync();
    assert.equal(f.read().applications, 1);
    assert.equal(f.read().writes, 0);
    assert.equal(f.read().refreshes, 0);
  } finally { await f.controller.close(); }
});


test("a committed MCP still refreshes if a later item admission fails in the same selection", async () => {
  const f = await fixture(1, 'early', 'imported', 'later-admission');
  try {
    const result: ApplicationImportSnapshot = await f.controller.sync();
    assert.equal(f.read().writes, 1);
    assert.equal(f.read().refreshes, 1);
    assert.equal(result.history[0]?.results[0]?.status, 'imported');
    assert.equal(result.history[0]?.results[1]?.status, 'unknown');
    assert.ok(result.sync.lastError);
  } finally { await f.controller.close(); }
});

test("enclosing persistence rejection never delivers a committed-effect summary to the controller", async () => {
  const f = await fixture(1, 'early', 'imported', 'final-persistence');
  try {
    await assert.rejects(f.controller.sync(), /synthetic final persistence failure/u);
    assert.equal(f.read().writes, 1);
    assert.equal(f.read().refreshes, 0);
  } finally { await f.controller.close(); }
});
