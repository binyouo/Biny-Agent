/** Read source as data; never import the product, open sockets, or reject an unobserved native Promise. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_INTERRUPTED_SOURCE_ROOT ?? process.cwd();
const clientSource = readFileSync(process.env.BINY_INTERRUPTED_BASELINE_CLIENT ?? path.join(root, "src/runtime/host/client.ts"), "utf8");
const validationSource = readFileSync(path.join(root, "src/runtime/host/validation.ts"), "utf8");
const parsed = ts.createSourceFile("client.ts", clientSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const client = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostClient");
assert.ok(client);
const methodNames = ["startInterruptedTurnForSession", "createCompletion", "rejectCompletion", "rejectCompletions", "recoverCompletions", "activeRunId", "close"];
const methods = methodNames.map((name) => {
  const method = client.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.ok(method, `Missing reviewed method ${name}`);
  return method.getText(parsed);
});
const validation = ts.createSourceFile("validation.ts", validationSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const helpers = ["asError", "isTransientHostError"].map((name) => {
  const declaration = validation.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing reviewed helper ${name}`);
  return declaration.getText(validation).replace(/^export\s+/u, "");
});

interface Outcome { runId: string; status: string; stopReason: string; steps: number; output: string; durationMs: number }
interface Ids { runId: string; messageId: string; turnId: string }
interface Pending { resolve(value: Outcome): void; reject(error: Error): void }
interface Handle { runId: string; messageId: string; completion: RecordingCompletion }
class RecordingCompletion {
  observed = 0;
  settled = 0;
  error?: Error;
  outcome?: Outcome;
  observedAtRejection?: boolean;
  constructor(executor: (resolve: (value: Outcome) => void, reject: (error: Error) => void) => void) {
    executor((value) => { this.settled += 1; this.outcome = value; }, (error) => {
      this.settled += 1; this.error = error; this.observedAtRejection = this.observed > 0;
    });
  }
  catch(_handler: (error: Error) => unknown): Promise<void> {
    this.observed += 1;
    return Promise.resolve();
  }
}
interface Fixture {
  options: { surface: string };
  completions: Map<string, Pending>;
  pending: Map<string, { reject(error: Error): void }>;
  idleWaiters: Set<() => void>;
  closed: boolean;
  retired: boolean;
  socket: { destroyed: boolean };
  hostEpoch: string;
  focusedSessionId: string;
  snapshots: Map<string, { state: { kind: string; activeRun?: { runId: string } } }>;
  request(operation: string, payload: unknown, timeout?: number, onDispatch?: (socket: Fixture["socket"]) => void): Promise<unknown>;
  scheduleReconnect(): void;
  currentRevision(): number;
  createCompletion(runId: string): RecordingCompletion;
  rejectCompletion(runId: string, error: unknown): void;
  rejectCompletions(error: Error): void;
  recoverCompletions(): Promise<void>;
  activeRunId(sessionId?: string): string | undefined;
  refreshRuntimeSnapshot(sessionId: string, assertCurrent: (socket: Fixture["socket"]) => void): Promise<void>;
  disconnectSocket(): Promise<void>;
  reportError(error: unknown): void;
}
interface Extracted {
  startInterruptedTurnForSession(this: Fixture, sessionId: string, ids: Ids, mode: "exact" | "newTurn"): Promise<Handle | undefined>;
  createCompletion(this: Fixture, runId: string): RecordingCompletion;
  rejectCompletion(this: Fixture, runId: string, error: unknown): void;
  rejectCompletions(this: Fixture, error: Error): void;
  recoverCompletions(this: Fixture): Promise<void>;
  activeRunId(this: Fixture, sessionId?: string): string | undefined;
  close(this: Fixture): Promise<void>;
}
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const compiled = ts.transpileModule(`${helpers.join("\n")}\nclass Isolated { ${methods.join("\n")} }\nIsolated.prototype;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const extracted = runInNewContext(compiled, {
  Promise: RecordingCompletion, Error,
  normalizeRequestIds: (ids: Ids) => ids,
  asRecord: record,
  readRecoveryStopReason: (value: unknown) => value,
  isAgentRunOutcome: (value: unknown) => record(value).status === "completed",
  clearTimeout: () => { throw new Error("Unexpected real timer boundary"); }
}, { timeout: 1_000 }) as Extracted;

const ids = { runId: "run-a", messageId: "message-a", turnId: "turn-a" };
const outcome: Outcome = { runId: ids.runId, status: "completed", stopReason: "model_stop", steps: 1, output: "done", durationMs: 2 };
type Scenario = "absent" | "ownerless" | "inactive" | "close" | "terminal" | "active" | "success" | "empty" | "nontransient";
function fixture(scenario: Scenario) {
  const failure = new Error(scenario === "nontransient" ? "Cannot continue while busy." : "Runtime Host connection closed.");
  let completion!: RecordingCompletion;
  let reconnects = 0;
  const requests: Array<{ operation: string; payload: unknown }> = [];
  const state: Fixture = {
    options: { surface: "desktop" }, completions: new Map(), pending: new Map(), idleWaiters: new Set(), ownerNotificationListeners: new Set(), closed: false, retired: false,
    socket: { destroyed: false }, hostEpoch: "epoch", focusedSessionId: "session-a",
    snapshots: new Map([["session-a", { state: scenario === "active" ? { kind: "runs", activeRun: { runId: ids.runId } } : { kind: "idle" } }]]),
    request: async (operation, payload, _timeout, onDispatch) => {
      onDispatch?.(state.socket);
      requests.push({ operation, payload });
      if (operation === "start-interrupted") {
        if (scenario === "empty") return undefined;
        if (scenario === "success") return ids;
        throw failure;
      }
      assert.equal(operation, "run.inspect");
      if (scenario === "absent") return undefined;
      if (scenario === "ownerless") return { runId: ids.runId };
      if (scenario === "terminal") return { sessionId: "session-a", terminalStatus: "completed", terminalPayload: { ...outcome, projection: { durationMs: 2 } } };
      return { sessionId: "session-a" };
    },
    scheduleReconnect: () => { reconnects += 1; }, currentRevision: () => 7,
    createCompletion: (runId) => { completion = extracted.createCompletion.call(state, runId); return completion; },
    rejectCompletion: extracted.rejectCompletion, rejectCompletions: extracted.rejectCompletions,
    recoverCompletions: extracted.recoverCompletions, activeRunId: extracted.activeRunId,
    refreshRuntimeSnapshot: async (_session, assertCurrent) => { assertCurrent(state.socket); },
    disconnectSocket: async () => { state.socket.destroyed = true; }, reportError: (error) => { throw error; }
  };
  return { state, failure, requests, completion: () => completion, reconnects: () => reconnects,
    start: () => extracted.startInterruptedTurnForSession.call(state, "session-a", ids, "newTurn") };
}

for (const scenario of ["absent", "ownerless", "inactive", "close"] as const) {
  test(`lost interrupted handle observes later ${scenario} rejection`, async () => {
    const f = fixture(scenario);
    await assert.rejects(f.start(), (error) => error === f.failure);
    const observersAtCallerError = f.completion().observed;
    assert.equal(f.reconnects(), 1);
    assert.equal(f.state.completions.size, 1, "uncertain admission remains tracked");
    assert.equal(f.completion().settled, 0);
    if (scenario === "close") await extracted.close.call(f.state);
    else await f.state.recoverCompletions();
    assert.equal(f.completion().settled, 1);
    assert.match(f.completion().error?.message ?? "", scenario === "absent" ? /not admitted/u : scenario === "close" ? /client closed/u : /no active Host execution/u);
    assert.equal(f.state.completions.size, 0);
    assert.equal(f.requests.filter((item) => item.operation === "start-interrupted").length, 1, "never replay admission");
    assert.equal(f.completion().observedAtRejection, true, "orphan completion must already have a rejection observer");
    assert.equal(observersAtCallerError, 1, "observe before exposing the admission error to the caller");
  });
}
for (const scenario of ["terminal", "active"] as const) {
  test(`transient ${scenario} recovery can resolve without becoming an unhandled rejection`, async () => {
    const f = fixture(scenario);
    await assert.rejects(f.start(), (error) => error === f.failure);
    await f.state.recoverCompletions();
    if (scenario === "active") {
      assert.equal(f.state.completions.size, 1);
      assert.equal(f.completion().settled, 0);
      const pending = f.state.completions.get(ids.runId)!;
      f.state.completions.delete(ids.runId);
      pending.resolve(outcome);
    }
    assert.equal(f.completion().settled, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.completion().outcome)), outcome);
    assert.equal(f.completion().error, undefined);
    assert.equal(f.reconnects(), 1);
    assert.equal(f.requests.filter((item) => item.operation === "start-interrupted").length, 1);
  });
}
test("normal success exposes the same completion and unchanged request payload", async () => {
  const f = fixture("success"); const handle = await f.start();
  assert.equal(handle?.completion, f.completion());
  assert.equal(f.completion().observed, 0);
  assert.equal(f.state.completions.size, 1);
  assert.equal(f.reconnects(), 0);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0]?.operation, "start-interrupted");
  assert.deepEqual({ ...record(f.requests[0]?.payload) }, { ...ids, allowUserInput: true, parentRunId: undefined,
    continuationSource: undefined, mode: "newTurn", sessionId: "session-a", writeIntent: true, expectedRevision: 7 });
});
test("empty result drops tracking without settling or inventing a completion", async () => {
  const f = fixture("empty"); assert.equal(await f.start(), undefined);
  assert.equal(f.state.completions.size, 0); assert.equal(f.completion().settled, 0); assert.equal(f.reconnects(), 0);
});
test("nontransient failure preserves the original error and observes before rejecting", async () => {
  const f = fixture("nontransient"); await assert.rejects(f.start(), (error) => error === f.failure);
  assert.equal(f.completion().error, f.failure); assert.equal(f.completion().observedAtRejection, true);
  assert.equal(f.state.completions.size, 0); assert.equal(f.reconnects(), 0);
});
