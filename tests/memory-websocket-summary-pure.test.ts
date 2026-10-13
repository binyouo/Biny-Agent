/** Fixed AST selections with inert clients/sockets: no product imports, database, network or timers. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(new URL(`../src/runtime/host/${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(file: ts.SourceFile, name: string, kind: "function" | "variable"): string {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (kind === "function" && ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    if (kind === "variable" && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, `${file.fileName}:${name}`);
  const text = matches[0]!.getText(file).replace(/^export\s+/u, "");
  return kind === "variable" ? `const ${text};` : text;
}
function script(text: string): Script {
  const emitted = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
  });
  assert.equal(emitted.diagnostics?.length ?? 0, 0);
  assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b/.test(emitted.outputText), false);
  return new Script(emitted.outputText);
}
const operations = source("operations.ts");
const protocol = source("protocol.ts");
const memoryOperations = source("memory-operations.ts");
const validation = source("validation.ts");
const websocket = source("memory-websocket.ts");
const domainScript = script([
  declaration(validation, "requiredString", "function"),
  declaration(memoryOperations, "executeRuntimeHostMemoryOperation", "function"),
  declaration(operations, "memoryQueryActions", "variable"),
  declaration(operations, "operationLane", "function"),
  declaration(protocol, "runtimeHostMaxFrameBytes", "variable"),
  declaration(protocol, "encodeHostFrame", "function"),
  "globalThis.selected = { executeRuntimeHostMemoryOperation, operationLane, runtimeHostMaxFrameBytes, encodeHostFrame };"
].join("\n"));
const refreshScript = script([
  "let closed = false, pending = false, dirty = false;",
  declaration(websocket, "maxBufferedBytes", "variable"),
  declaration(websocket, "publish", "variable"),
  declaration(websocket, "refresh", "variable"),
  "globalThis.refresh = refresh;"
].join("\n"));
type Summary = { storeRevision: number; entryCount: number };
type Payload = Record<string, unknown>;
interface Selected {
  executeRuntimeHostMemoryOperation(context: unknown, payload: Payload): Promise<unknown>;
  operationLane(operation: string, payload: Payload): string;
  runtimeHostMaxFrameBytes: number;
  encodeHostFrame(frame: unknown): string;
}
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

function domain(large = false) {
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  domainScript.runInContext(context, { timeout: 1_000 });
  const selected = context.selected as Selected;
  const summary: Summary = { storeRevision: 7, entryCount: large ? 2_100 : 1 };
  const entries = { entries: Array.from({ length: summary.entryCount }, (_, index) => ({
    id: `entry-${index}`, content: large ? `Independent fact ${index}: `.padEnd(2_000, "x") : "Small fact"
  })), total: summary.entryCount, storeRevision: summary.storeRevision };
  const maintenance = { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
  const calls = { overview: 0, entries: 0, maintenance: 0 };
  const memory = {
    async getOverview() { calls.overview++; return { ...summary }; },
    async listMemoryEntries() { calls.entries++; return entries; },
    async loadMaintenanceStatus() { calls.maintenance++; return maintenance; }
  };
  const operationContext = { getCommands: () => ({ agent: { getLocalMemory: () => memory } }),
    scheduleEmbeddingRebuild: () => assert.fail("No rebuild expected") };
  const execute = (payload: Payload) => selected.executeRuntimeHostMemoryOperation(operationContext, payload);
  return { selected, summary, entries, maintenance, calls, memory, execute };
}

test("summary-only overview reads no entries or maintenance and stays below the Host frame cap", async () => {
  const d = domain(true);
  d.memory.listMemoryEntries = async () => assert.fail("Summary must not read entry bodies");
  d.memory.loadMaintenanceStatus = async () => assert.fail("Summary must not read maintenance");
  const result = await d.execute({ action: "overview", summaryOnly: true });
  assert.deepEqual(plain(result), { overview: d.summary });
  assert.deepEqual(d.calls, { overview: 1, entries: 0, maintenance: 0 });
  const frame = d.selected.encodeHostFrame({ kind: "response", requestId: "summary", ok: true, result });
  assert.ok(Buffer.byteLength(frame) < 256);
  assert.equal(d.selected.operationLane("memory", { action: "overview", summaryOnly: true }), "query");
});

test("default, false and other truthy flags preserve the complete overview contract", async () => {
  for (const flag of [undefined, false, "true", 1]) {
    const d = domain();
    const payload: Payload = { action: "overview" };
    if (flag !== undefined) payload.summaryOnly = flag;
    const result = await d.execute(payload) as { overview: Summary; entries: unknown; allEntries: unknown; maintenance: unknown };
    assert.deepEqual(plain(result), { overview: d.summary, entries: d.entries,
      allEntries: d.entries, maintenance: d.maintenance });
    assert.equal(result.entries, result.allEntries);
    assert.deepEqual(d.calls, { overview: 1, entries: 1, maintenance: 1 });
    assert.equal(d.selected.operationLane("memory", payload), "query");
  }
});

function stream(d: ReturnType<typeof domain>) {
  const frames: Array<{ type: string; data: unknown }> = [];
  const requests: Array<{ action: string; payload: Payload }> = [];
  let overviewError: Error | undefined;
  let terminated = 0;
  const socket = { readyState: 1, bufferedAmount: 0,
    send(value: string, done: (error?: Error) => void) { frames.push(JSON.parse(value) as { type: string; data: unknown }); done(); },
    terminate() { terminated++; } };
  const states = new Map([[socket, { last: new Map<string, string>(), alive: true,
    sleepInitialized: false, sleepReplayEligible: false }]]);
  const client = {
    async memory(action: string, payload: Payload = {}) {
      requests.push({ action, payload: plain(payload) as Payload });
      if (action === "sleep-status") return d.maintenance;
      assert.equal(action, "overview");
      if (overviewError) throw overviewError;
      return await d.execute({ action, ...payload });
    },
    async memoryEmbeddingStatus() { return { models: [], needsRebuild: false }; }
  };
  const context = createContext({ states, client, WebSocket: Object.freeze({ OPEN: 1 }),
    Buffer: Object.freeze({ byteLength: Buffer.byteLength }),
    scheduleRefresh: () => assert.fail("No concurrent refresh expected"), Error
  }, { codeGeneration: { strings: false, wasm: false } });
  refreshScript.runInContext(context, { timeout: 1_000 });
  return { frames, requests, refresh: context.refresh as () => Promise<void>,
    failOverview(error?: Error) { overviewError = error; }, terminated: () => terminated };
}

test("actual WebSocket refresh requests only summary data, preserves payloads and deduplicates", async () => {
  const d = domain(true);
  const full = await d.execute({ action: "overview" });
  assert.ok(Buffer.byteLength(d.selected.encodeHostFrame({ kind: "response", requestId: "full", ok: true, result: full }))
    > d.selected.runtimeHostMaxFrameBytes, "the legal large fixture exceeds the old full-overview wire budget");
  d.calls.entries = 0; d.calls.maintenance = 0; d.calls.overview = 0;
  const s = stream(d);
  await s.refresh();
  await s.refresh();
  assert.deepEqual(s.requests.filter(request => request.action === "overview"), [
    { action: "overview", payload: { summaryOnly: true } }, { action: "overview", payload: { summaryOnly: true } }
  ]);
  assert.deepEqual(d.calls, { overview: 2, entries: 0, maintenance: 0 });
  assert.deepEqual(s.frames.map(({ type, data }) => ({ type, data })), [
    { type: "memory-changed", data: { ...d.summary } },
    { type: "memory-sleep-status", data: d.maintenance },
    { type: "memory-embedding-status", data: { models: [], needsRebuild: false } }
  ]);
  d.summary.storeRevision++; d.summary.entryCount++;
  await s.refresh();
  assert.deepEqual(s.frames.at(-1)?.data, d.summary);
  assert.equal(s.terminated(), 0);
});

test("summary read failure remains source-scoped and recovery retains existing notifications", async () => {
  const d = domain();
  const s = stream(d);
  s.failOverview(new Error("summary unavailable"));
  await s.refresh(); await s.refresh();
  assert.deepEqual(s.frames.map(frame => frame.type), ["memory-stream-error", "memory-sleep-status", "memory-embedding-status"]);
  assert.deepEqual(s.frames[0]?.data, { source: "memory", error: "summary unavailable" });
  assert.equal(s.requests.filter(request => request.action === "overview").every(request => request.payload.summaryOnly === true), true);
  s.failOverview();
  await s.refresh();
  assert.deepEqual(s.frames.slice(-2).map(frame => frame.type), ["memory-stream-ready", "memory-changed"]);
  assert.deepEqual(s.frames.at(-1)?.data, d.summary);
});
