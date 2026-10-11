import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute only these source-extracted methods, never a product module or SDK.
// Client, connection, registry, cache and catalog publication are inert doubles.
// Registry assertions establish publication/order, not real ToolRegistry behavior.
const source = readFileSync(new URL("../src/extensions/mcp.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("mcp.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const classes = parsed.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "McpToolHost");
assert.equal(classes.length, 1);
const names = ["startServer", "tryConnect", "listAllTools", "refreshServerTools", "reconnect", "close"];
const extracted = names.map((name) => {
  const matches = classes[0]!.members.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `Expected one ${name}`);
  assert.ok(matches[0]!.body);
  return matches[0]!.getText(parsed);
});
const isolated = stripTypeScriptTypes(`class IsolatedMcpMethods { ${extracted.join("\n")} }\nIsolatedMcpMethods.prototype;`, { mode: "strip" });

interface Tool { name: string }
interface Listed { tools: Tool[]; nextCursor?: string }
interface Config { args: string[]; startupTimeoutMs: number; timeoutMs: number; credentialRefs?: Record<string, Record<string, string>> }
interface Status {
  enabled: boolean; connected: boolean; connecting: boolean; catalogCached: boolean;
  toolNames: string[]; promptNames: string[]; hasResources: boolean;
  command?: string; instructions?: string; lastError?: string; authRequired?: boolean;
}
interface Managed {
  name: string; rawConfig: Config; config: Config; transport: string; status: Status;
  tools: Tool[]; client?: FakeClient; catalogKey?: string; connecting?: Promise<void>;
  refreshing?: Promise<void>; refreshDirty?: boolean; closeTransport?: () => Promise<void>;
}
interface Opened { client: FakeClient; tools: Tool[]; activateToolNotifications?: () => void }
interface Host {
  closing: boolean; servers: Map<string, Managed>; openingClients: Set<FakeClient>; workspaceRoot: string;
  catalogCache: Cache; registry: { unregister(name: string): void };
  startServer(managed: Managed): Promise<void>; tryConnect(managed: Managed, transport: object, signal: AbortSignal): Promise<Opened>;
  listAllTools(managed: Managed, client: FakeClient, signal?: AbortSignal): Promise<Tool[]>;
  refreshServerTools(managed: Managed): Promise<void>; reconnect(managed: Managed): Promise<void>; close(): Promise<void>;
  openClient(managed: Managed, signal: AbortSignal): Promise<Opened>;
  registerServerTools(managed: Managed, tools: Tool[], instructions?: string): void;
  listPromptNames(managed: Managed, client: FakeClient, signal: AbortSignal): Promise<string[]>;
  requestOptions(managed: Managed): { timeout: number };
  emitChange(): void;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const textError = (error: unknown): string => error instanceof Error ? error.message : String(error);
class Cache {
  entries = new Map<string, { tools: Tool[]; instructions?: string }>();
  get(key: string) { return this.entries.get(key); }
  set(key: string, tools: Tool[], instructions?: string) { this.entries.set(key, { tools: structuredClone(tools), instructions }); }
  captureInvalidation(key: string) {
    const entry = this.entries.get(key);
    return () => { if (entry && this.entries.get(key) === entry) this.entries.delete(key); };
  }
}
interface RequestRecord {
  cursor?: string; snapshot: Listed; settled: boolean;
  resolve(result?: Listed): void; reject(error: Error): void;
}
interface Plan { hold?: boolean; result?: Listed; error?: Error }
interface Controls {
  clients: FakeClient[]; tools: Tool[]; plans: Plan[]; requests: RequestRecord[];
  connectHook?: (client: FakeClient) => void;
  holdPrompts: boolean; promptEntered: ReturnType<typeof gate<void>>; promptReply: ReturnType<typeof gate<void>>;
  onRegister?: () => void;
}
class FakeClient {
  readonly controls: Controls;
  transport: object | undefined;
  onclose?: () => void;
  handler?: () => void;
  closeCount = 0;
  requests: RequestRecord[] = [];
  constructor(controls: Controls) { this.controls = controls; controls.clients.push(this); }
  setNotificationHandler(_schema: object, handler: () => void) { this.handler = handler; }
  async connect(transport: object, options: { signal: AbortSignal }) {
    options.signal.throwIfAborted();
    this.transport = transport;
    this.controls.connectHook?.(this);
  }
  // Mirrors SDK 1.31.0: capture the current handler immediately, invoke it in a
  // microtask; absent handlers are dropped, not queued for later registration.
  notify(): void { const handler = this.handler; if (handler) void Promise.resolve().then(handler); }
  captureNotification(): () => void { const handler = this.handler; return () => handler?.(); }
  getInstructions() { return "Fixture instructions"; }
  getServerCapabilities() { return { tools: { listChanged: true }, prompts: this.controls.holdPrompts ? {} : undefined }; }
  async listTools(params?: { cursor: string }, options?: { signal?: AbortSignal }): Promise<Listed> {
    options?.signal?.throwIfAborted();
    if (!this.transport) throw new Error("connection closed");
    const plan = this.controls.plans.shift();
    const snapshot = structuredClone(plan?.result ?? { tools: this.controls.tools });
    const pending = gate<Listed>();
    const abort = () => record.reject(new Error("startup aborted"));
    const record: RequestRecord = {
      cursor: params?.cursor, snapshot, settled: false,
      resolve: (result = snapshot) => { if (record.settled) return; record.settled = true; options?.signal?.removeEventListener("abort", abort); pending.resolve(result); },
      reject: (error) => { if (record.settled) return; record.settled = true; options?.signal?.removeEventListener("abort", abort); pending.reject(error); }
    };
    this.requests.push(record); this.controls.requests.push(record);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (plan?.error) record.reject(plan.error);
    else if (!plan?.hold) record.resolve();
    return await pending.promise;
  }
  async close() {
    this.closeCount++;
    this.transport = undefined;
    for (const request of this.requests) request.reject(new Error("connection closed"));
    this.onclose?.();
  }
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
function fixture() {
  const controls: Controls = { clients: [], tools: [{ name: "old" }], plans: [], requests: [], holdPrompts: false,
    promptEntered: gate<void>(), promptReply: gate<void>() };
  class Client extends FakeClient { constructor(_info: object) { super(controls); } }
  const prototype = runInNewContext(isolated, {
    Client, AbortController, DOMException, setTimeout, clearTimeout, ToolListChangedNotificationSchema: {},
    defaultStartupTimeoutMs: 2_000, maxToolListPages: 16, process: { env: {} },
    path: { resolve: (value: string) => value }, expandServerConfig: (config: Config) => config,
    mcpMetadataSignature: (value: unknown) => JSON.stringify(value), errorText: textError,
    McpAuthRequiredError: class extends Error {},
    markDisconnected: (managed: Managed, error: Error) => {
      managed.status.connected = false; managed.status.connecting = false; managed.status.lastError = error.message;
    }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Host;
  const config: Config = { args: [], startupTimeoutMs: 2_000, timeoutMs: 2_000 };
  const managed: Managed = { name: "fixture", rawConfig: config, config, transport: "http", tools: [], status: {
    enabled: true, connected: false, connecting: false, catalogCached: false,
    toolNames: [], promptNames: [], hasResources: false
  } };
  const registry = new Map<string, Tool>();
  const publications: string[][] = [];
  const cache = new Cache();
  const host: Host = Object.assign(Object.create(prototype) as Host, {
    closing: false, servers: new Map([[managed.name, managed]]), openingClients: new Set<FakeClient>(), workspaceRoot: "/fixture",
    catalogCache: cache, registry: { unregister: (name: string) => { registry.delete(name); } },
    openClient: async (target: Managed, signal: AbortSignal) => await host.tryConnect(target, {}, signal),
    registerServerTools: (target: Managed, tools: Tool[]) => {
      registry.clear(); for (const tool of tools) registry.set(tool.name, tool);
      target.tools = tools; target.status.toolNames = tools.map(tool => tool.name);
      target.status.lastError = undefined; publications.push([...target.status.toolNames]); controls.onRegister?.();
    },
    listPromptNames: async (_target: Managed, _client: FakeClient, signal: AbortSignal) => {
      controls.promptEntered.resolve(); await controls.promptReply.promise; signal.throwIfAborted(); return [];
    },
    requestOptions: (target: Managed) => ({ timeout: target.config.timeoutMs }), emitChange: () => {}
  });
  const catalog = () => Array.from(managed.tools, tool => tool.name);
  const assertConverged = (expected: string[]) => {
    assert.deepEqual(catalog(), expected);
    assert.deepEqual([...registry.keys()], expected);
    assert.ok(managed.catalogKey);
    assert.deepEqual(cache.get(managed.catalogKey)?.tools.map(tool => tool.name), expected);
  };
  return { host, managed, controls, registry, cache, publications, catalog, assertConverged };
}

for (const burst of [1, 64]) {
  test(`initial held snapshot retains ${burst} startup invalidation(s)`, { timeout: 5_000 }, async () => {
    const f = fixture(); f.controls.plans.push({ hold: true });
    const startup = f.host.startServer(f.managed);
    try {
      await flush(); assert.equal(f.controls.requests.length, 1);
      f.controls.tools = [{ name: "new" }];
      for (let i = 0; i < burst; i++) f.controls.clients[0]!.notify();
      await flush(); assert.equal(f.controls.requests.length, 1, "do not race the initial catalog");
      f.controls.requests[0]!.resolve(); await startup; await flush();
      assert.equal(f.controls.requests.length, 2, "replay one buffered invalidation");
      f.assertConverged(["new"]); assert.equal(f.controls.clients.length, 1);
    } finally { await f.host.close(); await startup.catch(() => undefined); }
  });
}

test("a notification during connect is buffered before the first list", { timeout: 5_000 }, async () => {
  const f = fixture();
  f.controls.connectHook = client => { f.controls.tools = [{ name: "new" }]; client.notify(); };
  try {
    await f.host.startServer(f.managed); await flush();
    assert.equal(f.controls.requests.length, 2); f.assertConverged(["new"]);
  } finally { await f.host.close(); }
});

test("a callback captured before activation observes the active phase when delivered later", { timeout: 5_000 }, async () => {
  const f = fixture(); f.controls.plans.push({ hold: true });
  const startup = f.host.startServer(f.managed);
  try {
    await flush();
    const deliver = f.controls.clients[0]!.captureNotification();
    f.controls.requests[0]!.resolve(); await startup;
    f.controls.tools = [{ name: "new" }]; deliver(); await flush();
    assert.equal(f.controls.requests.length, 2); f.assertConverged(["new"]);
  } finally { await f.host.close(); await startup.catch(() => undefined); }
});

test("initial paginated catalog re-lists after a change between pages", { timeout: 5_000 }, async () => {
  const f = fixture();
  f.controls.plans.push({ result: { tools: [{ name: "old-one" }], nextCursor: "page-2" } },
    { hold: true, result: { tools: [{ name: "old-two" }] } });
  const startup = f.host.startServer(f.managed);
  try {
    await flush(); assert.equal(f.controls.requests.length, 2); assert.equal(f.controls.requests[1]!.cursor, "page-2");
    f.controls.tools = [{ name: "new" }]; f.controls.clients[0]!.notify(); await flush();
    f.controls.requests[1]!.resolve(); await startup; await flush();
    assert.equal(f.controls.requests.length, 3); assert.equal(f.controls.requests[2]!.cursor, undefined);
    f.assertConverged(["new"]);
  } finally { await f.host.close(); await startup.catch(() => undefined); }
});

for (const refreshFirst of [true, false]) {
  test(`eventual cache converges when refresh completes ${refreshFirst ? "before" : "after"} prompt startup`, { timeout: 5_000 }, async () => {
    const f = fixture(); f.controls.holdPrompts = true; f.controls.plans.push({ hold: true }, { hold: true });
    const startup = f.host.startServer(f.managed);
    try {
      await flush(); f.controls.tools = [{ name: "new" }]; f.controls.clients[0]!.notify(); await flush();
      f.controls.requests[0]!.resolve(); await f.controls.promptEntered.promise; await flush();
      assert.equal(f.controls.requests.length, 2); assert.equal(f.managed.status.connected, false);
      if (refreshFirst) { f.controls.requests[1]!.resolve(); await flush(); assert.deepEqual(f.catalog(), ["new"]); }
      f.controls.promptReply.resolve(); await startup;
      if (!refreshFirst) {
        assert.deepEqual(f.catalog(), ["old"], "startup does not promise an awaited refresh");
        f.controls.requests[1]!.resolve(); await flush();
      }
      f.assertConverged(["new"]);
    } finally { f.controls.promptReply.resolve(); await f.host.close(); await startup.catch(() => undefined); }
  });
}

test("reconnect buffers its own startup invalidation and ignores an obsolete callback", { timeout: 5_000 }, async () => {
  const f = fixture();
  try {
    await f.host.startServer(f.managed); const obsolete = f.controls.clients[0]!.captureNotification();
    f.controls.plans.push({ hold: true }); const reconnect = f.host.reconnect(f.managed);
    await flush(); f.controls.tools = [{ name: "new" }]; f.controls.clients[1]!.notify(); await flush();
    f.controls.requests[1]!.resolve(); await reconnect; await flush();
    f.assertConverged(["new"]); const count = f.controls.requests.length;
    obsolete(); await flush(); assert.equal(f.controls.requests.length, count);
    assert.equal(f.controls.clients[0]!.closeCount, 1);
  } finally { await f.host.close(); }
});

test("startup failure discards buffered notifications without reviving a later client", { timeout: 5_000 }, async () => {
  const f = fixture(); f.controls.plans.push({ hold: true });
  const startup = f.host.startServer(f.managed); const rejected = assert.rejects(startup, /initial list failed/);
  try {
    await flush(); const failed = f.controls.clients[0]!; failed.notify(); await flush();
    const obsolete = failed.captureNotification();
    f.controls.requests[0]!.reject(new Error("initial list failed")); await rejected;
    assert.equal(f.managed.client, undefined); assert.deepEqual(f.catalog(), []); assert.equal(failed.closeCount, 1);
    f.controls.tools = [{ name: "replacement" }]; await f.host.reconnect(f.managed); await flush();
    const count = f.controls.requests.length; obsolete(); failed.notify(); await flush();
    assert.equal(f.controls.requests.length, count); f.assertConverged(["replacement"]);
  } finally { await f.host.close(); await rejected; }
});

test("close during initial discovery rejects startup and never replays buffered changes", { timeout: 5_000 }, async () => {
  const f = fixture(); f.controls.plans.push({ hold: true });
  const startup = f.host.startServer(f.managed); const rejected = assert.rejects(startup, /closing|connection closed/);
  try {
    await flush(); f.controls.clients[0]!.notify(); await flush(); await f.host.close(); await rejected; await flush();
    assert.equal(f.controls.requests.length, 1); assert.equal(f.managed.status.connected, false);
    assert.equal(f.controls.clients[0]!.closeCount, 1); assert.equal(f.host.openingClients.size, 0);
  } finally { await f.host.close(); await rejected; }
});

test("aborted initial discovery closes its client and leaves no active notification owner", { timeout: 5_000 }, async () => {
  const f = fixture(); f.controls.plans.push({ hold: true }); const controller = new AbortController();
  const opening = f.host.tryConnect(f.managed, {}, controller.signal); const rejected = assert.rejects(opening, /abort/i);
  try {
    await flush(); f.controls.clients[0]!.notify(); await flush(); controller.abort(new Error("startup aborted")); await rejected;
    f.controls.clients[0]!.notify(); await flush();
    assert.equal(f.controls.requests.length, 1); assert.equal(f.host.openingClients.size, 0);
    assert.equal(f.controls.clients[0]!.closeCount, 1); assert.deepEqual(f.catalog(), []);
  } finally { await f.host.close(); await rejected; }
});

test("no notification adds no startup request; later steady-state notification still refreshes", { timeout: 5_000 }, async () => {
  const f = fixture();
  try {
    await f.host.startServer(f.managed); await flush(); assert.equal(f.controls.requests.length, 1); f.assertConverged(["old"]);
    f.controls.tools = [{ name: "new" }]; f.controls.clients[0]!.notify(); await flush();
    assert.equal(f.controls.requests.length, 2); f.assertConverged(["new"]);
  } finally { await f.host.close(); }
});

test("noise during the replayed refresh coalesces through the existing dirty loop", { timeout: 5_000 }, async () => {
  const f = fixture(); f.controls.plans.push({ hold: true }, { hold: true });
  const startup = f.host.startServer(f.managed);
  try {
    await flush(); f.controls.clients[0]!.notify(); await flush(); f.controls.requests[0]!.resolve(); await startup; await flush();
    assert.equal(f.controls.requests.length, 2); f.controls.tools = [{ name: "new" }];
    for (let i = 0; i < 64; i++) f.controls.clients[0]!.notify(); await flush();
    assert.equal(f.controls.requests.length, 2); f.controls.requests[1]!.resolve(); await flush();
    assert.equal(f.controls.requests.length, 3); f.assertConverged(["new"]);
  } finally { await f.host.close(); await startup.catch(() => undefined); }
});
