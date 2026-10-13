import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-only fixture. No coordinator, Runtime, SDK, recorder, database, shell,
// worker or permission implementation is imported. Only the exact gate, abort
// wait and two Runtime approval methods are evaluated with inert callbacks.
const root = process.env.BINY_PERMISSION_QUEUE_SOURCE_ROOT ?? process.cwd();
const coordinatorPath = process.env.BINY_PERMISSION_QUEUE_BASELINE
  ?? path.join(root, "src/agent/toolExecutionCoordinator.ts");
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function one<T>(nodes: readonly T[], label: string): T {
  assert.equal(nodes.length, 1, label);
  return nodes[0]!;
}
function method(source: ts.SourceFile, owner: string, name: string): ts.MethodDeclaration {
  const declaration = one(source.statements.filter((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === owner), owner);
  const result = one(declaration.members.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name), name);
  assert.ok(result.body, name);
  return result;
}
const coordinator = parse(coordinatorPath);
const runtime = parse(path.join(root, "src/runtime/InteractiveAgentRuntime.ts"));
const gate = method(coordinator, "ToolExecutionCoordinator", "withPermissionGate");
const wait = one(coordinator.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "waitForAbort"), "waitForAbort");
const request = method(runtime, "InteractiveAgentRuntime", "waitForPermission");
const answer = method(runtime, "InteractiveAgentRuntime", "answerPermission");
const calls = new Set<string>();
for (const [node, source] of [[gate, coordinator], [wait, coordinator], [request, runtime], [answer, runtime]] as const) {
  const visit = (child: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(child)
      && !(ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword), "no imports in extraction");
    if (ts.isCallExpression(child)) calls.add(child.expression.getText(source));
    if (ts.isNewExpression(child)) assert.ok(["Promise", "Error", "DOMException"].includes(child.expression.getText(source)));
    ts.forEachChild(child, visit);
  };
  visit(node);
}
const allowedCalls = new Set([
  "waitForAbort", "signal?.throwIfAborted", "fn", "release", "previous.then",
  "signal.removeEventListener", "signal.addEventListener", "reject", "resolve", "promise.then",
  "randomUUID", "redactPermissionRequest", "this.eventBase", "this.emit", "permissionActionForResult",
  "result.message?.trim", "isFullYesConfirmation", "pending.resolve", "redactSecrets"
]);
for (const call of calls) assert.ok(allowedCalls.has(call), `unreviewed extracted call: ${call}`);
const owner = one(coordinator.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "ToolExecutionCoordinator"), "coordinator");
const tail = one(owner.members.filter((node): node is ts.PropertyDeclaration =>
  ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "permissionTail"), "tail initializer");
assert.equal(tail.initializer?.getText(coordinator), "Promise.resolve()", "queue tail starts fulfilled");
const writes: ts.BinaryExpression[] = [];
const scan = (node: ts.Node): void => {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.left.getText(coordinator) === "this.permissionTail") writes.push(node);
  ts.forEachChild(node, scan);
};
scan(owner);
assert.equal(writes.length, 1, "only the reviewed gate may replace the tail");
assert.ok(writes[0]!.pos >= gate.pos && writes[0]!.end <= gate.end);
const source = `${wait.getText(coordinator)}\nclass Fixture {
  ${tail.getText(coordinator)}
  ${gate.getText(coordinator)}
  ${request.getText(runtime)}
  ${answer.getText(runtime)}
}\nFixture;`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
interface Approval { approved: boolean; action?: string; scope?: string; message?: string; confirmation?: string }
interface Request { toolCallId: string; tool: string; requireFullYes?: boolean }
interface Pending { requestId: string; request: Request; resolve(value: Approval): void }
interface Fixture {
  permissionTail: Promise<void>;
  pendingPermission?: Pending;
  withPermissionGate<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  waitForPermission(run: { sessionId: string; runId: string }, request: Request): Promise<Approval>;
  answerPermission(requestId: string, result: Approval): void;
  eventBase(): object;
  emit(event: Record<string, unknown>): void;
}
let nextId = 0;
const FixtureClass = runInNewContext(compiled.outputText, {
  Promise, Error, DOMException,
  randomUUID: () => `inert-${++nextId}`,
  redactPermissionRequest: (value: Request) => value,
  permissionActionForResult: (value: Approval) => value.approved ? "allow_once" : "deny",
  isFullYesConfirmation: (value: string) => value.trim().toLowerCase() === "yes",
  redactSecrets: (value: string) => value
}, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as new () => Fixture;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let index = 0; index < 24; index++) await Promise.resolve(); }
function fixture() {
  const state = new FixtureClass();
  const events: Record<string, unknown>[] = [];
  state.eventBase = () => ({});
  state.emit = event => { events.push(event); };
  return { state, events };
}
function observed<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}

for (const queuedBeforeAbort of [false, true]) {
  test(`cancelled middle waiter cannot pass its live predecessor; successor already queued=${queuedBeforeAbort}`, async () => {
    const { state } = fixture(); const hold = deferred<string>(); const abort = new AbortController();
    const order: string[] = []; const reason = new Error("only B cancelled");
    const a = state.withPermissionGate(async () => { order.push("A"); return await hold.promise; });
    await flush(); assert.deepEqual(order, ["A"]);
    const b = observed(state.withPermissionGate(async () => { order.push("B"); return "B"; }, abort.signal));
    let c: Promise<string> | undefined;
    const startC = () => state.withPermissionGate(async () => { order.push("C"); return "C"; });
    if (queuedBeforeAbort) c = startC();
    abort.abort(reason);
    const cancelled = await b;
    if (!c) c = startC();
    try {
      assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.equal(cancelled.error, reason);
      await flush();
      assert.deepEqual(order, ["A"], "C must not request permission before A has settled");
    } finally { hold.resolve("A"); await Promise.all([a, c]); }
    assert.deepEqual(order, ["A", "C"]);
  });
}

test("multiple cancelled middle waiters preserve the oldest live gate", async () => {
  const { state } = fixture(); const hold = deferred<void>(); const order: string[] = [];
  const a = state.withPermissionGate(async () => { order.push("A"); await hold.promise; });
  await flush();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const cancelled = controllers.map((controller, index) => observed(state.withPermissionGate(async () => {
    order.push(`cancelled-${index}`);
  }, controller.signal)));
  const c = state.withPermissionGate(async () => { order.push("C"); });
  for (const controller of [...controllers].reverse()) controller.abort("middle-only");
  await Promise.all(cancelled);
  try { await flush(); assert.deepEqual(order, ["A"]); }
  finally { hold.resolve(); await Promise.all([a, c]); }
  assert.deepEqual(order, ["A", "C"]);
});

test("an already-cancelled waiter rejects promptly without breaking the live tail", async () => {
  const { state } = fixture(); const hold = deferred<void>(); const abort = new AbortController();
  const order: string[] = []; abort.abort("pre-cancelled");
  const a = state.withPermissionGate(async () => { order.push("A"); await hold.promise; });
  await flush();
  const b = await observed(state.withPermissionGate(async () => { order.push("B"); }, abort.signal));
  const c = state.withPermissionGate(async () => { order.push("C"); });
  try { assert.equal(b.ok, false); if (!b.ok) assert.equal(b.error, "pre-cancelled"); await flush(); assert.deepEqual(order, ["A"]); }
  finally { hold.resolve(); await Promise.all([a, c]); }
});

test("ordinary success and rejection retain FIFO and return original values", async () => {
  const { state } = fixture(); const hold = deferred<number>(); const failure = new Error("ordinary failure");
  const order: string[] = [];
  const a = state.withPermissionGate(async () => { order.push("A"); return await hold.promise; });
  const b = observed(state.withPermissionGate(async () => { order.push("B"); throw failure; }));
  const c = state.withPermissionGate(async () => { order.push("C"); return 3; });
  await flush(); assert.deepEqual(order, ["A"]); hold.resolve(1);
  assert.equal(await a, 1); const rejected = await b;
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error, failure);
  assert.equal(await c, 3); assert.deepEqual(order, ["A", "B", "C"]);
  await state.permissionTail;
});

test("active-holder cancellation preserves existing prompt rejection and release behavior", async () => {
  const { state } = fixture(); const hold = deferred<void>(); const abort = new AbortController();
  const order: string[] = [];
  const a = observed(state.withPermissionGate(async () => { order.push("A"); await hold.promise; }, abort.signal));
  await flush();
  const b = state.withPermissionGate(async () => { order.push("B"); });
  abort.abort("active-only");
  try {
    const cancelled = await a; assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.error, "active-only");
    await b; assert.deepEqual(order, ["A", "B"], "active fn is not awaited after cancellation, as before");
  } finally { hold.resolve(); await flush(); }
});

test("shared parent cancellation starts no queued successor and leaves a reusable tail", async () => {
  const { state } = fixture(); const abort = new AbortController(); const hold = deferred<void>();
  const order: string[] = [];
  const a = observed(state.withPermissionGate(async () => { order.push("A"); await hold.promise; }, abort.signal));
  await flush();
  const b = observed(state.withPermissionGate(async () => { order.push("B"); }, abort.signal));
  const c = observed(state.withPermissionGate(async () => { order.push("C"); }, abort.signal));
  abort.abort("all");
  try { assert.ok((await Promise.all([a, b, c])).every(result => !result.ok)); assert.deepEqual(order, ["A"]); }
  finally { hold.resolve(); await state.permissionTail; }
  await state.withPermissionGate(async () => { order.push("D"); });
  assert.deepEqual(order, ["A", "D"]);
});

test("Runtime retains A's approval identity when a queued B is cancelled", async () => {
  const { state, events } = fixture(); const abort = new AbortController();
  const run = { sessionId: "inert-session", runId: "inert-run" };
  const permissions = new Map<string, Pending>();
  state.emit = event => {
    events.push(event);
    if (event.type === "permission.requested") permissions.set(String(event.toolCallId), state.pendingPermission!);
  };
  const ask = (id: string) => state.waitForPermission(run, { toolCallId: id, tool: "InertTool" });
  const a = state.withPermissionGate(async () => await ask("A"));
  await flush(); const first = state.pendingPermission!; assert.ok(first);
  const b = observed(state.withPermissionGate(async () => await ask("B"), abort.signal));
  abort.abort("B only"); await b;
  const c = state.withPermissionGate(async () => await ask("C"));
  try {
    await flush();
    assert.equal(state.pendingPermission, first, "C must not replace A's only pending permission");
    state.answerPermission(first.requestId, { approved: false, action: "deny", message: "declined A" });
    assert.equal((await a).approved, false);
    await flush(); assert.ok(state.pendingPermission); assert.notEqual(state.pendingPermission.requestId, first.requestId);
    state.answerPermission(state.pendingPermission.requestId, { approved: false, action: "deny" });
    assert.equal((await c).approved, false);
    assert.deepEqual(events.filter(event => event.type === "permission.requested").map(event => event.toolCallId), ["A", "C"]);
  } finally {
    // Resolve captured inert callbacks even on baseline assertion failure; never
    // repair the production state in order to make the regression pass.
    first.resolve({ approved: false }); await flush();
    for (const pending of permissions.values()) pending.resolve({ approved: false });
    await Promise.all([a, c]);
  }
});
