import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-only extraction: no product module, Host, scheduler, database, socket,
// provider, SDK, Recorder, or process is imported or instantiated.
const operationsSource = readFileSync(new URL("../src/runtime/host/operations.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/runtime/host/server.ts", import.meta.url), "utf8");
const executionSource = readFileSync(new URL("../src/runtime/host/composition.ts", import.meta.url), "utf8");
const operations = ts.createSourceFile("operations.ts", operationsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const server = ts.createSourceFile("server.ts", serverSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string): string {
  const node = operations.statements.find((statement) =>
    (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name?.text === name);
  assert.ok(node, name);
  return node.getText(operations).replace(/^export\s+/u, "");
}
const host = server.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.members.some(member =>
    ts.isMethodDeclaration(member) && member.name.getText(server) === "executeAdmission"));
assert.ok(host);
function method(name: string): ts.MethodDeclaration {
  const node = host!.members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && member.name.getText(server) === name);
  assert.ok(node?.body, name);
  return node;
}
const execution = ts.createSourceFile("composition.ts", executionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const execute = execution.statements.filter(ts.isClassDeclaration).flatMap(node => [...node.members]).find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(execution) === "execute")!;
let selectedSwitch: ts.SwitchStatement | undefined;
function visit(node: ts.Node): void {
  if (ts.isSwitchStatement(node) && node.caseBlock.clauses.some(clause =>
    ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression) && clause.expression.text === "automation.run")) {
    assert.equal(selectedSwitch, undefined, "the automation switch must be unambiguous");
    selectedSwitch = node;
  }
  ts.forEachChild(node, visit);
}
visit(execute);
assert.ok(selectedSwitch);
const expectedCases = ["automation.pause", "automation.delete", "automation.run", "automation.resume", "automation.create"];
const clauses = selectedSwitch.caseBlock.clauses.filter((clause) =>
  ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression) && expectedCases.includes(clause.expression.text));
assert.equal(clauses.length, expectedCases.length);
const extracted = [
  declaration("OperationCompletion"), declaration("OperationDispatcher"), declaration("operationLane"),
  "class ExtractedHost {",
  method("executeAdmission").getText(server),
  method("executeControl").getText(server),
  "async executeAutomation(operation, payload) { const runtime = this.runtime; const commands = this.commands; switch (operation) {",
  ...clauses.map(clause => clause.getText(execution).replaceAll("this.host.", "this.")),
  'default: throw new Error("Unexpected extracted operation");',
  "} } }",
  "({ OperationDispatcher, operationLane, ExtractedHost });"
].join("\n");
const compiled = stripTypeScriptTypes(extracted, { mode: "strip" });

interface Result {
  accepted: boolean;
  sessionId: string;
  revision: number;
  result?: unknown;
  reason?: string;
  errorCode?: string;
  errorData?: unknown;
}
interface Dispatcher {
  dispatch<T>(lane: string, work: () => Promise<T>): Promise<T>;
}
interface FakeRuntime {
  getSnapshot(): { info: { sessionId: string }; revision: number };
}
interface FakeHost {
  runtime: FakeRuntime;
  admission: { assertAdmission(): void };
  commands: { automationStore: { pause(id: string): unknown; delete(id: string): void; resume(id: string): unknown; create(input: Record<string, unknown>): unknown } };
  businessComposition: { runAutomation(id: string): Promise<unknown> };
  executeAutomation(operation: string, payload: Record<string, unknown>): Promise<Result>;
}
interface Extracted {
  OperationDispatcher: new () => Dispatcher;
  operationLane(operation: string): string;
  ExtractedHost: new () => FakeHost;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function errorText(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
}
function harness() {
  const bindings = {
    readAutomationCreateInput: (value: Record<string, unknown>) => value,
    publicError: errorText,
    publicErrorCode: () => "fake_code",
    publicErrorData: () => ({ fake: true }),
    requiredString: (value: unknown, name: string) => {
      if (typeof value !== "string" || !value.trim()) throw new Error(name + " is required.");
      return value;
    },
    // operationLane's command-only helper is deliberately unavailable.
    runtimeCommandOperation: () => { throw new Error("Unexpected command classification"); }
  };
  const extractedApi = runInNewContext(compiled, bindings, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as Extracted;
  const dispatcher = new extractedApi.OperationDispatcher();
  const instance = new extractedApi.ExtractedHost();
  const runs = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const starts: string[] = [];
  const controls: string[] = [];
  let revision = 1;
  let rejectingAdmission = false;
  instance.runtime = { getSnapshot: () => ({ info: { sessionId: "primary" }, revision }) };
  instance.admission = { assertAdmission: () => { if (rejectingAdmission) throw new Error("draining"); } };
  instance.commands = { automationStore: {
    pause: (id) => { controls.push("pause:" + id); return { automationId: id, status: "paused" }; },
    delete: (id) => { controls.push("delete:" + id); },
    resume: (id) => { controls.push("resume:" + id); return { automationId: id, status: "active" }; },
    create: (input) => { controls.push("create:" + String(input.automationId)); return input; }
  } };
  instance.businessComposition = {
    // The real runNow durably creates/enqueues its fire before its first await.
    // This fake models that synchronous entry only, not scheduler behavior.
    runAutomation: async (id) => {
      if (id === "missing") throw new Error("Automation missing does not exist.");
      const gate = deferred<unknown>();
      runs.set(id, gate);
      starts.push(id);
      return await gate.promise;
    }
  };
  const requests: Promise<unknown>[] = [];
  function request(operation: string, id?: string) {
    const result = dispatcher.dispatch(extractedApi.operationLane(operation),
      async () => await instance.executeAutomation(operation, id === undefined ? {} : { automationId: id }));
    requests.push(result);
    void result.catch(() => undefined);
    return result;
  }
  return {
    starts, controls, runs, request,
    revision(value: number) { revision = value; },
    rejectAdmission() { rejectingAdmission = true; },
    mutation() {
      const result = dispatcher.dispatch(extractedApi.operationLane("automation.create"), async () => {
        controls.push("other-mutation"); return "mutated";
      });
      requests.push(result);
      return result;
    },
    async close() {
      // Release both currently started gates and gates admitted by that release.
      for (let turn = 0; turn < 100; turn++) {
        for (const gate of runs.values()) gate.resolve("cleanup");
        await Promise.resolve();
      }
      await Promise.allSettled(requests);
    }
  };
}
// These pure methods have bounded promise chains and no timer or I/O. Give all
// already runnable microtasks ample turns; never release a run to satisfy a
// control-progress assertion.
async function flush() {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
}

for (const control of ["automation.pause", "automation.delete", "automation.resume", "automation.create", "other"] as const) {
  await test(`pending automation run does not delay ${control}`, { timeout: 2_000 }, async () => {
    const f = harness();
    try {
      let replied = false;
      const running = f.request("automation.run", "A");
      void running.then(() => { replied = true; });
      await flush();
      assert.deepEqual(f.starts, ["A"]);
      let controlled = false;
      const follow = control === "other" ? f.mutation() : f.request(control, "B");
      void follow.then(() => { controlled = true; });
      await flush();
      assert.equal(controlled, true, "control must finish before the run completion gate is released");
      assert.equal(replied, false, "the run RPC must still wait for its final result");
      assert.deepEqual(f.controls, [control === "other" ? "other-mutation" : control.slice("automation.".length) + ":B"]);
      f.revision(9);
      f.runs.get("A")!.resolve({ fireId: "fire-A", status: "completed" });
      const result = await running;
      assert.equal(result.accepted, true);
      assert.equal(result.revision, 9);
      assert.equal(result.sessionId, "primary");
      assert.deepEqual(result.result, { fireId: "fire-A", status: "completed" });
      await follow;
    } finally { await f.close(); }
  });
}

await test("late completion rejection keeps the failure envelope and current revision", { timeout: 2_000 }, async () => {
  const f = harness();
  try {
    const running = f.request("automation.run", "A");
    await flush();
    f.revision(12);
    f.runs.get("A")!.reject(new Error("controlled outcome failure"));
    const result = await running;
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "controlled outcome failure");
    assert.equal(result.revision, 12);
    assert.equal(result.sessionId, "primary");
    assert.equal(result.errorCode, "fake_code");
    assert.equal((result.errorData as { fake: boolean }).fake, true);
    assert.equal(await f.mutation(), "mutated", "failure must release the lane");
  } finally { await f.close(); }
});

await test("admission refusal never invokes the business operation", { timeout: 2_000 }, async () => {
  const f = harness();
  try {
    f.rejectAdmission();
    const result = await f.request("automation.run", "A");
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "draining");
    assert.equal(result.revision, 1);
    assert.deepEqual(f.starts, []);
  } finally { await f.close(); }
});

for (const id of [undefined, "missing"]) {
  await test(`invalid automation ID ${String(id)} preserves rejection semantics`, { timeout: 2_000 }, async () => {
    const f = harness();
    try {
      const result = await f.request("automation.run", id);
      assert.equal(result.accepted, false);
      assert.equal(result.reason, id === undefined ? "automationId is required." : "Automation missing does not exist.");
      assert.equal(result.revision, 1);
      assert.deepEqual(f.starts, []);
      assert.equal(await f.mutation(), "mutated");
    } finally { await f.close(); }
  });
}

await test("independent runs admit and settle independently without early RPC success", { timeout: 2_000 }, async () => {
  const f = harness();
  try {
    let firstReplied = false;
    let secondReplied = false;
    const first = f.request("automation.run", "A");
    const second = f.request("automation.run", "B");
    void first.then(() => { firstReplied = true; });
    void second.then(() => { secondReplied = true; });
    await flush();
    assert.deepEqual(f.starts, ["A", "B"]);
    assert.equal(firstReplied, false);
    assert.equal(secondReplied, false);
    f.revision(5);
    f.runs.get("B")!.resolve("B result");
    const secondResult = await second;
    assert.equal(secondResult.accepted, true);
    assert.equal(secondResult.result, "B result");
    assert.equal(secondResult.revision, 5);
    assert.equal(firstReplied, false);
    f.revision(7);
    f.runs.get("A")!.resolve("A result");
    const firstResult = await first;
    assert.equal(firstResult.result, "A result");
    assert.equal(firstResult.revision, 7);
  } finally { await f.close(); }
});
