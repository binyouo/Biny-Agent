import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Inert product source only. Never import/construct Host, providers, sockets,
// SQLite, Recorder or checkpoint code. This fixture covers explicit session lanes;
// omitted-session run.continue routing and ownership during later interrupted-turn
// awaits are separate deferred issues. Queue fakes represent
// an already running session; they do not claim that idle queues auto-start.
const source = readFileSync(new URL("../src/runtime/host/server.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const servers = parsed.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostServer");
assert.equal(servers.length, 1);
function method(name: string): ts.MethodDeclaration {
  const matches = servers[0]!.members.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `Expected exactly one ${name}`);
  assert.ok(matches[0]!.body);
  return matches[0]!;
}
function descendants(node: ts.Node, match: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(child: ts.Node): void {
    if (match(child)) result.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return result;
}
const operations = ["submit", "run.submit", "queue", "run.queue", "start-interrupted", "run.continue"] as const;
const goals = ["session.goal.set", "session.goal.resume"] as const;
const statements = method("execute").body!.statements;
const switches = statements.filter((node): node is ts.SwitchStatement =>
  ts.isSwitchStatement(node) && node.expression.getText(parsed) === "frame.operation");
assert.equal(switches.length, 1);
const operationSwitch = switches[0]!;
const switchIndex = statements.indexOf(operationSwitch);
// Keep the whole common routing segment, including any newly inserted fence.
// Baseline has 3 statements; candidate has 4. Do not synthesize the new check.
const routeIndex = statements.findIndex((node) =>
  node.getText(parsed) === "const managed = await this.runtimeEntry(frame.operation, payload);");
assert.ok(routeIndex > 0);
const route = statements.slice(routeIndex, switchIndex);
assert.ok(route.length === 3 || route.length === 4, "Unexpected common routing boundary");
assert.equal(route.at(-2)!.getText(parsed), "const runtime = managed.runtime;");
assert.equal(route.at(-1)!.getText(parsed), "const commands = managed.commands;");
if (route.length === 4) {
  assert.equal(route[1]!.getText(parsed), "this.assertRequestAdmission(connection, admissionOperation);");
}
const initialFenceIndex = statements.findIndex((node) =>
  node.getText(parsed) === "this.assertRequestAdmission(connection, admissionOperation);");
assert.equal(initialFenceIndex, 3, "Expected original payload/admission operation prelude");
const selected = [...operations, ...goals, "permission"].map((operation) => {
  const clauses = operationSwitch.caseBlock.clauses.filter((node): node is ts.CaseClause =>
    ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === operation);
  assert.equal(clauses.length, 1, `Expected one ${operation} clause`);
  if (operations.includes(operation as typeof operations[number])) {
    const claims = descendants(clauses[0]!, (node) => ts.isExpressionStatement(node)
      && node.getText(parsed) === "await this.ensureSessionWriter(connection, runtime);");
    assert.equal(claims.length, 1, `Expected one writer await for ${operation}`);
    const claim = claims[0]!;
    assert.ok(ts.isBlock(claim.parent));
    const siblings = claim.parent.statements;
    const next = siblings[siblings.indexOf(claim as ts.Statement) + 1];
    assert.ok(next);
    assert.ok([
      "this.admission.assertAdmission();",
      "this.assertRequestAdmission(connection, admissionOperation);"
    ].includes(next.getText(parsed)), `Unexpected post-claim boundary for ${operation}`);
  }
  return clauses[0]!.getText(parsed);
});
const methods = ["assertRequestAdmission", "executeAdmission", "ensureSessionWriter", "claimSessionWriter"];
const validationSource = readFileSync(new URL("../src/runtime/host/validation.ts", import.meta.url), "utf8");
const validationParsed = ts.createSourceFile("validation.ts", validationSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const validationHelpers = ["readModelRoute", "readFastMode"].map((name) => {
  const matches = validationParsed.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `Expected actual validation helper ${name}`);
  return matches[0]!.getText(validationParsed).replace(/^export /u, "");
}).join("\n");
const isolated = stripTypeScriptTypes(`${validationHelpers}\nclass PauseAdmissionHarness {
${methods.map((name) => method(name).getText(parsed)).join("\n")}
async execute(connection, frame) {
${statements.slice(0, initialFenceIndex + 1).map((node) => node.getText(parsed)).join("\n")}
${route.map((node) => node.getText(parsed)).join("\n")}
switch (frame.operation) { ${selected.join("\n")} default: throw new Error("Unextracted operation"); }
}
}
PauseAdmissionHarness.prototype;`, { mode: "strip" });

test("actual optional model-route and fast-mode parsers retain validation", () => {
  const helpers = runInNewContext(stripTypeScriptTypes(`${validationHelpers}\n({ readModelRoute, readFastMode });`, { mode: "strip" })) as {
    readModelRoute(value: unknown): "tool" | undefined;
    readFastMode(value: unknown): boolean | undefined;
  };
  assert.equal(helpers.readModelRoute(undefined), undefined);
  assert.equal(helpers.readModelRoute("tool"), "tool");
  for (const value of [null, false, "other", 1, {}]) assert.throws(() => helpers.readModelRoute(value), /modelRoute must be tool/u);
  for (const value of [undefined, true, false]) assert.equal(helpers.readFastMode(value), value);
  for (const value of [null, "true", 1, {}]) assert.throws(() => helpers.readFastMode(value), /fastMode must be a boolean/u);
});

type RecordValue = Record<string, unknown>;
interface Connection { clientId: string; surface: string; exitingForPause: boolean }
interface Owner { clientId: string; surface: string; pendingCompletions: number }
interface Frame { operation: string; payload: RecordValue }
interface Runtime {
  getSnapshot(): { info: { sessionId: string }; state: { kind: string }; revision: number };
  claimSession(sessionId: string): Promise<void>;
  submitPrompt(): RecordValue;
  enqueue(): RecordValue;
  steer(): RecordValue;
  startInterruptedTurn(): Promise<RecordValue>;
  answerPermission(requestId: string, result: unknown): void;
}
interface Managed { runtime: Runtime; commands: Record<string, unknown> }
interface State {
  sessionWriterOwners: Map<string, Owner>;
  sessionGoalOwners: Map<string, unknown>;
  registry: { get(sessionId: string): Managed | undefined };
  admission: { assertAdmission(): void };
  businessComposition: { scheduleGoals(): void };
  runtimeEntry(operation: string, payload: RecordValue): Promise<Managed>;
  assertEventSequenceAvailable(): void;
  assertSessionWriterAvailable(connection: Connection, sessionId: string): void;
  assertRevision(payload: RecordValue, runtime: Runtime): void;
  trackCompletion(value: unknown): void;
  continueRun(payload: RecordValue, runtime: Runtime, commands: unknown): Promise<RecordValue>;
  publishSnapshot(runtime: Runtime): void;
  assertRequestAdmission(connection: Connection, operation: string): void;
  executeAdmission(execute: () => Promise<unknown>, runtime: Runtime): Promise<unknown>;
  ensureSessionWriter(connection: Connection, runtime: Runtime): Promise<void>;
  claimSessionWriter(connection: Connection, sessionId: string): Promise<void>;
  execute(connection: Connection, frame: Frame): Promise<unknown>;
}
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
class FakeCompletion {
  readonly completion: Promise<unknown>;

  constructor(completion: Promise<unknown>) {
    this.completion = completion;
  }
}
const extracted = runInNewContext(isolated, {
  asRecord: record,
  isRuntimeHostAdmissionOperation: (operation: string) => [...operations, ...goals].includes(operation as typeof operations[number]),
  OperationCompletion: FakeCompletion,
  sessionIdFromFile: (sessionId: string) => sessionId,
  requiredString: (value: unknown) => { assert.equal(typeof value, "string"); return value; },
  optionalSafeInteger: (value: unknown) => Number.isSafeInteger(value) ? value : undefined,
  readRequestIds: (payload: RecordValue) => ({ runId: payload.runId, messageId: payload.messageId }),
  readAttachments: () => [], readPromptContext: () => undefined, readCapabilitySelection: () => undefined,
  readPermissionResult: (value: unknown) => value,
  readGoalTokenBudget: () => undefined, readGoalExpected: () => undefined,
  publicError: (error: unknown) => String(record(error).message ?? error),
  publicErrorCode: () => undefined, publicErrorData: () => undefined
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as State;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const counts = { claim: 0, mutations: 0, tracked: 0, scheduled: 0, permission: 0 };
  const connection: Connection = { clientId: "client-a", surface: "desktop", exitingForPause: false };
  const other: Connection = { clientId: "client-b", surface: "tui", exitingForPause: false };
  const controls = {
    draining: false, exhausted: false, kind: "idle", claimGate: undefined as Promise<void> | undefined,
    routeGate: undefined as Promise<void> | undefined,
    claimEntered: gate(), routeEntered: gate()
  };
  const mutation = () => { counts.mutations += 1; return { runId: "run-a", messageId: "message-a" }; };
  const runtime: Runtime = {
    getSnapshot: () => ({ info: { sessionId: "session-a" }, state: { kind: controls.kind }, revision: 1 }),
    claimSession: async () => { counts.claim += 1; controls.claimEntered.release(); await controls.claimGate; },
    submitPrompt: mutation,
    enqueue: () => { assert.equal(controls.kind, "runs", "Fake queue requires an active run"); return mutation(); },
    steer: () => { assert.equal(controls.kind, "runs", "Fake steer requires an active run"); return mutation(); },
    startInterruptedTurn: async () => mutation(),
    answerPermission: () => { counts.permission += 1; }
  };
  const managed: Managed = { runtime, commands: { sessionGoals: {
    set: () => { mutation(); return { sessionId: "session-a", goalId: "goal-a" }; },
    resume: () => { mutation(); return { sessionId: "session-a", goalId: "goal-a" }; }
  } } };
  const state: State = Object.assign(Object.create(extracted) as State, {
    sessionWriterOwners: new Map<string, Owner>(), sessionGoalOwners: new Map<string, unknown>(),
    registry: { get: (id: string) => id === "session-a" ? managed : undefined },
    admission: { assertAdmission: () => { if (controls.draining) throw new Error("Host draining"); } },
    businessComposition: { scheduleGoals: () => { counts.scheduled += 1; } },
    runtimeEntry: async () => { controls.routeEntered.release(); await controls.routeGate; return managed; },
    assertEventSequenceAvailable: () => { if (controls.exhausted) throw new Error("Event sequence exhausted"); },
    assertSessionWriterAvailable: (client: Connection, id: string) => {
      const owner = state.sessionWriterOwners.get(id);
      if (owner && owner.clientId !== client.clientId) throw new Error("Foreign owner");
    },
    assertRevision: (payload: RecordValue) => {
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== 1) throw new Error("Revision conflict");
    }, trackCompletion: () => { counts.tracked += 1; },
    continueRun: async () => mutation(), publishSnapshot: () => undefined
  });
  const request = (operation: string, client = connection, payload: RecordValue = {}) => state.execute(client, {
    operation, payload: { sessionId: "session-a", input: "hello", objective: "goal", runId: "run-a", requestId: "permission-a", delivery: "queue", ...payload }
  });
  return { state, managed, runtime, connection, other, controls, counts, request };
}
const pauseError = /exiting and cannot start new work/u;
const innerEnvelope = new Set(["run.submit", "run.queue", "run.continue"]);
async function expectRejected(promise: Promise<unknown>, operation: string, reason = pauseError): Promise<void> {
  if (!innerEnvelope.has(operation)) {
    await assert.rejects(promise, reason);
    return;
  }
  const value = record(await promise);
  assert.equal(value.accepted, false, "Post-claim rejection retains the operation's inner envelope");
  assert.equal(value.sessionId, "session-a");
  assert.equal(value.revision, 1);
  assert.match(String(value.reason), reason);
}

for (const operation of operations) {
  test(`${operation}: pause during writer claim prevents admission`, { timeout: 5_000 }, async () => {
    const f = fixture();
    const claim = gate();
    f.controls.claimGate = claim.promise;
    // Keep queue controls realistic; no idle-queue acceptance is asserted.
    if (operation.includes("queue")) f.controls.kind = "runs";
    const rejected = expectRejected(f.request(operation), operation);
    await f.controls.claimEntered.promise;
    assert.equal(f.state.sessionWriterOwners.size, 0);
    f.connection.exitingForPause = true;
    claim.release();
    await rejected;
    assert.equal(f.counts.claim, 1);
    assert.equal(f.counts.mutations, 0);
    assert.equal(f.counts.tracked, 0);
  });
  test(`${operation}: unchanged client admits normally; another client's pause is isolated`, { timeout: 5_000 }, async () => {
    const f = fixture();
    f.connection.exitingForPause = true;
    if (operation.includes("queue")) f.controls.kind = "runs";
    const result = await f.request(operation, f.other);
    assert.notEqual(record(result).accepted, false);
    assert.equal(f.counts.mutations, 1);
    assert.equal(f.state.sessionWriterOwners.get("session-a")?.clientId, f.other.clientId);
  });
}
for (const operation of goals) {
  test(`${operation}: common post-runtimeEntry fence prevents a paused client's goal mutation`, { timeout: 5_000 }, async () => {
    const f = fixture();
    const route = gate();
    f.controls.routeGate = route.promise;
    if (operation.includes("queue")) f.controls.kind = "runs";
    const rejected = assert.rejects(f.request(operation), pauseError);
    await f.controls.routeEntered.promise;
    f.connection.exitingForPause = true;
    route.release();
    await rejected;
    assert.equal(f.counts.mutations, 0);
    assert.equal(f.counts.scheduled, 0);
    assert.equal(f.state.sessionGoalOwners.size, 0);
  });
  test(`${operation}: unpaused goal admission is preserved`, { timeout: 5_000 }, async () => {
    const f = fixture();
    const result = await f.request(operation);
    assert.equal(record(result).accepted, true);
    assert.equal(f.counts.mutations, 1);
    assert.equal(f.counts.scheduled, 1);
  });
}

for (const operation of [...operations, ...goals]) {
  test(`${operation}: pause during common routing rejects execute before any inner admission envelope`, { timeout: 5_000 }, async () => {
    const f = fixture();
    const route = gate();
    f.controls.routeGate = route.promise;
    if (operation.includes("queue")) f.controls.kind = "runs";
    const rejected = assert.rejects(f.request(operation), pauseError);
    await f.controls.routeEntered.promise;
    f.connection.exitingForPause = true;
    route.release();
    await rejected;
    assert.equal(f.counts.claim, 0);
    assert.equal(f.counts.mutations, 0);
    // handleFrame's outer catch turns this rejection into wire ok:false.
    // This is intentionally different from a post-claim inner accepted:false.
  });
  test(`${operation}: an already-paused client rejects at the original entry fence`, { timeout: 5_000 }, async () => {
    const f = fixture();
    f.connection.exitingForPause = true;
    await assert.rejects(f.request(operation), pauseError);
    assert.equal(f.counts.claim, 0);
    assert.equal(f.counts.mutations, 0);
  });
}
for (const failure of ["draining", "exhausted"] as const) {
  for (const operation of operations) {
    test(`${operation}: ${failure} during writer acquisition remains fenced`, { timeout: 5_000 }, async () => {
      const f = fixture();
      const claim = gate();
      f.controls.claimGate = claim.promise;
      if (operation.includes("queue")) f.controls.kind = "runs";
      const rejected = expectRejected(f.request(operation), operation,
        failure === "draining" ? /Host draining/u : /Event sequence exhausted/u);
      await f.controls.claimEntered.promise;
      f.controls[failure] = true;
      claim.release();
      await rejected;
      assert.equal(f.counts.mutations, 0);
      assert.equal(f.counts.tracked, 0);
    });
  }
}
test("run.submit preserves its pre-claim revision-conflict result", { timeout: 5_000 }, async () => {
  const f = fixture();
  const result = record(await f.request("run.submit", f.connection, { expectedRevision: 99 }));
  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, "run_revision_conflict_before_admission");
  assert.equal(result.sessionId, "session-a");
  assert.equal(result.revision, 1);
  assert.equal(record(result.errorData).expectedRevision, 99);
  assert.equal(record(result.errorData).currentRevision, 1);
  assert.equal(f.counts.claim, 0);
  assert.equal(f.counts.mutations, 0);
});
test("permission control remains available to a paused client, including while draining/exhausted", { timeout: 5_000 }, async () => {
  const f = fixture();
  f.connection.exitingForPause = true;
  f.controls.draining = true;
  f.controls.exhausted = true;
  await f.request("permission", f.connection, { result: "allow" });
  assert.equal(f.counts.permission, 1);
  assert.equal(f.counts.claim, 0);
  assert.equal(f.counts.mutations, 0);
});

for (const failure of ["draining", "exhausted"] as const) {
  for (const operation of ["run.submit", "session.goal.set"]) {
    test(`${operation}: ${failure} during common routing rejects execute before claiming or mutating`, { timeout: 5_000 }, async () => {
      const f = fixture();
      const route = gate();
      f.controls.routeGate = route.promise;
      if (operation.includes("queue")) f.controls.kind = "runs";
      const rejected = assert.rejects(f.request(operation),
        failure === "draining" ? /Host draining/u : /Event sequence exhausted/u);
      await f.controls.routeEntered.promise;
      f.controls[failure] = true;
      route.release();
      await rejected;
      assert.equal(f.counts.claim, 0);
      assert.equal(f.counts.mutations, 0);
      assert.equal(f.counts.scheduled, 0);
      assert.equal(f.state.sessionGoalOwners.size, 0);
    });
  }
}
for (const operation of ["queue", "run.queue"]) {
  test(`${operation} steer: pause during writer claim blocks delivery`, { timeout: 5_000 }, async () => {
    const f = fixture();
    const claim = gate();
    f.controls.kind = "runs";
    f.controls.claimGate = claim.promise;
    const rejected = expectRejected(f.request(operation, f.connection, { delivery: "steer" }), operation);
    await f.controls.claimEntered.promise;
    f.connection.exitingForPause = true;
    claim.release();
    await rejected;
    assert.equal(f.counts.claim, 1);
    assert.equal(f.counts.mutations, 0);
    assert.equal(f.counts.tracked, 0);
  });
  test(`${operation} steer: unpaused delivery to an active runtime remains accepted`, { timeout: 5_000 }, async () => {
    const f = fixture();
    f.controls.kind = "runs";
    const result = await f.request(operation, f.connection, { delivery: "steer" });
    assert.notEqual(record(result).accepted, false);
    assert.equal(f.counts.claim, 1);
    assert.equal(f.counts.mutations, 1);
    assert.equal(f.state.sessionWriterOwners.get("session-a")?.clientId, f.connection.clientId);
  });
}
