/** Source-extracted decision paths; no product imports, Host, socket, SQLite or real tasks. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_BACKGROUND_RESIDENCY_SOURCE_ROOT ?? process.cwd();
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(resolve(root, path), "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(file: ts.SourceFile, name: string): ts.ClassDeclaration | ts.FunctionDeclaration {
  const matches = file.statements.filter(statement =>
    (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name?.text === name);
  assert.equal(matches.length, 1, `exactly one declaration ${name}`);
  const node = matches[0];
  assert.ok(node && (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)), name);
  return node;
}
function arrowProperty(scope: ts.Node, name: string): ts.ArrowFunction {
  const matches: ts.ArrowFunction[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name
      && ts.isArrowFunction(node.initializer)) matches.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  assert.equal(matches.length, 1, `exactly one ${name} arrow in selected scope`);
  return matches[0]!;
}
const registryFile = source("src/runtime/host/registry.ts");
const eventsFile = source("src/runtime/agentEvents.ts");
const serverFile = source("src/runtime/host/server.ts");
const commandsFile = source("src/runtime/CommandRuntime.ts");
const server = declaration(serverFile, "RuntimeHostServer");
assert.ok(ts.isClassDeclaration(server));
const constructors = server.members.filter(ts.isConstructorDeclaration);
assert.equal(constructors.length, 1);
const canEvictNode = arrowProperty(constructors[0]!, "canEvict");
const hasBackgroundWorkNode = arrowProperty(declaration(commandsFile, "initializeCommandRuntime"), "hasBackgroundWork");
const canEvict = canEvictNode.getText(serverFile);
const hasBackgroundWork = hasBackgroundWorkNode.getText(commandsFile);
const registryClass = declaration(registryFile, "SessionRuntimeRegistry");
assert.ok(ts.isClassDeclaration(registryClass));
const registryMethods = ["list", "closeSession", "evictIdle"].map(name => {
  const matches = registryClass.members.filter(member => ts.isMethodDeclaration(member)
    && ts.isIdentifier(member.name) && member.name.text === name);
  assert.equal(matches.length, 1, `exactly one registry method ${name}`);
  const method = matches[0];
  assert.ok(method && ts.isMethodDeclaration(method), name);
  return method;
});
const busyNode = declaration(eventsFile, "runtimeIsBusy");
const allowedCalls = new Set([
  "this.entries.values", "this.entries.get", "this.entries.delete", "this.list", "this.closeSession",
  "runtimeIsBusy", "entry.runtime.getSnapshot", "entry.unsubscribe", "entry.runtime.close",
  "this.options.canEvict", "Math.max", "evicted.push",
  "this.oneShotSessions.has", "this.sessionWriterOwners.has", "this.dispatcher.hasPendingSession",
  "entry.commands.hasBackgroundWork", "agent.hasPendingMemoryWork", "heartbeat.status",
  "Boolean", "subagentTaskManager?.listSnapshots"
]);
function inspect(node: ts.Node): void {
  assert.equal(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(node.getSourceFile()), "Error");
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    const call = expression.getText(node.getSourceFile());
    const collectionCall = ts.isPropertyAccessExpression(expression) && (
      (expression.name.text === "filter" && expression.expression.getText(node.getSourceFile()) === "this.list()")
      || (expression.name.text === "sort" && ts.isCallExpression(expression.expression)
        && ts.isPropertyAccessExpression(expression.expression.expression)
        && expression.expression.expression.name.text === "filter"
        && expression.expression.expression.expression.getText(node.getSourceFile()) === "this.list()")
      || (expression.name.text === "some" && expression.expression.getText(node.getSourceFile()) === "subagentTaskManager?.listSnapshots()")
    );
    assert.ok(allowedCalls.has(call) || collectionCall, `Unexpected extracted call: ${call}`);
  }
  ts.forEachChild(node, inspect);
}
for (const node of [busyNode, ...registryMethods, canEvictNode, hasBackgroundWorkNode]) inspect(node);
const fixtureSource = [
  busyNode.getText(eventsFile).replace(/^export\s+/u, ""),
  `class SessionRuntimeRegistry {
    constructor(entries, options) { this.entries = entries; this.options = options; }
    ${registryMethods.map(method => method.getText(registryFile)).join("\n")}
  }`,
  `class HostPolicyFixture {
    constructor(host) {
      this.oneShotSessions = host.oneShotSessions;
      this.sessionWriterOwners = host.sessionWriterOwners;
      this.dispatcher = host.dispatcher;
      this.canEvict = ${canEvict};
    }
  }`,
  `function backgroundPredicate(state) {
    const agent = { hasPendingMemoryWork: () => state.memory };
    const heartbeat = { status: () => ({ running: state.heartbeat }) };
    const durableTaskPromises = state.durable;
    const workerResumeAdmissions = state.resumes;
    const subagentTaskManager = { listSnapshots: () => state.children };
    return ${hasBackgroundWork};
  }`,
  "({ Registry: SessionRuntimeRegistry, HostPolicyFixture, backgroundPredicate });"
].join("\n");
const transpiled = ts.transpileModule(fixtureSource, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal(transpiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);

interface Background {
  memory: boolean;
  heartbeat: boolean;
  durable: Map<string, Promise<unknown>>;
  resumes: Map<string, object>;
  children: { status: string }[];
}
interface Runtime {
  snapshot: { info: { sessionId: string }; state: { kind: "idle" | "runs" }; queuedMessages: object[] };
  closed: number;
  closeHook?: () => Promise<void>;
  getSnapshot(): Runtime["snapshot"];
  subscribe(): () => void;
  close(): Promise<void>;
}
interface Commands { hasBackgroundWork(): boolean }
interface Entry { sessionId: string; runtime: Runtime; commands: Commands; primary: boolean; lastActiveAt: number; unsubscribe(): void }
interface Registry {
  list(): Entry[];
  evictIdle(count?: number): Promise<string[]>;
  closeSession(sessionId: string): Promise<void>;
}
interface HostPolicy {
  oneShotSessions: Set<string>;
  sessionWriterOwners: Set<string>;
  dispatcher: { hasPendingSession(sessionId: string): boolean };
}
interface Loaded {
  Registry: new (entries: Map<string, Entry>, options: {
    canEvict(entry: Entry): boolean;
  }) => Registry;
  HostPolicyFixture: new (host: HostPolicy) => { canEvict(entry: Entry): boolean };
  backgroundPredicate(state: Background): () => boolean;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const loaded = runInNewContext(transpiled.outputText, {}, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as Loaded;
  const states = new Map<string, Background>();
  const runtimes = new Map<string, Runtime>();
  const pending = new Set<string>();
  const host: HostPolicy = {
    oneShotSessions: new Set(), sessionWriterOwners: new Set(),
    dispatcher: { hasPendingSession: sessionId => pending.has(sessionId) }
  };
  const policy = new loaded.HostPolicyFixture(host);
  const entries = new Map<string, Entry>();
  function add(sessionId: string) {
    const state: Background = { memory: false, heartbeat: false, durable: new Map(), resumes: new Map(), children: [] };
    states.set(sessionId, state);
    const runtime: Runtime = {
      snapshot: { info: { sessionId }, state: { kind: "idle" }, queuedMessages: [] }, closed: 0,
      getSnapshot() { return this.snapshot; }, subscribe: () => () => {},
      async close() { this.closed += 1; await this.closeHook?.(); }
    };
    runtimes.set(sessionId, runtime);
    const result: Entry = { sessionId, runtime, commands: { hasBackgroundWork: loaded.backgroundPredicate(state) },
      primary: sessionId === "primary", lastActiveAt: entries.size, unsubscribe: () => {} };
    entries.set(sessionId, result);
    return result;
  }
  add("primary");
  const registry = new loaded.Registry(entries, { canEvict: policy.canEvict });
  return { registry, entries, add, states, runtimes, host, pending };
}

// A task closure can own work before a child is submitted or after it finishes.
// The real background predicate must retain its durable promise in either phase.
for (const phase of ["before child submission", "after child completion"] as const) {
  test(`cache pressure preserves admitted durable work ${phase}`, async () => {
    const f = fixture();
    const active = f.add("active");
    const completion = gate();
    try {
      f.states.get("active")!.durable.set("task", completion.promise);
      if (phase === "after child completion") f.states.get("active")!.children.push({ status: "completed" });
      active.lastActiveAt = 0;
      for (let i = 0; i < 6; i += 1) f.add(`other-${i}`);
      // Eight resident entries plus an incoming ninth requires one best-effort slot.
      await f.registry.evictIdle(1);
      f.add("incoming");
      assert.equal(active.runtime.closed, 0, "cache pressure must not close the admitted task owner");
      assert.equal(f.entries.get("active"), active);
      assert.equal(active.runtime.getSnapshot().state.kind, "idle", "background work does not become foreground busy");
    } finally { completion.release(); await completion.promise; }
  });
}

test("settled durable work permits ordinary idle eviction", async () => {
  const f = fixture();
  const active = f.add("active");
  const completion = gate();
  f.states.get("active")!.durable.set("task", completion.promise);
  completion.release();
  await completion.promise;
  // This models dispatchTaskRun's finally deleting its exact tracked completion.
  f.states.get("active")!.durable.delete("task");
  await f.registry.evictIdle(1);
  f.add("replacement");
  assert.equal(active.runtime.closed, 1);
  assert.equal(f.entries.get("active"), undefined);
});

test("eviction rechecks background work admitted while the previous candidate closes", async () => {
  const f = fixture();
  const first = f.add("first");
  const second = f.add("second");
  first.lastActiveAt = 0; second.lastActiveAt = 1;
  const release = gate(); const completion = gate();
  let entered = false;
  first.runtime.closeHook = async () => { entered = true; await release.promise; };
  const eviction = f.registry.evictIdle(2);
  void eviction.catch(() => undefined);
  try {
    assert.equal(entered, true, "first close is entered before evictIdle yields");
    f.states.get("second")!.durable.set("new-task", completion.promise);
    release.release();
    const evicted = [...await eviction];
    assert.equal(evicted.length, 1, "the second candidate gains background residency during the await");
    assert.deepEqual(evicted, ["first"]);
    assert.equal(second.runtime.closed, 0);
    assert.equal(f.entries.get("second"), second);
  } finally {
    release.release(); completion.release();
    await Promise.allSettled([eviction, completion.promise]);
  }
});

for (const owner of ["resume", "queued child", "running child", "memory", "heartbeat"] as const) {
  test(`existing background predicate retains ${owner}`, async () => {
    const f = fixture();
    const active = f.add("active");
    const state = f.states.get("active")!;
    if (owner === "resume") state.resumes.set("task", {});
    else if (owner === "queued child") state.children.push({ status: "queued" });
    else if (owner === "running child") state.children.push({ status: "running" });
    else if (owner === "memory") state.memory = true;
    else state.heartbeat = true;
    await f.registry.evictIdle(1);
    f.add("replacement");
    assert.equal(active.runtime.closed, 0);
    assert.equal(f.entries.get("active"), active);
  });
}

for (const reason of ["foreground", "queue", "one-shot", "writer", "pending lane"] as const) {
  test(`existing ${reason} residency remains intact`, async () => {
    const f = fixture();
    const active = f.add("active");
    if (reason === "foreground") active.runtime.snapshot.state.kind = "runs";
    else if (reason === "queue") active.runtime.snapshot.queuedMessages.push({});
    else if (reason === "one-shot") f.host.oneShotSessions.add("active");
    else if (reason === "writer") f.host.sessionWriterOwners.add("active");
    else f.pending.add("active");
    await f.registry.evictIdle(1);
    f.add("replacement");
    assert.equal(active.runtime.closed, 0);
    assert.equal(f.entries.get("active"), active);
    assert.equal(f.runtimes.get("primary")!.closed, 0);
  });
}

test("primary stays resident while empty secondary sessions can be evicted", async () => {
  const f = fixture();
  const idle = f.add("idle");
  await f.registry.evictIdle(1);
  f.add("replacement");
  assert.equal(idle.runtime.closed, 1);
  assert.equal(f.runtimes.get("primary")!.closed, 0);
  assert.ok(f.entries.get("primary"));
});

test("explicit secondary close keeps its existing semantics", async () => {
  const f = fixture();
  const active = f.add("active");
  const completion = gate();
  try {
    f.states.get("active")!.durable.set("task", completion.promise);
    await f.registry.closeSession("active");
    assert.equal(active.runtime.closed, 1);
    assert.equal(f.entries.get("active"), undefined);
  } finally { completion.release(); await completion.promise; }
});
