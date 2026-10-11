import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Parse source as data. Never import the client or initialize Host/socket/SQLite code.
const source = readFileSync(new URL("../src/runtime/host/client.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const clientClass = parsed.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostClient");
assert.ok(clientClass);
const methods = ["recoverCompletions", "activeRunId"].map((name) => {
  const method = clientClass.members.find((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.ok(method, `Missing ${name}`);
  return method.getText(parsed);
});
const isolated = ts.transpileModule(`class Recovery { ${methods.join("\n")} }\nRecovery.prototype;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

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
  state: { kind: "idle" } | { kind: "runs"; activeRun: { runId: string } };
}
interface Pending {
  resolve(outcome: Outcome): void;
  reject(error: Error): void;
}
interface Fixture {
  focusedSessionId: string;
  snapshots: Map<string, Snapshot>;
  snapshot?: Snapshot;
  completions: Map<string, Pending>;
  inspectRun(runId: string): Promise<unknown>;
  reportError(error: unknown): void;
  activeRunId(sessionId?: string): string | undefined;
}
interface Extracted {
  recoverCompletions(this: Fixture): Promise<void>;
  activeRunId(this: Fixture, sessionId?: string): string | undefined;
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
}, { timeout: 1_000 }) as Extracted;

const live = (runId: string): Snapshot => ({ state: { kind: "runs", activeRun: { runId } } });
const idle = (): Snapshot => ({ state: { kind: "idle" } });
const outcome = (runId: string): Outcome => ({
  runId, status: "completed", stopReason: "completed", steps: 1, output: "done", durationMs: 2
});

function fixture(focusedSessionId: string, snapshots: Array<[string, Snapshot]>, records: Record<string, unknown>) {
  const settled = new Map<string, { outcome?: Outcome; error?: Error; count: number }>();
  const promises = new Map<string, Promise<Outcome>>();
  const state: Fixture = {
    focusedSessionId,
    snapshots: new Map(snapshots),
    completions: new Map(),
    inspectRun: async (runId) => records[runId],
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
  return { state, settled, promises, add, deliver, recover: () => extracted.recoverCompletions.call(state) };
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
