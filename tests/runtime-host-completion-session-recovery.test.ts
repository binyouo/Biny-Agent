import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Parse source as data. Never import the client or initialize Host/socket/SQLite code.
const source = readFileSync(new URL("../src/runtime/host/client.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const classes = parsed.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostClient");
assert.equal(classes.length, 1);
const clientClass = classes[0];
assert.ok(clientClass);
const methods = ["recoverCompletions", "activeRunId", "refreshRuntimeSnapshot"].map((name) => {
  const matches = clientClass.members.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `Missing or duplicate ${name}`);
  const method = matches[0];
  assert.ok(method);
  return method.getText(parsed);
});
const isolated = stripTypeScriptTypes(`class Recovery { ${methods.join("\n")} }\nRecovery.prototype;`, { mode: "strip" });

interface Outcome {
  runId: string;
  status: string;
  stopReason: string;
  finishReason?: string;
  steps: number;
  output: string;
  durationMs: number;
  error?: string;
}
interface Snapshot {
  info?: { sessionId: string };
  state: { kind: "idle" } | { kind: "runs"; activeRun: { runId: string } };
}
interface Socket { destroyed: boolean }
interface Pending {
  resolve(outcome: Outcome): void;
  reject(error: Error): void;
}
interface Fixture {
  socket?: Socket;
  hostEpoch: string;
  closed: boolean;
  retired: boolean;
  focusedSessionId: string;
  snapshots: Map<string, Snapshot>;
  snapshot?: Snapshot;
  completions: Map<string, Pending>;
  inspectRun(runId: string): Promise<unknown>;
  request<T>(operation: string, payload: unknown, timeoutMs?: number, onDispatch?: (socket: Socket) => void): Promise<T>;
  refreshRuntimeSnapshot(sessionId?: string, assertCurrent?: (socket: Socket) => void): Promise<void>;
  applySessionSummaries(sessions: unknown, sequence: number): void;
  applySnapshot(snapshot: Snapshot, sequence: number, hostEpoch?: string, focused?: boolean): void;
  reportError(error: unknown): void;
  activeRunId(sessionId?: string): string | undefined;
}
interface Extracted {
  recoverCompletions(this: Fixture): Promise<void>;
  activeRunId(this: Fixture, sessionId?: string): string | undefined;
  refreshRuntimeSnapshot(this: Fixture, sessionId?: string, assertCurrent?: (socket: Socket) => void): Promise<void>;
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
// These inert boundary stubs have no imports or external effects. Recovery's actual
// session selection and settlement branches above are extracted unchanged.
const extracted = runInNewContext(isolated, {
  asRecord: record,
  isTransientHostError: () => false,
  readRecoveryStopReason: (value: unknown) => typeof value === "string" ? value : "provider_error",
  isAgentRunOutcome: (value: unknown) => {
    const item = record(value);
    return typeof item.runId === "string" && typeof item.status === "string"
      && typeof item.stopReason === "string" && typeof item.steps === "number"
      && typeof item.durationMs === "number" && typeof item.output === "string";
  }
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Extracted;

const live = (runId: string): Snapshot => ({ state: { kind: "runs", activeRun: { runId } } });
const idle = (): Snapshot => ({ state: { kind: "idle" } });
const outcome = (runId: string): Outcome => ({
  runId, status: "completed", stopReason: "completed", steps: 1, output: "done", durationMs: 2
});

function fixture(focusedSessionId: string, snapshots: Array<[string, Snapshot]>, records: Record<string, unknown>) {
  const settled = new Map<string, { outcome?: Outcome; error?: Error; count: number }>();
  const promises = new Map<string, Promise<Outcome>>();
  const requests: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const hooks: { beforeDispatch?: (operation: string) => void; respond?: (operation: string, payload: Record<string, unknown>) => Promise<unknown> } = {};
  const state: Fixture = {
    socket: { destroyed: false },
    hostEpoch: "epoch-a",
    closed: false,
    retired: false,
    focusedSessionId,
    snapshots: new Map(snapshots),
    completions: new Map(),
    inspectRun: async (runId) => await state.request("run.inspect", { runId }),
    request: async <T>(operation: string, payload: unknown, _timeoutMs?: number, onDispatch?: (socket: Socket) => void): Promise<T> => {
      hooks.beforeDispatch?.(operation);
      assert.ok(state.socket);
      onDispatch?.(state.socket);
      const input = record(payload);
      requests.push({ operation, payload: input });
      if (hooks.respond) return await hooks.respond(operation, input) as T;
      if (operation === "run.inspect") return records[String(input.runId)] as T;
      assert.equal(operation, "snapshot");
      const sessionId = String(input.sessionId);
      return { snapshot: { ...(state.snapshots.get(sessionId) ?? idle()), info: { sessionId } }, sessions: [], sequence: 1 } as T;
    },
    refreshRuntimeSnapshot: extracted.refreshRuntimeSnapshot,
    applySessionSummaries: () => { writes.push("sessions"); },
    applySnapshot: (snapshot) => {
      writes.push("snapshot");
      if (snapshot.info) state.snapshots.set(snapshot.info.sessionId, snapshot);
    },
    reportError: (error) => { throw error; },
    activeRunId: extracted.activeRunId
  };
  const add = (runId: string): void => {
    const observation: { outcome?: Outcome; error?: Error; count: number } = { count: 0 };
    settled.set(runId, observation);
    const promise = new Promise<Outcome>((resolve, reject) => {
      state.completions.set(runId, {
        resolve: (value) => { observation.outcome = value; observation.count += 1; resolve(value); },
        reject: (error) => { observation.error = error; observation.count += 1; reject(error); }
      });
    });
    void promise.catch(() => undefined);
    promises.set(runId, promise);
  };
  // In-memory completion delivery boundary, matching removal-before-resolution.
  const deliver = (runId: string): void => {
    const pending = state.completions.get(runId);
    if (!pending) return;
    state.completions.delete(runId);
    pending.resolve(outcome(runId));
  };
  return { state, settled, promises, requests, writes, hooks, records, add, deliver, recover: () => extracted.recoverCompletions.call(state) };
}

for (const focus of ["session-a", "session-b"]) {
  test(`live completion survives recovery while focused on ${focus}`, async () => {
    const f = fixture(focus, [["session-a", live("run-a")], ["session-b", idle()]], {
      "run-a": { runId: "run-a", sessionId: "session-a" }
    });
    f.add("run-a");
    await f.recover();
    assert.equal(f.settled.get("run-a")?.count, 0);
    assert.equal(f.state.completions.has("run-a"), true);
    f.deliver("run-a");
    f.deliver("run-a");
    assert.deepEqual(await f.promises.get("run-a"), outcome("run-a"));
    assert.equal(f.settled.get("run-a")?.count, 1);
  });
}

test("two live sessions retain independent completion handles", async () => {
  const f = fixture("session-b", [["session-a", live("run-a")], ["session-b", live("run-b")]], {
    "run-a": { runId: "run-a", sessionId: "session-a" },
    "run-b": { runId: "run-b", sessionId: "session-b" }
  });
  f.add("run-a"); f.add("run-b");
  await f.recover();
  assert.equal(f.state.completions.size, 2);
  assert.equal(f.settled.get("run-a")?.count, 0);
  assert.equal(f.settled.get("run-b")?.count, 0);
  f.deliver("run-b"); f.deliver("run-a");
  assert.equal((await f.promises.get("run-a"))?.runId, "run-a");
  assert.equal((await f.promises.get("run-b"))?.runId, "run-b");
});

for (const sessionId of [undefined, null, "", 1, {}, []]) {
  test(`malformed inspected owner ${JSON.stringify(sessionId)} never falls back to focus`, async () => {
    const f = fixture("session-a", [["session-a", live("run-a")]], {
      "run-a": { runId: "run-a", sessionId }
    });
    f.add("run-a");
    await f.recover();
    assert.match(f.settled.get("run-a")?.error?.message ?? "", /no active Host execution/);
    assert.equal(f.state.completions.has("run-a"), false);
    f.deliver("run-a");
    assert.equal(f.settled.get("run-a")?.count, 1);
  });
}

for (const owner of [undefined, idle(), live("different-run")]) {
  test(`missing, idle or wrong-run owner rejects despite focused matching run: ${JSON.stringify(owner)}`, async () => {
    const snapshots: Array<[string, Snapshot]> = [["session-b", live("run-a")]];
    if (owner) snapshots.push(["session-a", owner]);
    const f = fixture("session-b", snapshots, { "run-a": { runId: "run-a", sessionId: "session-a" } });
    f.add("run-a");
    await f.recover();
    assert.match(f.settled.get("run-a")?.error?.message ?? "", /no active Host execution/);
    assert.equal(f.state.completions.size, 0);
  });
}

test("terminal and absent records keep their established settlement", async () => {
  const f = fixture("session-b", [["session-b", idle()]], {
    "run-a": { runId: "run-a", sessionId: "session-a", terminalStatus: "completed",
      terminalPayload: { stopReason: "completed", steps: 1, output: "done", projection: { durationMs: 2 } } }
  });
  f.add("run-a"); f.add("absent");
  await f.recover();
  assert.equal((await f.promises.get("run-a"))?.output, "done");
  assert.match(f.settled.get("absent")?.error?.message ?? "", /was not admitted/);
  assert.equal(f.state.completions.size, 0);
  f.deliver("run-a"); f.deliver("absent");
  assert.equal(f.settled.get("run-a")?.count, 1);
  assert.equal(f.settled.get("absent")?.count, 1);
});

function gate() {
  let release = (): void => { throw new Error("Uninitialized gate"); };
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function snapshotReply(sessionId: string, snapshot: Snapshot) {
  return { snapshot: { ...snapshot, info: { sessionId } }, sessions: [], sequence: 2 };
}

function terminalRecord(runId: string, sessionId = "session-a") {
  return { runId, sessionId, terminalStatus: "completed",
    terminalPayload: { stopReason: "completed", steps: 1, output: "done", projection: { durationMs: 2 } } };
}

test("inspection released after admission refreshes an earlier idle subscription", async () => {
  const f = fixture("session-b", [["session-a", idle()], ["session-b", idle()]], {});
  const entered = gate();
  const admission = gate();
  f.hooks.respond = async (operation, payload) => {
    if (operation === "run.inspect") {
      entered.release();
      await admission.promise;
      return { runId: "run-a", sessionId: "session-a" };
    }
    assert.equal(payload.sessionId, "session-a", "Recovery refreshes the inspected owner");
    return snapshotReply("session-a", live("run-a"));
  };
  f.add("run-a");
  const recovering = f.recover();
  try {
    await entered.promise;
    assert.equal(f.settled.get("run-a")?.count, 0);
    admission.release();
    await recovering;
    assert.equal(f.settled.get("run-a")?.count, 0);
    assert.equal(f.state.completions.has("run-a"), true);
    assert.deepEqual(f.requests.map((item) => item.operation), ["run.inspect", "snapshot"]);
    f.deliver("run-a");
    assert.equal((await f.promises.get("run-a"))?.output, "done");
  } finally {
    admission.release();
    await recovering;
  }
});

test("terminal transition between inspection and snapshot resolves on one reinspection", async () => {
  const f = fixture("session-b", [["session-a", live("run-a")], ["session-b", idle()]], {});
  let inspections = 0;
  f.hooks.respond = async (operation) => {
    if (operation === "snapshot") return snapshotReply("session-a", idle());
    inspections += 1;
    return inspections === 1 ? { runId: "run-a", sessionId: "session-a" } : terminalRecord("run-a");
  };
  f.add("run-a");
  await f.recover();
  assert.equal(inspections, 2);
  assert.deepEqual(f.requests.map((item) => item.operation), ["run.inspect", "snapshot", "run.inspect"]);
  assert.equal((await f.promises.get("run-a"))?.output, "done");
  assert.equal(f.settled.get("run-a")?.count, 1);
});

test("terminal reinspection cannot switch the inspected owner", async () => {
  const f = fixture("session-b", [["session-a", idle()], ["session-b", live("run-a")]], {});
  let inspections = 0;
  f.hooks.respond = async (operation) => {
    if (operation === "snapshot") return snapshotReply("session-a", idle());
    inspections += 1;
    return inspections === 1 ? { runId: "run-a", sessionId: "session-a" } : terminalRecord("run-a", "session-b");
  };
  f.add("run-a");
  await f.recover();
  assert.match(f.settled.get("run-a")?.error?.message ?? "", /no active Host execution/);
  assert.equal(f.settled.get("run-a")?.outcome, undefined);
});

for (const phase of ["inspection", "snapshot", "reinspection"] as const) {
  for (const change of ["socket", "epoch", "closed", "retired", "destroyed"] as const) {
    test(`${change} change during ${phase} abandons the stale recovery loop`, async () => {
      const f = fixture("session-b", [["session-a", idle()], ["session-b", idle()]], {});
      let inspections = 0;
      f.hooks.respond = async (operation) => {
        if (operation === "run.inspect") inspections += 1;
        const currentPhase = operation === "snapshot" ? "snapshot" : inspections === 1 ? "inspection" : "reinspection";
        if (currentPhase === phase) {
          if (change === "socket") f.state.socket = { destroyed: false };
          else if (change === "epoch") f.state.hostEpoch = "epoch-b";
          else if (change === "closed") f.state.closed = true;
          else if (change === "retired") f.state.retired = true;
          else { assert.ok(f.state.socket); f.state.socket.destroyed = true; }
        }
        return operation === "snapshot" ? snapshotReply("session-a", idle())
          : inspections === 1 ? { runId: "run-a", sessionId: "session-a" } : terminalRecord("run-a");
      };
      f.add("run-a"); f.add("run-b");
      await f.recover();
      assert.equal(f.settled.get("run-a")?.count, 0);
      assert.equal(f.settled.get("run-b")?.count, 0);
      assert.equal(f.requests.some((item) => item.payload.runId === "run-b"), false);
      assert.deepEqual(f.writes, phase === "reinspection" ? ["sessions", "snapshot"] : []);
    });
  }
  for (const change of ["settled", "replaced"] as const) {
    test(`completion ${change} during ${phase} is untouched by its old recovery`, async () => {
      const f = fixture("session-b", [["session-a", idle()], ["session-b", idle()]], {});
      f.add("run-a");
      const oldObservation = f.settled.get("run-a");
      let inspections = 0;
      f.hooks.respond = async (operation) => {
        if (operation === "run.inspect") inspections += 1;
        const currentPhase = operation === "snapshot" ? "snapshot" : inspections === 1 ? "inspection" : "reinspection";
        if (currentPhase === phase) {
          if (change === "settled") f.deliver("run-a");
          else f.add("run-a");
        }
        return operation === "snapshot" ? snapshotReply("session-a", idle())
          : inspections === 1 ? { runId: "run-a", sessionId: "session-a" } : terminalRecord("run-a");
      };
      await f.recover();
      assert.equal(oldObservation?.count, change === "settled" ? 1 : 0);
      assert.equal(oldObservation?.error, undefined);
      assert.equal(f.state.completions.has("run-a"), change === "replaced");
      if (change === "replaced") assert.equal(f.settled.get("run-a")?.count, 0);
      assert.deepEqual(f.writes, phase === "reinspection" ? ["sessions", "snapshot"] : []);
    });
  }
}

for (const phase of ["inspection", "snapshot", "reinspection"] as const) {
  test(`connection changes before ${phase} dispatch cannot cross to a new socket`, async () => {
    const f = fixture("session-a", [["session-a", idle()]], {
      "run-a": { runId: "run-a", sessionId: "session-a" }
    });
    let inspections = 0;
    f.hooks.beforeDispatch = (operation) => {
      if (operation === "run.inspect") inspections += 1;
      const currentPhase = operation === "snapshot" ? "snapshot" : inspections === 1 ? "inspection" : "reinspection";
      if (currentPhase === phase) f.state.socket = { destroyed: false };
    };
    f.add("run-a");
    await f.recover();
    assert.equal(f.settled.get("run-a")?.count, 0);
    assert.equal(f.requests.length, phase === "inspection" ? 0 : phase === "snapshot" ? 1 : 2);
  });
}
