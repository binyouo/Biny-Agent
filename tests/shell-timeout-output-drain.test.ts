import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read source only. No product module, process, socket, worker, or real timer is run.
// The local reviewed runner supplies the same test with the original source override.
const sourceRoot = process.env.BINY_SHELL_DRAIN_SOURCE_ROOT ?? process.cwd();
const commandPath = process.env.BINY_SHELL_DRAIN_BASELINE ?? path.join(sourceRoot, "src/tools/shell/runCommand.ts");
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function one<T>(values: readonly T[], label: string): T {
  assert.equal(values.length, 1, label);
  return values[0]!;
}
const commandSource = parse(commandPath);
const tailSource = parse(path.join(sourceRoot, "src/tools/shell/boundedUtf8Tail.ts"));
const metadataSource = parse(path.join(sourceRoot, "src/tools/shell/captureMetadata.ts"));
const functions = ["runShellCommand", "runShellCommandWithCompletionEvidence", "signalProcessGroup", "processGroupExists",
  "descendantProcessIds", "signalTrackedProcesses", "trackedProcessesExist", "isNoSuchProcessError", "abortReason"];
const constants = ["maxOutputBytes", "maxCapturedOutputBytes", "defaultTimeoutMs", "defaultTerminationGraceMs", "defaultKillSettleMs"];
const nodes: Array<{ node: ts.Node; source: ts.SourceFile }> = functions.map(name => ({ source: commandSource,
  node: one(commandSource.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name), name) }));
for (const name of constants) nodes.push({ source: commandSource,
  node: one(commandSource.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
    && node.declarationList.declarations.length === 1 && node.declarationList.declarations[0]!.name.getText(commandSource) === name), name) });
nodes.push({ source: tailSource, node: one(tailSource.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "BoundedUtf8Tail"), "actual bounded tail") });
nodes.push({ source: metadataSource, node: one(metadataSource.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "captureMetadata"), "actual metadata") });

const allowedCalls = new Set([
  "runShellCommandWithCompletionEvidence", "options.onCompletionEvidence", "options.signal.throwIfAborted",
  "Math.min", "Math.max", "Math.floor", "Number.isFinite", "Number.isSafeInteger", "Number", "String",
  "[timeoutMs,terminationGraceMs,killSettleMs].every", "spawn", "Buffer.byteLength", "Buffer.from", "Buffer.allocUnsafeSlow",
  "stderrBuffer.append", "stdoutBuffer.append", "stdoutDecoder.write", "stderrDecoder.write", "options.onUpdate",
  "pendingUpdates.at", "pendingUpdates.push", "flushUpdates", "queueOutput",
  "stdoutDecoder.end", "stderrDecoder.end", "clearTimeout", "setTimeout", "options.signal.removeEventListener",
  "options.signal.addEventListener", "child.stdout.removeListener", "child.stderr.removeListener", "child.removeListener",
  "windowsTreeKill.removeAllListeners", "windowsTreeKill.unref", "settle", "settleStopped", "settleStoppedAfterOutput",
  "abortReason", "appendDiagnostic", "cleanup", "finalizeOutput", "reject", "resolve", "stdoutBuffer.toString", "stderrBuffer.toString",
  "captureMetadata", "descendantProcessIds", "trackedUnixPids.add", "signalTrackedProcesses", "signalProcessGroup",
  "child.stdout.destroy", "child.stderr.destroy", "child.unref", "windowsTreeKill.once", "child.kill",
  "killWindowsProcessTree", "processGroupExists", "trackedProcessesExist", "forceKill", "requestStop", "onNormalExit",
  "child.stdout.on", "child.stderr.on", "child.on", "process.kill", "isNoSuchProcessError", "finish",
  "processList.kill", "processList.stdout.on", "chunk.toString", "processList.once", "output.split", "line.trim",
  "line.trim().match", "children.get", "siblings.push", "children.set", "pending.pop", "roots.has", "descendants.has",
  "descendants.add", "pending.push", "[...pids].reverse", "input.copy", "this.at", "block.copy", "result.toString"
]);
const allowedConstructors = new Set(["Promise", "BoundedUtf8Tail", "StringDecoder", "Set", "Map", "RangeError", "Error", "DOMException"]);
let asyncStopIifes = 0;
for (const { node, source } of nodes) {
  const visit = (current: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(current) && !ts.isImportEqualsDeclaration(current)
      && current.kind !== ts.SyntaxKind.ImportKeyword, "no product imports in extracted declarations");
    if (ts.isPropertyAccessExpression(current)) assert.ok(!["constructor", "prototype", "__proto__"].includes(current.name.text));
    if (ts.isCallExpression(current)) {
      if (ts.isParenthesizedExpression(current.expression) && ts.isArrowFunction(current.expression.expression)) {
        const arrow = current.expression.expression;
        assert.ok(ts.isVoidExpression(current.parent));
        assert.ok(arrow.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword));
        assert.equal(arrow.parameters.length, 0); assert.equal(current.arguments.length, 0); assert.ok(ts.isBlock(arrow.body));
        let owner: ts.Node | undefined = current.parent;
        while (owner && !ts.isArrowFunction(owner)) owner = owner.parent;
        assert.ok(owner && ts.isVariableDeclaration(owner.parent) && owner.parent.name.getText(source) === "requestStop");
        assert.ok(ts.isFunctionDeclaration(node) && node.name?.text === "runShellCommandWithCompletionEvidence");
        asyncStopIifes++;
      } else {
        const callee = current.expression.getText(source).replace(/\?\./gu, ".").replace(/\s+/gu, "");
        assert.ok(allowedCalls.has(callee), `unreviewed call: ${callee}`);
      }
    }
    if (ts.isNewExpression(current)) assert.ok(allowedConstructors.has(current.expression.getText(source)), "unreviewed construction");
    ts.forEachChild(current, visit);
  };
  visit(node);
}
assert.equal(asyncStopIifes, 1, "only the reviewed requestStop async IIFE is allowed");
const selected = nodes.map(({ node, source }) => node.getText(source).replace(/^export /u, "")).join("\n");
const compiled = ts.transpileModule(`${selected}\n({ run: runShellCommand });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Update { kind: string; text?: string }
interface Result {
  status: string; exitCode: number; error?: string; stdout: string; stderr: string;
  stdoutBytes: number; stdoutRetainedBytes: number; stdoutCaptureOmittedBytes: number; stdoutTruncated: boolean;
  stderrBytes: number; stderrRetainedBytes: number; stderrCaptureOmittedBytes: number; stderrTruncated: boolean;
}
interface Options {
  signal?: AbortSignal; timeoutMs?: number; terminationGraceMs?: number; killSettleMs?: number;
  captureFullOutput?: boolean; maxCapturedOutputBytes?: number;
  onUpdate?: (update: Update) => void; onCompletionEvidence?: (value: string) => void;
}
interface Api { run(cwd: string, command: string, options: Options): Promise<Result> }
interface Timer { id: number; at: number; callback: () => void }
class Clock {
  now = 0;
  private nextId = 0;
  readonly pending = new Map<number, Timer>();
  readonly setTimeout = (callback: () => void, ms: number): number => {
    assert.ok(Number.isFinite(ms) && ms >= 0);
    const id = ++this.nextId;
    this.pending.set(id, { id, at: this.now + ms, callback });
    return id;
  };
  readonly clearTimeout = (id: number | undefined): void => { if (id !== undefined) this.pending.delete(id); };
  advance(ms: number): void {
    const target = this.now + ms;
    let invoked = 0;
    for (;;) {
      const timer = [...this.pending.values()].filter(value => value.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!timer) break;
      assert.ok(++invoked < 100, "manual timer loop must stay bounded");
      this.now = timer.at;
      this.pending.delete(timer.id);
      timer.callback();
    }
    this.now = target;
  }
  deadlines(): number[] { return [...this.pending.values()].map(timer => timer.at).sort((a, b) => a - b); }
}
class Pipe extends EventEmitter {
  destroyed = false;
  destroy(): this { this.destroyed = true; return this; }
}
class Child extends EventEmitter {
  readonly stdout = new Pipe();
  readonly stderr = new Pipe();
  killed = false;
  unrefs = 0;
  readonly killCalls: Array<string | undefined> = [];
  onKill?: (signal?: string) => void;
  constructor(readonly pid: number | undefined) { super(); }
  kill(signal?: string): boolean { this.killCalls.push(signal); this.killed = true; this.onKill?.(signal); return true; }
  unref(): this { this.unrefs++; return this; }
}
type Outcome = { kind: "pending" } | { kind: "resolved"; value: Result } | { kind: "rejected"; error: unknown };
async function flush(): Promise<void> {
  // Drain the fixed nested Promise chain; no timer or OS scheduling is involved.
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function fixture(platform: "linux" | "win32" = "linux", options: Options = {}) {
  const clock = new Clock();
  const child = new Child(100);
  const processLists: Child[] = [];
  const killers: Child[] = [];
  const signals: Array<{ pid: number; signal: string }> = [];
  const updates: Update[] = [];
  const evidence: string[] = [];
  let alive = true;
  let fallbackSignal: string | undefined;
  let outcome: Outcome = { kind: "pending" };
  let settlements = 0;
  let primarySpawns = 0;
  const fakeProcess = Object.freeze({ platform, env: Object.freeze({}), kill: (pid: number, signal: string | number): boolean => {
    assert.ok(pid === 100 || pid === -100, "unexpected PID access");
    assert.ok(signal === 0 || signal === "SIGTERM" || signal === "SIGKILL", "unexpected signal");
    if (signal !== 0) signals.push({ pid, signal });
    if (pid === -100 && signal === fallbackSignal) throw Object.assign(new Error("Inert group permission failure"), { code: "EPERM" });
    if (!alive) throw Object.assign(new Error("No such inert process"), { code: "ESRCH" });
    return true;
  } });
  const spawn = (command: string, argsOrOptions: unknown, options?: unknown): Child => {
    if (command === "fixture-command") {
      assert.equal(++primarySpawns, 1);
      assert.equal(options, undefined);
      const actual = argsOrOptions as { cwd: string; shell: boolean; detached: boolean; stdio: string[] };
      assert.deepEqual(Object.keys(actual).sort(), ["cwd", "detached", "shell", "stdio"]);
      assert.equal(actual.cwd, "/inert"); assert.equal(actual.shell, true); assert.equal(actual.detached, platform !== "win32");
      assert.deepEqual(Array.from(actual.stdio), ["ignore", "pipe", "pipe"]);
      return child;
    }
    assert.ok(Array.isArray(argsOrOptions), "helper argv must be explicit");
    if (command === "ps") {
      assert.equal(platform, "linux");
      assert.deepEqual(Array.from(argsOrOptions as unknown[]), ["-axo", "pid=,ppid="]);
      assert.deepEqual(Array.from((options as { stdio: string[] }).stdio), ["ignore", "pipe", "ignore"]);
      const helper = new Child(200 + processLists.length); processLists.push(helper); return helper;
    }
    assert.equal(command, "taskkill", "unexpected spawn is forbidden");
    assert.equal(platform, "win32");
    assert.deepEqual(Array.from(argsOrOptions as unknown[]), ["/PID", "100", "/T", "/F"]);
    assert.equal((options as { windowsHide: boolean }).windowsHide, true);
    assert.equal((options as { stdio: string }).stdio, "ignore");
    const helper = new Child(300 + killers.length); killers.push(helper); return helper;
  };
  const api = runInNewContext(compiled.outputText, {
    Buffer, StringDecoder, Error, RangeError, DOMException, Promise,
    process: fakeProcess, spawn, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
  const pending = api.run("/inert", "fixture-command", { timeoutMs: 50, terminationGraceMs: 10, killSettleMs: 20,
    ...options, onUpdate: value => updates.push(value), onCompletionEvidence: value => evidence.push(value) });
  void pending.then(value => { settlements++; outcome = { kind: "resolved", value }; },
    error => { settlements++; outcome = { kind: "rejected", error }; });
  return {
    clock, child, processLists, killers, signals, updates, evidence,
    setAlive(value: boolean) { alive = value; },
    fallbackOn(signal: string, onKill: (signal?: string) => void) { fallbackSignal = signal; child.onKill = onKill; },
    outcome: (): Outcome => outcome,
    settlements: (): number => settlements,
    ps(index = 0): void { const helper = processLists[index]; assert.ok(helper); helper.emit("close", 0); },
    killer(): void { assert.ok(killers[0]); killers[0].emit("close", 0); },
    write(stream: "stdout" | "stderr", bytes: readonly number[]): void { child[stream].emit("data", Buffer.from(bytes)); },
    close(code = 0): void { child.emit("close", code, null); }
  };
}
type Fixture = ReturnType<typeof fixture>;
function resolved(f: Fixture): Result {
  const outcome = f.outcome(); assert.equal(outcome.kind, "resolved");
  if (outcome.kind !== "resolved") throw new Error("Expected a settled result without waiting on an external event");
  return outcome.value;
}
function stillPending(f: Fixture): void { assert.equal(f.outcome().kind, "pending", "must not settle before original child output closes"); }
function completedTimeout(f: Fixture): Result {
  const result = resolved(f);
  assert.equal(result.status, "timed_out"); assert.equal(result.exitCode, 124);
  assert.equal(result.error, "Command timed out after 50ms.");
  assert.deepEqual(f.evidence, ["unconfirmed"]); assert.equal(f.settlements(), 1);
  assert.equal(f.clock.pending.size, 0, "settlement cleans every manual timer");
  return result;
}
function sendPrefix(f: Fixture): void {
  f.write("stdout", [0xe4, 0xb8]); f.write("stderr", [0xe4, 0xb8]);
}
function sendTail(f: Fixture): void {
  f.write("stdout", [0xad, 0x54, 0x41, 0x49, 0x4c]); f.write("stderr", [0xad, 0x54, 0x41, 0x49, 0x4c]);
}
function verifyText(f: Fixture): void {
  const result = completedTimeout(f);
  assert.equal(result.stdout, "中TAIL");
  assert.equal(result.stderr, "Command timed out after 50ms.中TAIL", "preserve existing diagnostic ordering");
  assert.equal(result.stdoutBytes, 7); assert.equal(result.stdoutRetainedBytes, 7);
  assert.equal(result.stdoutCaptureOmittedBytes, 0); assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrBytes, Buffer.byteLength(result.stderr));
  assert.equal(result.stderrRetainedBytes, Buffer.byteLength(result.stderr));
  assert.equal(result.stderrCaptureOmittedBytes, 0); assert.equal(result.stderrTruncated, false);
  assert.ok(f.updates.some(update => update.kind === "stdout" && update.text === "中TAIL"));
  assert.ok(f.updates.some(update => update.kind === "stderr" && update.text === "中TAIL"));
  assert.equal(f.updates.some(update => update.text?.includes("�")), false);
}

test("Unix early-gone confirmation drains both split UTF-8 streams before timeout settlement", async () => {
  const f = fixture(); sendPrefix(f); f.clock.advance(50); f.setAlive(false); f.ps(); await flush();
  stillPending(f); assert.deepEqual(f.clock.deadlines(), [70]);
  sendTail(f); f.close(); await flush(); verifyText(f);
  f.close(); f.clock.advance(1000); await flush(); assert.equal(f.settlements(), 1);
});

test("Windows taskkill first waits for original child close without changing its hard deadline", async () => {
  const f = fixture("win32"); sendPrefix(f); f.clock.advance(50); f.clock.advance(17);
  f.killer(); await flush(); stillPending(f); assert.deepEqual(f.clock.deadlines(), [80]);
  sendTail(f); f.close(); await flush(); verifyText(f);
});

test("Windows original child close first still waits for taskkill and preserves complete output", async () => {
  const f = fixture("win32"); sendPrefix(f); f.clock.advance(50); sendTail(f); f.close(); await flush(); stillPending(f);
  f.killer(); await flush(); verifyText(f);
});

test("Unix original close before process-tree inspection does not replace the stop-confirmation gate", async () => {
  const f = fixture(); sendPrefix(f); f.clock.advance(50); sendTail(f); f.close(); await flush(); stillPending(f);
  f.setAlive(false); f.ps(); await flush(); verifyText(f);
});

test("Unix output never closes: early-gone drain retains a bounded fallback and finalizes exactly once", async () => {
  const f = fixture(); sendPrefix(f); f.clock.advance(50); f.setAlive(false); f.ps(); await flush(); stillPending(f);
  f.clock.advance(19); await flush(); stillPending(f); f.clock.advance(1); await flush();
  const result = completedTimeout(f); assert.equal(result.stdout, "�");
  assert.equal(result.stdoutBytes, 2); assert.equal(result.stdoutCaptureOmittedBytes, 0, "unknown unread bytes must not be invented");
  assert.equal(result.stdoutTruncated, false, "capacity metadata is not an output-drain completeness claim");
  assert.equal(f.child.stdout.destroyed, true); assert.equal(f.child.stderr.destroyed, true); assert.equal(f.child.unrefs, 1);
  const delivered = f.updates.length; sendTail(f); f.close(); f.clock.advance(1000); await flush();
  assert.equal(f.updates.length, delivered); assert.equal(f.settlements(), 1);
});

test("Windows no original close: helper completion does not extend the pre-existing hard deadline", async () => {
  const f = fixture("win32"); f.clock.advance(50); f.clock.advance(29); f.killer(); await flush(); stillPending(f);
  assert.deepEqual(f.clock.deadlines(), [80]); f.clock.advance(1); await flush(); completedTimeout(f);
  assert.equal(f.child.stdout.destroyed, true); assert.equal(f.child.unrefs, 1);
});

test("Windows helper never completes retains its original hard-settle fallback", async () => {
  const f = fixture("win32"); f.clock.advance(50); f.close(); await flush(); stillPending(f);
  f.clock.advance(30); await flush(); completedTimeout(f);
  f.killer(); await flush(); assert.equal(f.settlements(), 1);
});

test("Unix close while descendants remain does not bypass escalation or its existing hard deadline", async () => {
  const f = fixture(); f.clock.advance(50); f.ps(); await flush();
  f.close(); await flush(); stillPending(f); f.clock.advance(10); assert.equal(f.processLists.length, 2);
  f.ps(1); await flush(); stillPending(f); assert.deepEqual(f.clock.deadlines(), [80]);
  assert.ok(f.signals.some(item => item.signal === "SIGKILL"));
  f.clock.advance(20); await flush(); completedTimeout(f);
});

test("Unix stop-time error after process disappearance drains output and cancels the unused grace timer", async () => {
  const f = fixture(); sendPrefix(f); f.clock.advance(50); f.ps(); await flush(); assert.deepEqual(f.clock.deadlines(), [60]);
  f.setAlive(false); f.child.emit("error", new Error("inert stop observation")); await flush(); stillPending(f);
  assert.deepEqual(f.clock.deadlines(), [70]); const signals = f.signals.length;
  f.clock.advance(11); await flush(); assert.equal(f.signals.length, signals, "drain must not re-enter forceKill");
  sendTail(f); f.close(); await flush(); verifyText(f);
});

test("Unix stop-time error during a pending forceKill inspection prevents late signals and timer extension", async () => {
  const f = fixture(); sendPrefix(f); f.clock.advance(50); f.ps(); await flush(); f.clock.advance(10);
  assert.equal(f.processLists.length, 2); f.setAlive(false); f.child.emit("error", new Error("inert late stop observation"));
  await flush(); stillPending(f); const signals = f.signals.length;
  f.ps(1); await flush(); assert.equal(f.signals.length, signals, "stale forceKill continuation must not signal");
  assert.deepEqual(f.clock.deadlines(), [80]); sendTail(f); f.close(); await flush(); verifyText(f);
});

test("Unix error after SIGKILL keeps the already-armed hard deadline", async () => {
  const f = fixture(); f.clock.advance(50); f.ps(); await flush(); f.clock.advance(10); f.ps(1); await flush();
  assert.deepEqual(f.clock.deadlines(), [80]); f.clock.advance(7); f.setAlive(false);
  f.child.emit("error", new Error("inert post-KILL error")); await flush(); stillPending(f);
  assert.deepEqual(f.clock.deadlines(), [80]); f.clock.advance(13); await flush(); completedTimeout(f);
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`synchronous ${signal} fallback error cannot rearm timers after entering output drain`, async () => {
    const f = fixture(); sendPrefix(f); f.clock.advance(50);
    if (signal === "SIGKILL") { f.ps(); await flush(); f.clock.advance(10); }
    f.fallbackOn(signal, received => {
      assert.equal(received, signal); f.setAlive(false); f.child.emit("error", new Error("inert synchronous kill error"));
    });
    f.ps(signal === "SIGKILL" ? 1 : 0); await flush(); stillPending(f);
    assert.deepEqual(f.clock.deadlines(), [signal === "SIGKILL" ? 80 : 70], "only one owned drain timer remains");
    sendTail(f); f.close(); await flush(); verifyText(f);
  });
}

test("cancellation during timeout draining keeps the original abort reason and unconfirmed evidence", async () => {
  const controller = new AbortController(); const reason = new Error("inert cancellation");
  const f = fixture("linux", { signal: controller.signal }); sendPrefix(f); f.clock.advance(50); f.setAlive(false); f.ps();
  await flush(); stillPending(f); controller.abort(reason); await flush(); stillPending(f);
  sendTail(f); f.close(); await flush(); const outcome = f.outcome(); assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
  assert.deepEqual(f.evidence, ["unconfirmed"]); assert.equal(f.clock.pending.size, 0); assert.equal(f.settlements(), 1);
  assert.equal(f.updates.filter(update => update.kind === "status" && update.text?.startsWith("Exited")).length, 0);
});

test("abort initiated before timeout waits for drain and still rejects rather than returns a result", async () => {
  const controller = new AbortController(); const reason = new Error("inert early cancellation");
  const f = fixture("linux", { signal: controller.signal }); controller.abort(reason); f.setAlive(false); f.ps(); await flush();
  stillPending(f); f.clock.advance(20); await flush(); const outcome = f.outcome(); assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
  assert.deepEqual(f.evidence, ["unconfirmed"]); assert.equal(f.clock.pending.size, 0); assert.equal(f.settlements(), 1);
});

test("normal close and explicit numeric failure retain their original completion provenance", async () => {
  for (const code of [0, 1, 124]) {
    const f = fixture(); sendPrefix(f); sendTail(f); f.close(code); await flush(); const result = resolved(f);
    assert.equal(result.status, code === 0 ? "completed" : "failed"); assert.equal(result.exitCode, code);
    assert.equal(result.stdout, "中TAIL"); assert.equal(result.stderr, "中TAIL");
    assert.deepEqual(f.evidence, ["normal_exit"]); assert.equal(f.clock.pending.size, 0);
    f.clock.advance(1000); assert.equal(f.processLists.length, 0);
  }
});

test("pre-stop spawn error remains the identical rejection without a new drain", async () => {
  const f = fixture(); const reason = new Error("inert spawn failure"); f.child.emit("error", reason); await flush();
  const outcome = f.outcome(); assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
  assert.deepEqual(f.evidence, ["unconfirmed"]); assert.equal(f.clock.pending.size, 0);
});
