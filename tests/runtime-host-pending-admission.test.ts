import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Product source is inert text: no Host constructor, imports, sockets, stores or
// model code are loaded. Only the reviewed request/barrier methods execute below.
const source = readFileSync(new URL("../src/runtime/host/server.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const server = parsed.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostServer");
assert.ok(server);
function method(name: string): ts.MethodDeclaration {
  const matches = server!.members.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `Expected one ${name} method`);
  return matches[0]!;
}
const handleFrame = method("handleFrame").getText(parsed);
const register = method("registerPendingRunAdmission").getText(parsed);
const wait = method("waitForPendingRunAdmissions").getText(parsed);
const executeStatements = method("execute").body?.statements;
assert.ok(executeStatements);
const guards = executeStatements.filter((node): node is ts.IfStatement =>
  ts.isIfStatement(node) && node.expression.getText(parsed) === 'frame.operation === "run.inspect"');
assert.equal(guards.length, 1, "Expected one inspect barrier at execute's top level");
const guard = guards[0]!;
const routing = executeStatements[executeStatements.indexOf(guard) + 1];
assert.ok(routing);
assert.equal(routing.getText(parsed), "const managed = await this.runtimeEntry(frame.operation, payload);",
  "The inspect barrier must immediately precede common runtime routing");
const inspect = `${guard.getText(parsed)}\n${routing.getText(parsed)}`;
assert.match(source, /private readonly pendingRunAdmissions = new Map<string, Set<Promise<void>>>\(\);/u);
// Keep the real inspect guard and the immediately following routing call intact;
// the rest of execute is replaced by an in-memory boundary, never evaluated.
const isolated = stripTypeScriptTypes(`class PendingAdmissionHarness {
${handleFrame}
${register}
${wait}
async inspect(frame: unknown, payload: unknown): Promise<unknown> {
${inspect}
return managed;
}
}
PendingAdmissionHarness.prototype;`, { mode: "strip" });

type Lane = "run" | "query";
interface RequestFrame {
  kind: "request";
  requestId: string;
  operation: string;
  payload: Record<string, unknown>;
}
interface Connection {
  authenticated: boolean;
  clientId: string;
  surface: string;
  socket: { destroyed: boolean; destroy(error?: Error): void };
}
interface Managed {
  sessionId: string;
  runtime: { getSnapshot(): { state: { kind: "idle" | "runs" } } };
}
interface FixtureState {
  pendingRunAdmissions: Map<string, Set<Promise<void>>>;
  pendingRequests: number;
  activityRevision: number;
  idleSince?: number;
  closePromise?: Promise<void>;
  registry: { primary(): Managed; get(sessionId: string): Managed | undefined };
  sessionWriterOwners: Map<string, { clientId: string; pendingCompletions: number }>;
  dispatcher: { dispatch(lane: Lane, work: () => Promise<unknown>, key?: string): Promise<unknown> };
  businessComposition: { scheduleGraphs(): void };
  execute(connection: Connection, frame: RequestFrame): Promise<unknown>;
  runtimeEntry(operation: string, payload: Record<string, unknown>): Promise<Managed>;
  releaseSessionWriter(connection: Connection, sessionId: string): Promise<void>;
  send(connection: Connection, response: Record<string, unknown>): void;
  registerPendingRunAdmission(runId: string): () => void;
  waitForPendingRunAdmissions(runId: string): Promise<void>;
}
interface Extracted {
  handleFrame(this: FixtureState, connection: Connection, frame: unknown): Promise<void>;
  registerPendingRunAdmission(this: FixtureState, runId: string): () => void;
  waitForPendingRunAdmissions(this: FixtureState, runId: string): Promise<void>;
  inspect(this: FixtureState, frame: RequestFrame, payload: Record<string, unknown>): Promise<Managed>;
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const lane = (operation: string): Lane =>
  operation === "run.inspect" || operation === "snapshot" ? "query" : "run";
class FakeCompletion {
  readonly completion: Promise<unknown>;
  constructor(completion: Promise<unknown>) { this.completion = completion; }
}
const extracted = runInNewContext(isolated, {
  asRecord: record,
  optionalString: (value: unknown) => typeof value === "string" ? value : undefined,
  requiredString: (value: unknown, name: string) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
    return value;
  },
  isHelloFrame: () => false,
  isRequestFrame: (value: unknown) => {
    const frame = record(value);
    return frame.kind === "request" && typeof frame.requestId === "string" && typeof frame.operation === "string";
  },
  operationLane: lane,
  operationLaneKey: (operation: string, payload: Record<string, unknown>, primary: string) =>
    lane(operation) === "query" ? undefined : typeof payload.sessionId === "string" ? payload.sessionId : primary,
  OperationCompletion: FakeCompletion,
  publicError: (error: unknown) => error instanceof Error ? error.message : String(error),
  publicErrorCode: () => undefined,
  publicErrorData: () => undefined
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Extracted;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
interface FixtureOptions {
  dispatchGate?: Promise<void>;
  dispatchError?: "throw" | "reject";
  releaseGate?: Promise<void>;
  idle?: boolean;
  execute?: (frame: RequestFrame) => Promise<unknown>;
}
function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const responses = new Map<string, Record<string, unknown>>();
  const records = new Map<string, unknown>();
  const managed: Managed = {
    sessionId: "session-a",
    runtime: { getSnapshot: () => ({ state: { kind: options.idle ? "idle" : "runs" } }) }
  };
  const connection: Connection = {
    authenticated: true, clientId: "original-client", surface: "desktop",
    socket: { destroyed: false, destroy() { this.destroyed = true; } }
  };
  let nextId = 0;
  const state: FixtureState = {
    pendingRunAdmissions: new Map(), pendingRequests: 0, activityRevision: 0,
    registry: { primary: () => managed, get: (sessionId) => sessionId === managed.sessionId ? managed : undefined },
    sessionWriterOwners: new Map(),
    dispatcher: {
      dispatch: (operationLane, work) => {
        events.push(`dispatch:${operationLane}:${state.pendingRunAdmissions.size}`);
        if (options.dispatchError === "throw") throw new Error("dispatch failed");
        if (options.dispatchError === "reject") return Promise.reject(new Error("dispatch failed"));
        // Fake dispatch deliberately keeps query work independent of gated writes.
        return Promise.resolve().then(async () => {
          if (operationLane === "run" && options.dispatchGate) await options.dispatchGate;
          return await work();
        }).then((result) => result instanceof FakeCompletion ? result.completion : result);
      }
    },
    businessComposition: { scheduleGraphs: () => { events.push("schedule-graphs"); } },
    execute: async (_connection, frame) => {
      events.push(`execute:${frame.operation}`);
      if (frame.operation === "run.inspect") {
        await extracted.inspect.call(state, frame, frame.payload);
        return records.get(String(frame.payload.runId));
      }
      if (frame.operation === "snapshot") return { state: "readable" };
      return await options.execute?.(frame);
    },
    runtimeEntry: async (operation, payload) => {
      events.push(`route:${operation}:${String(payload.runId)}`);
      return managed;
    },
    releaseSessionWriter: async () => {
      events.push("release-writer");
      if (options.releaseGate) await options.releaseGate;
    },
    send: (_connection, response) => { responses.set(String(response.requestId), response); },
    registerPendingRunAdmission: extracted.registerPendingRunAdmission,
    waitForPendingRunAdmissions: extracted.waitForPendingRunAdmissions
  };
  const request = (operation: string, payload: Record<string, unknown> = {}, client = connection) => {
    const requestId = `request-${++nextId}`;
    const done = extracted.handleFrame.call(state, client, { kind: "request", requestId, operation, payload });
    return { requestId, done, response: () => responses.get(requestId) };
  };
  return { state, connection, records, events, request };
}

for (const operation of ["run.submit", "start-interrupted"]) {
  test(`${operation}: register before dispatch and inspect after admission, without waiting for completion`, async () => {
    const dispatch = gate();
    const admission = gate();
    const entered = gate();
    const model = gate();
    let admitted = 0;
    const f = fixture({ dispatchGate: dispatch.promise, execute: async (frame) => {
      entered.release();
      await admission.promise;
      admitted += 1;
      f.records.set(String(frame.payload.runId), { runId: frame.payload.runId, sessionId: "session-a" });
      // A submitted handle may carry an unfinished model promise; admission does not await it.
      return { runId: frame.payload.runId, completion: model.promise };
    } });
    const submitted = f.request(operation, { runId: " pending-run " });
    assert.equal(f.state.pendingRunAdmissions.get(" pending-run ")?.size, 1);
    assert.equal(f.state.pendingRunAdmissions.has("pending-run"), false, "Run IDs are never normalized");
    assert.equal(f.events[0], "dispatch:run:1", "Registration must precede dispatcher invocation");
    const inspected = f.request("run.inspect", { runId: " pending-run " });
    await f.request("snapshot").done;
    assert.equal(inspected.response(), undefined);
    assert.equal(f.events.some((event) => event.startsWith("route:")), false);
    dispatch.release();
    await entered.promise;
    f.connection.socket.destroy();
    await f.request("snapshot").done;
    assert.equal(inspected.response(), undefined, "Disconnect does not settle a still-pending admission");
    admission.release();
    await Promise.all([submitted.done, inspected.done]);
    assert.equal(record(inspected.response()?.result).sessionId, "session-a");
    assert.equal(f.state.pendingRunAdmissions.size, 0);
    assert.equal(admitted, 1, "Inspect never replays a submission");
    model.release();
  });
}

test("same-run duplicates retain separate tokens until both requests settle", async () => {
  const first = gate();
  const second = gate();
  const f = fixture({ execute: async (frame) => {
    await (frame.payload.attempt === 1 ? first.promise : second.promise);
    return { accepted: false };
  } });
  const a = f.request("run.submit", { runId: "duplicate", attempt: 1 });
  const b = f.request("run.submit", { runId: "duplicate", attempt: 2 });
  const inspect = f.request("run.inspect", { runId: "duplicate" });
  assert.equal(f.state.pendingRunAdmissions.get("duplicate")?.size, 2);
  first.release();
  await a.done;
  await f.request("snapshot").done;
  assert.equal(f.state.pendingRunAdmissions.get("duplicate")?.size, 1);
  assert.equal(inspect.response(), undefined);
  second.release();
  await Promise.all([b.done, inspect.done]);
  assert.equal(inspect.response()?.ok, true);
  assert.equal(inspect.response()?.result, undefined);
  assert.equal(f.state.pendingRunAdmissions.size, 0);
});

test("inspect drains new same-run tokens registered while its first snapshot is pending", async () => {
  const f = fixture();
  const finishFirst = f.state.registerPendingRunAdmission("again");
  const inspected = f.request("run.inspect", { runId: "again" });
  await f.request("snapshot").done;
  finishFirst();
  // Replaces the emptied Set before the waiting Promise.all continuation runs.
  const finishSecond = f.state.registerPendingRunAdmission("again");
  await f.request("snapshot").done;
  await f.request("snapshot").done;
  assert.equal(inspected.response(), undefined);
  finishFirst();
  assert.equal(f.state.pendingRunAdmissions.get("again")?.size, 1, "Old cleanup cannot delete a replacement Set");
  finishSecond();
  await inspected.done;
  assert.equal(f.state.pendingRunAdmissions.size, 0);
});

for (const dispatchError of ["throw", "reject"] as const) {
  test(`dispatcher ${dispatchError} releases its token without a rejecting barrier promise`, async () => {
    const f = fixture({ dispatchError });
    const request = f.request("run.submit", { runId: "failed-dispatch" });
    const waiting = f.state.waitForPendingRunAdmissions("failed-dispatch");
    await Promise.all([request.done, waiting]);
    assert.equal(request.response()?.ok, false);
    assert.equal(f.state.pendingRunAdmissions.size, 0);
    assert.equal(f.state.pendingRequests, 0);
    assert.equal(f.events.some((event) => event.startsWith("execute:")), false);
  });
}

for (const outcome of ["reject", "not-accepted", "no-interrupted-turn"] as const) {
  test(`${outcome} cleans up and lets inspect report absence`, async () => {
    const admission = gate();
    const f = fixture({ execute: async () => {
      await admission.promise;
      if (outcome === "reject") throw new Error("admission failed");
      return outcome === "not-accepted" ? { accepted: false } : undefined;
    } });
    const request = f.request(outcome === "no-interrupted-turn" ? "start-interrupted" : "run.submit", { runId: "absent" });
    const inspected = f.request("run.inspect", { runId: "absent" });
    await f.request("snapshot").done;
    assert.equal(inspected.response(), undefined);
    admission.release();
    await Promise.all([request.done, inspected.done]);
    assert.equal(inspected.response()?.ok, true);
    assert.equal(inspected.response()?.result, undefined);
    assert.equal(f.state.pendingRunAdmissions.size, 0);
  });
}

test("inspect does not await detached OperationCompletion or writer cleanup", async () => {
  const model = gate();
  const release = gate();
  const f = fixture({ idle: true, releaseGate: release.promise, execute: async () => new FakeCompletion(model.promise) });
  f.state.sessionWriterOwners.set("session-a", { clientId: f.connection.clientId, pendingCompletions: 0 });
  const submitted = f.request("run.submit", { runId: "detached" });
  await f.request("run.inspect", { runId: "detached" }).done;
  assert.equal(f.state.pendingRunAdmissions.size, 0);
  assert.equal(submitted.response(), undefined);
  model.release();
  await f.request("snapshot").done;
  assert.equal(submitted.response(), undefined, "Writer cleanup is still gated");
  release.release();
  await submitted.done;
});

test("settled direct admission releases its barrier before idle writer cleanup", async () => {
  const release = gate();
  const f = fixture({ idle: true, releaseGate: release.promise });
  const submitted = f.request("start-interrupted", { runId: "idle-cleanup" });
  await f.request("run.inspect", { runId: "idle-cleanup" }).done;
  assert.equal(f.state.pendingRunAdmissions.size, 0);
  assert.equal(submitted.response(), undefined);
  assert.ok(f.events.includes("release-writer"));
  release.release();
  await submitted.done;
});

test("unrelated runs and snapshots stay readable while one admission is pending", async () => {
  const admission = gate();
  const f = fixture({ execute: async () => { await admission.promise; } });
  const submitted = f.request("run.submit", { runId: "blocked-run" });
  const blocked = f.request("run.inspect", { runId: "blocked-run" });
  const unrelated = f.request("run.inspect", { runId: "other-run" });
  const snapshot = f.request("snapshot");
  await Promise.all([unrelated.done, snapshot.done]);
  assert.equal(unrelated.response()?.ok, true);
  assert.equal(snapshot.response()?.ok, true);
  assert.equal(blocked.response(), undefined);
  admission.release();
  await Promise.all([submitted.done, blocked.done]);
});

test("authentication, request shape, direct-operation scope and usable runId bound registration", async () => {
  const f = fixture();
  f.connection.authenticated = false;
  await f.request("run.submit", { runId: "unauthenticated" }).done;
  assert.equal(f.state.pendingRunAdmissions.size, 0);
  assert.equal(f.events.length, 0);
  f.connection.authenticated = true;
  await extracted.handleFrame.call(f.state, f.connection, { kind: "event", operation: "submit", payload: { runId: "invalid-frame" } });
  assert.equal(f.state.pendingRunAdmissions.size, 0);
  assert.equal(f.events.length, 0);
  for (const runId of [undefined, null, "", "   ", 7]) {
    const request = f.request("run.submit", { runId });
    assert.equal(f.state.pendingRunAdmissions.size, 0);
    await request.done;
  }
  for (const operation of ["queue", "run.queue", "run.continue"]) {
    const request = f.request(operation, { runId: "not-a-direct-admission" });
    assert.equal(f.state.pendingRunAdmissions.size, 0);
    await request.done;
  }
});
