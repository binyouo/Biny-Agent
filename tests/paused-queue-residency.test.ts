/** Inert source fixtures only: no runtime, Host, SQLite, provider or product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(resolve(root, path), "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(file: ts.SourceFile, name: string): ts.ClassDeclaration | ts.FunctionDeclaration {
  const node = file.statements.find((statement) =>
    (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name?.text === name);
  assert.ok(node && (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)), name);
  return node;
}
function extracted(file: ts.SourceFile, name: string): string {
  return declaration(file, name).getText(file).replace(/^export\s+/u, "");
}
const registrySource = source("src/runtime/host/registry.ts");
const serverSource = source("src/runtime/host/server.ts");
const eventsSource = source("src/runtime/agentEvents.ts");
const server = declaration(serverSource, "RuntimeHostServer");
assert.ok(ts.isClassDeclaration(server));
const method = server.members.find((member) =>
  ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "retireIfIdle");
assert.ok(method && ts.isMethodDeclaration(method));
const fixtureSource = [
  extracted(eventsSource, "runtimeIsBusy"),
  extracted(registrySource, "SessionRuntimeRegistry"),
  `class RetirementFixture { ${method.getText(serverSource)} }`,
  "({ Registry: SessionRuntimeRegistry, retire: RetirementFixture.prototype.retireIfIdle });"
].join("\n");
const transpiled = ts.transpileModule(fixtureSource, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal(transpiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length ?? 0, 0,
  "extracted source must transpile without errors");
const javascript = transpiled.outputText;

interface Snapshot {
  info: { sessionId: string };
  state: { kind: "idle" | "runs" };
  queuedMessages?: { messageId: string; content: string; attachmentCount: number }[];
}
interface Runtime {
  snapshot: Snapshot;
  closed: number;
  closeHook?: () => Promise<void>;
  getSnapshot(): Snapshot;
  subscribe(): () => void;
  close(): Promise<void>;
}
interface Entry {
  sessionId: string;
  runtime: Runtime;
  commands: { managedProcesses?: { list(): Promise<unknown[]> } };
  primary: boolean;
  lastActiveAt: number;
}
interface Registry {
  get(sessionId: string): Entry | undefined;
  list(): Entry[];
  ensure(sessionId: string): Promise<Entry>;
  evictIdle(count?: number): Promise<string[]>;
  closeSession(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}
interface RegistryOptions {
  sessionRuntimeCacheTarget?: number;
  createRuntime(sessionId: string): Promise<{ runtime: Runtime; commands: Entry["commands"] }>;
  onUpdate(): void;
}
interface RetiringHost {
  closePromise?: Promise<void>;
  pendingRequests: number;
  activityRevision: number;
  idleSince?: number;
  retiring: boolean;
  registry: { list(): Entry[] };
  businessComposition: { hasActiveWork(): boolean };
  hasRetainingConnections(): boolean;
  closeOwner(): Promise<void>;
}
interface Extracted {
  Registry: new (initial: { runtime: Runtime; commands: Entry["commands"] }, options: RegistryOptions) => Registry;
  retire: (this: RetiringHost, graceMs?: number) => Promise<boolean>;
}
function subject() {
  let now = 0;
  const loaded = runInNewContext(javascript, { performance: { now: () => now } }, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as Extracted;
  return { ...loaded, advance: (milliseconds: number) => { now += milliseconds; } };
}
function runtime(sessionId: string, queued = false): Runtime {
  const result: Runtime = {
    snapshot: { info: { sessionId }, state: { kind: "idle" }, queuedMessages: [] },
    closed: 0,
    getSnapshot() { return this.snapshot; },
    subscribe: () => () => {},
    async close() { this.closed += 1; await this.closeHook?.(); }
  };
  if (queued) enqueue(result);
  return result;
}
function enqueue(target: Runtime): void {
  target.snapshot.queuedMessages = [{ messageId: "pending", content: "retained after pause", attachmentCount: 0 }];
}
function registryFixture(target?: number) {
  const loaded = subject();
  const runtimes = new Map<string, Runtime>();
  const primary = runtime("primary");
  const registry = new loaded.Registry({ runtime: primary, commands: {} }, {
    sessionRuntimeCacheTarget: target,
    createRuntime: async (sessionId) => {
      const item = runtime(sessionId);
      runtimes.set(sessionId, item);
      return { runtime: item, commands: {} };
    },
    onUpdate() {}
  });
  return { registry, primary, runtimes };
}
function retirementFixture(queuedIndex: number | undefined) {
  const loaded = subject();
  const runtimes = [runtime("primary"), runtime("secondary")];
  if (queuedIndex !== undefined) enqueue(runtimes[queuedIndex]!);
  let closes = 0;
  const entries: Entry[] = runtimes.map((item, index) => ({
    sessionId: item.snapshot.info.sessionId, runtime: item, commands: {}, primary: index === 0, lastActiveAt: 0
  }));
  const host: RetiringHost = {
    pendingRequests: 0, activityRevision: 0, retiring: false,
    registry: { list: () => entries },
    businessComposition: { hasActiveWork: () => false },
    hasRetainingConnections: () => false,
    closeOwner: async () => { closes += 1; }
  };
  return { ...loaded, runtimes, entries, host, closes: () => closes };
}

test("default cache pressure retains queued secondary sessions without blocking admission", async () => {
  const f = registryFixture(); // Production default is eight, including primary.
  enqueue(f.primary);
  for (let i = 1; i <= 7; i += 1) {
    const entry = await f.registry.ensure(`session-${i}`);
    enqueue(entry.runtime);
  }
  await f.registry.ensure("ninth");
  assert.equal(f.registry.list().length, 9);
  assert.equal(f.primary.closed, 0);
  for (const item of f.runtimes.values()) assert.equal(item.closed, 0);
  assert.equal(f.registry.get("session-1")?.runtime.snapshot.queuedMessages?.length, 1);
});

test("empty idle sessions evict; removing a pending queue permits eviction", async () => {
  const f = registryFixture(2);
  const first = await f.registry.ensure("first");
  enqueue(first.runtime);
  await f.registry.ensure("second");
  assert.equal(f.registry.list().length, 3);
  assert.deepEqual([...await f.registry.evictIdle()], ["second"]);
  first.runtime.snapshot.queuedMessages = [];
  assert.deepEqual([...await f.registry.evictIdle()], ["first"]);
  assert.equal(first.runtime.closed, 1);
  assert.equal(f.primary.closed, 0);
});

test("eviction rechecks a queue added while the previous runtime closes", async () => {
  const f = registryFixture(3);
  const first = await f.registry.ensure("first");
  const second = await f.registry.ensure("second");
  first.lastActiveAt = 1;
  second.lastActiveAt = 2;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const closing = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  first.runtime.closeHook = async () => { entered(); await gate; };
  const eviction = f.registry.evictIdle(2);
  await closing;
  enqueue(second.runtime);
  release();
  assert.deepEqual([...await eviction], ["first"]);
  assert.strictEqual(f.registry.get("second"), second);
  assert.equal(second.runtime.closed, 0);
});

test("explicit close remains allowed for queued sessions and the primary owner", async () => {
  const f = registryFixture(2);
  const secondary = await f.registry.ensure("secondary");
  enqueue(secondary.runtime);
  enqueue(f.primary);
  await f.registry.closeSession("secondary");
  assert.equal(secondary.runtime.closed, 1);
  await f.registry.closeAll();
  assert.equal(f.primary.closed, 1);
});

for (const index of [0, 1]) {
  test(`queued ${index === 0 ? "primary" : "secondary"} prevents automatic retirement`, async () => {
    const f = retirementFixture(index);
    assert.equal(await f.retire.call(f.host, 0), false);
    assert.equal(f.closes(), 0);
    assert.equal(f.host.idleSince, undefined);
    f.runtimes[index]!.snapshot.queuedMessages = [];
    assert.equal(await f.retire.call(f.host, 0), true);
    assert.equal(f.closes(), 1);
  });
}

test("a retained queue resets the idle grace period", async () => {
  const f = retirementFixture(undefined);
  assert.equal(await f.retire.call(f.host, 100), false);
  assert.equal(f.host.idleSince, 0);
  f.advance(100);
  enqueue(f.runtimes[1]!);
  assert.equal(await f.retire.call(f.host, 100), false);
  assert.equal(f.host.idleSince, undefined);
  f.runtimes[1]!.snapshot.queuedMessages = [];
  assert.equal(await f.retire.call(f.host, 100), false);
  f.advance(99);
  assert.equal(await f.retire.call(f.host, 100), false);
  f.advance(1);
  assert.equal(await f.retire.call(f.host, 100), true);
  assert.equal(f.closes(), 1);
});

test("a queue arriving during the asynchronous retirement scan retains the Host", async () => {
  const f = retirementFixture(undefined);
  f.entries[1]!.commands.managedProcesses = {
    list: async () => { enqueue(f.runtimes[1]!); f.host.activityRevision += 1; return []; }
  };
  assert.equal(await f.retire.call(f.host, 0), false);
  assert.equal(f.closes(), 0);
});
