import assert from "node:assert/strict";
import { test } from "node:test";
import { constants, readFileSync, promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as zod from "zod";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";
import * as types from "../src/imports/types.js";
import type { ApplicationImportPreview, ApplicationImportSnapshot } from "../src/imports/types.js";

interface SyncFixtureService {
  preview(source: "claude"): Promise<ApplicationImportPreview>;
  configureSyncSelection(options: { previewId: string; itemIds: string[]; workspaceRoot: string }): Promise<ApplicationImportSnapshot>;
  setSyncEnabled(enabled: boolean): Promise<ApplicationImportSnapshot>;
  sync(): Promise<ApplicationImportSnapshot>;
}
interface SyncFixtureOptions {
  homeDir: string;
  stateRoot: string;
  configStore: { load(): never; save(): never };
}

// Exercise the complete service with real scanning, source/state files and locking.
// Initial parsing and destination persistence are explicit inert boundaries: these
// tests prove sync admission/reporting, not end-to-end imported session storage.
const source = readFileSync(fileURLToPath(new URL("../src/imports/service.ts", import.meta.url)), "utf8");
const deny = (name: string) => () => { throw new Error(`Unexpected boundary: ${name}`); };
function serviceConstructor(admitted: string[]) {
  const imports: Record<string, unknown> = {
    "node:crypto": crypto, "node:fs": { constants, promises: fs }, "node:os": os, "node:path": path, zod,
    "../config/paths.js": { globalConfigDir: deny("global config") },
    "../utils/localFileLock.js": { withLocalFileWriteLock },
    "../session/transfer.js": {
      parseSessionImport: (content: string) => ({ content }),
      parsePreparedChatGptImport: deny("ChatGPT parse"),
      persistImportedSession: async (_workspace: string, parsed: { content: string }) => {
        admitted.push(parsed.content);
        return { sessionId: crypto.randomUUID(), skippedContentCount: 0, attachmentsSkipped: 0 };
      },
      SessionImportCleanupError: class extends Error {}
    },
    "../session/store.js": { ensureAgentDirs: async () => {} },
    "../session/import/chatgpt.js": { prepareChatGptSource: deny("ChatGPT source") },
    "./configuration.js": { discoverConfigurationImports: async () => [] },
    "./types.js": types
  };
  const exports: Record<string, unknown> = {};
  const context = vm.createContext({ exports, Buffer, structuredClone, require: (name: string) => {
    if (!Object.hasOwn(imports, name)) throw new Error(`Unreviewed import: ${name}`);
    return imports[name];
  } });
  const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInContext(emitted, context, { timeout: 2_000 });
  return exports.ApplicationImportService as new (options: SyncFixtureOptions) => SyncFixtureService;
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-partial-import-sync-")));
  const homeDir = path.join(root, "home"), stateRoot = path.join(root, "state");
  const sourceDir = path.join(homeDir, ".claude", "projects", "fixture");
  await fs.mkdir(sourceDir, { recursive: true });
  const admitted: string[] = [];
  const Constructor = serviceConstructor(admitted);
  const service = new Constructor({ homeDir, stateRoot, configStore: { load: deny("config read"), save: deny("config write") } });
  const one = path.join(sourceDir, "one.jsonl"), two = path.join(sourceDir, "two.jsonl");
  const content = (name: string) => JSON.stringify({ uuid: name, type: "user", message: { role: "user", content: name } }) + "\n";
  await fs.writeFile(one, content("one")); await fs.writeFile(two, content("two"));
  const preview = await service.preview("claude");
  assert.equal(preview.items.length, 2);
  const oneId = preview.items.find(item => item.detail.endsWith("one.jsonl"))!.id;
  const twoId = preview.items.find(item => item.detail.endsWith("two.jsonl"))!.id;
  let workspaces = 0;
  return { service, admitted, one, two, oneId, twoId, content,
    async select(ids: string[]) {
      const workspaceRoot = path.join(root, `workspace-${++workspaces}`);
      await fs.mkdir(workspaceRoot);
      await service.configureSyncSelection({ previewId: preview.id, itemIds: ids, workspaceRoot });
    },
    async close() { await fs.rm(root, { recursive: true, force: true }); }
  };
}

test("partially missing selection warns while importing only its available selected item", async () => {
  const f = await fixture(); try {
    await f.select([f.oneId, f.twoId]); await f.service.setSyncEnabled(true); await fs.unlink(f.one);
    const result = await f.service.sync();
    assert.ok(result.sync.lastError); assert.deepEqual(f.admitted, [f.content("two")]);
    assert.deepEqual(result.history[0]!.results.map(item => [item.id, item.status]), [[f.twoId, "imported"]]);
    assert.deepEqual(result.sync.selections![0]!.itemIds, [f.oneId, f.twoId]);
  } finally { await f.close(); }
});
test("all unavailable selected items warn and never admit an unselected discovered item", async () => {
  const f = await fixture(); try {
    await f.select([f.oneId]); await f.service.setSyncEnabled(true); await fs.unlink(f.one);
    const result = await f.service.sync(); assert.ok(result.sync.lastError);
    assert.equal(result.history.length, 0); assert.deepEqual(f.admitted, []);
  } finally { await f.close(); }
});
test("a complete selection imports normally without a warning and deduplicates the next sync", async () => {
  const f = await fixture(); try {
    await f.select([f.oneId, f.twoId]); await f.service.setSyncEnabled(true);
    const result = await f.service.sync(); assert.equal(result.sync.lastError, undefined); assert.equal(f.admitted.length, 2);
    const repeat = await f.service.sync(); assert.equal(repeat.sync.lastError, undefined); assert.equal(f.admitted.length, 2);
    assert.ok(repeat.history[0]!.results.every(item => item.status === "skipped"));
  } finally { await f.close(); }
});
for (const partialFirst of [true, false]) test(`partial selection warning survives other complete selections (${partialFirst})`, async () => {
  const f = await fixture(); try {
    const partial = [f.oneId, f.twoId], complete = [f.twoId];
    await f.select(partialFirst ? partial : complete); await f.select(partialFirst ? complete : partial);
    await f.service.setSyncEnabled(true); await fs.unlink(f.one);
    const result = await f.service.sync(); assert.ok(result.sync.lastError);
    assert.equal(result.history.length, 2); assert.equal(f.admitted.length, 2);
    assert.ok(result.history.every(history => history.results.length === 1 && history.results[0]!.id === f.twoId));
  } finally { await f.close(); }
});
test("restored selected source clears the prior warning on the next sync", async () => {
  const f = await fixture(); try {
    await f.select([f.oneId, f.twoId]); await f.service.setSyncEnabled(true); await fs.unlink(f.one);
    assert.ok((await f.service.sync()).sync.lastError);
    await fs.writeFile(f.one, f.content("one"));
    const restored = await f.service.sync(); assert.equal(restored.sync.lastError, undefined);
    assert.deepEqual(f.admitted, [f.content("two"), f.content("one")]);
  } finally { await f.close(); }
});
