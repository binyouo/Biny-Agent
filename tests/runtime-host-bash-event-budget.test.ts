import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Compile only these named, side-effect-free declarations and borrowed methods.
// Only source-text reads occur; no product module, Host constructor, product
// filesystem operation or socket runs.
const root = process.env.BINY_BASH_EVENT_SOURCE_ROOT ?? process.cwd();
const serverPath = process.env.BINY_BASH_EVENT_BASELINE_SERVER ?? path.join(root, "src/runtime/host/server.ts");
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}
function declarations(file: string, names: string[]): string {
  const parsed = source(path.join(root, file));
  return names.map((name) => {
    const matches = parsed.statements.filter((node) => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name;
      if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return false;
      const declaration = node.declarationList.declarations[0]!;
      return ts.isIdentifier(declaration.name) && declaration.name.text === name;
    });
    assert.equal(matches.length, 1, `${file}: exactly one declaration ${name}`);
    return matches[0]!.getText(parsed);
  }).join("\n");
}
function serverMethods(): string {
  const parsed = source(serverPath);
  const classes = parsed.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostServer");
  assert.equal(classes.length, 1);
  return ["sendEvent", "send", "subscribeConnection", "canReplay", "matchesSessionFilter"].map((name) => {
    const methods = classes[0]!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name);
    assert.equal(methods.length, 1, `exactly one RuntimeHostServer.${name}`);
    return methods[0]!.getText(parsed);
  }).join("\n");
}
const extracted = [
  declarations("src/runtime/host/protocol.ts", ["runtimeHostMaxFrameBytes", "encodeHostFrame"]),
  declarations("src/agent/shellOutputProjection.ts", ["shellOutputBudgetBytes", "projectShellStreams", "shellOutputExcerpt", "omissionMarker", "isContinuation"]),
  declarations("src/agent/commandStreamFields.ts", ["commandStreamFields", "stringField", "numberField"]),
  declarations("src/runtime/host/bash-event-projection.ts", ["projectBashEventFrameForTransport"]),
  declarations("src/runtime/host/socket-writer.ts", ["runtimeHostMaxBufferedSocketBytes", "BoundedHostSocketWriter"]),
  `class FixtureServer { ${serverMethods()} }`,
  "globalThis.fixture = { projectBashEventFrameForTransport, encodeHostFrame, runtimeHostMaxFrameBytes, shellOutputBudgetBytes, BoundedHostSocketWriter, FixtureServer };"
].join("\n");
const compiled = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.doesNotMatch(compiled.outputText, /\brequire\s*\(/u, "extracted production code must have no runtime imports");
const context = vm.createContext({ Buffer, exports: {}, hostCapabilities: [] }, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(compiled.outputText, context, { timeout: 1_000 });

type RecordValue = Record<string, unknown>;
interface ShellResult extends RecordValue { stdout: string; stderr: string }
interface Frame { kind: "event"; hostEpoch: string; sequence: number; update: { event?: RecordValue; snapshot: RecordValue } }
interface Writer { send(frame: Frame): boolean; dispose(): void }
interface BorrowedServer {
  sendEvent(connection: RecordValue, sequence: number, update: Frame["update"]): void;
  subscribeConnection(connection: RecordValue, sequence: number | undefined, epoch: string, filter?: ReadonlySet<string>): { replayed: boolean };
}
const actual = (context as unknown as { fixture: {
  projectBashEventFrameForTransport(frame: Frame): Frame;
  encodeHostFrame(frame: Frame): string;
  runtimeHostMaxFrameBytes: number;
  shellOutputBudgetBytes: number;
  BoundedHostSocketWriter: new (socket: FakeSocket) => Writer;
  FixtureServer: { prototype: BorrowedServer };
} }).fixture;
const max = actual.runtimeHostMaxFrameBytes;
function result(stdout = "", stderr = "", extra: RecordValue = {}): RecordValue {
  return { background: false, status: "completed", sandbox: "off", stdout, stderr,
    stdoutBytes: Buffer.byteLength(stdout), stdoutRetainedBytes: Buffer.byteLength(stdout), stdoutCaptureOmittedBytes: 0, stdoutTruncated: false,
    stderrBytes: Buffer.byteLength(stderr), stderrRetainedBytes: Buffer.byteLength(stderr), stderrCaptureOmittedBytes: 0, stderrTruncated: false,
    exitCode: 0, ...extra };
}
function frame(value: RecordValue, type = "tool.completed"): Frame {
  return { kind: "event", hostEpoch: "epoch", sequence: 1, update: {
    snapshot: { revision: 1, info: { sessionId: "session" }, permissionMode: "ask", state: { kind: "idle" } },
    event: { type, sessionId: "session", runId: "run", timestamp: "2026-10-12T00:00:00.000Z", tool: "Bash", toolCallId: "call",
      durationMs: 17, executionStatus: type === "tool.failed" ? "failed" : "succeeded", operationId: "operation", recovered: false, evidence: "normal_exit",
      ...(type === "tool.failed" ? { error: "Command exited with code 2." } : {}), result: value }
  } };
}
function resultOf(value: Frame): ShellResult { return value.update.event!.result as ShellResult; }
function bytes(value: Frame): number { return Buffer.byteLength(actual.encodeHostFrame(value), "utf8"); }
function assertExcerpt(original: Frame, projected: Frame): void {
  assert.notEqual(projected, original);
  assert.ok(bytes(projected) <= max);
  assert.equal(projected.update.snapshot, original.update.snapshot);
  const output = resultOf(projected);
  assert.equal(output.transportProjection, "shell_excerpt");
  assert.ok(Buffer.byteLength(output.stdout ?? "") + Buffer.byteLength(output.stderr ?? "") <= actual.shellOutputBudgetBytes);
  for (const stream of ["stdout", "stderr"] as const) {
    if (output[`${stream}ProjectionTruncated`]) assert.match(output[stream], /UTF-8 bytes omitted/u);
  }
  for (const key of ["type", "sessionId", "runId", "toolCallId", "durationMs", "executionStatus", "operationId", "recovered", "evidence", "error"]) {
    assert.equal(projected.update.event![key], original.update.event![key], `outer ${key}`);
  }
  for (const key of ["background", "status", "sandbox", "exitCode", "error", "durationMs", "executionStatus"]) {
    assert.equal(output[key], resultOf(original)[key], `result ${key}`);
  }
}

class FakeSocket {
  destroyed = false;
  writableLength = 0;
  writes: string[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();
  on(name: string, listener: () => void): this {
    const listeners = this.listeners.get(name) ?? new Set<() => void>();
    listeners.add(listener); this.listeners.set(name, listeners); return this;
  }
  off(name: string, listener: () => void): this { this.listeners.get(name)?.delete(listener); return this; }
  write(data: string): boolean { this.writes.push(data); return true; }
  destroy(): this { this.destroyed = true; for (const listener of [...(this.listeners.get("close") ?? [])]) listener(); return this; }
}
function transport(history: Frame[] = []) {
  const socket = new FakeSocket();
  const writer = new actual.BoundedHostSocketWriter(socket);
  const connection: RecordValue = { writer, socket };
  const snapshot = frame(result()).update.snapshot;
  const host = Object.assign(Object.create(actual.FixtureServer.prototype) as BorrowedServer, {
    registration: { hostEpoch: "epoch" }, sequence: history.at(-1)?.sequence ?? 0,
    history: history.map((value) => ({ sequence: value.sequence, update: value.update })),
    runtime: { getSnapshot: () => snapshot }, sessionSummaries: () => []
  });
  return { socket, writer,
    send: (value: Frame) => host.sendEvent(connection, value.sequence, value.update),
    replay: (sequence = 0, filter?: ReadonlySet<string>) => host.subscribeConnection(connection, sequence, "epoch", filter) };
}

test("ordinary and exactly-at-limit encoded frames retain identity and bytes", () => {
  for (const length of [0, 130_000, 2 * 1024 * 1024]) {
    const value = frame(result("x".repeat(length)));
    assert.equal(actual.projectBashEventFrameForTransport(value), value);
  }
  const exact = frame(result(""));
  resultOf(exact).stdout = "x".repeat(max - bytes(exact));
  assert.equal(bytes(exact), max);
  assert.equal(actual.projectBashEventFrameForTransport(exact), exact);
});

test("one legal 8 MiB captured stream gets an immutable visible excerpt", () => {
  const value = frame(result("HEAD" + "x".repeat(max - 8) + "TAIL"));
  Object.freeze(resultOf(value)); Object.freeze(value.update.event); Object.freeze(value.update); Object.freeze(value);
  const projected = actual.projectBashEventFrameForTransport(value);
  assertExcerpt(value, projected);
  assert.ok(resultOf(projected).stdout.startsWith("HEAD"));
  assert.ok(resultOf(projected).stdout.endsWith("TAIL"));
  assert.equal(resultOf(value).stdout.length, max);
  assert.equal(resultOf(value).transportProjection, undefined);
  assert.equal(resultOf(projected).stdoutCaptureTruncated, false);
  assert.equal(resultOf(projected).stdoutCaptureOmittedBytes, 0);
  assert.equal(actual.projectBashEventFrameForTransport(projected), projected);
});

test("two individually legal streams share one excerpt budget", () => {
  const value = frame(result("a".repeat(max / 2), "b".repeat(max / 2)));
  const projected = actual.projectBashEventFrameForTransport(value);
  assertExcerpt(value, projected);
  assert.ok(resultOf(projected).stdoutProjectionTruncated);
  assert.ok(resultOf(projected).stderrProjectionTruncated);
});

test("JSON control-character escaping is charged in encoded bytes", () => {
  const value = frame(result("\0".repeat(2 * 1024 * 1024)));
  assert.ok(Buffer.byteLength(resultOf(value).stdout) < max);
  assert.ok(bytes(value) > max);
  assertExcerpt(value, actual.projectBashEventFrameForTransport(value));
});

test("UTF-8 boundary and capture-loss metadata survive transport-only projection", () => {
  const stdout = "中🙂".repeat(700_000);
  const value = frame(result(stdout, "error\n".repeat(650_000), {
    stdoutBytes: Buffer.byteLength(stdout) + 100, stdoutCaptureOmittedBytes: 75, stdoutTruncated: true, stdoutTruncationDirection: "tail"
  }));
  const projected = actual.projectBashEventFrameForTransport(value);
  assertExcerpt(value, projected);
  const output = resultOf(projected);
  assert.doesNotMatch(output.stdout + output.stderr, /\uFFFD/u);
  assert.equal(output.stdoutCaptureTruncated, true);
  assert.equal(output.stdoutCaptureOmittedBytes, 75);
  assert.equal(output.stdoutBytes, resultOf(value).stdoutBytes);
  assert.equal(output.stdoutTruncationDirection, "head_and_tail");
  assert.equal(typeof output.stdoutProjectionOmittedBytes, "number");
  assert.ok(Number(output.stdoutProjectionOmittedBytes) > 0);
});

test("failed exit and outer execution evidence survive projection", () => {
  const value = frame(result("x".repeat(max), "failure", { status: "failed", exitCode: 2, error: "Command exited with code 2.", durationMs: 17, executionStatus: "failed" }), "tool.failed");
  assertExcerpt(value, actual.projectBashEventFrameForTransport(value));
});

test("genuine archive metadata is preserved and references are never invented", () => {
  for (const metadata of [{}, { archivePath: ".biny/tool-results/tool-result-" + "a".repeat(64) + ".json", archived: true }, { archiveError: "storage unavailable", archived: false }]) {
    const value = frame(result("x".repeat(max), "", metadata));
    const output = resultOf(actual.projectBashEventFrameForTransport(value));
    for (const key of ["archivePath", "archiveError", "archived", "archiveAvailable"]) assert.equal(output[key], resultOf(value)[key]);
  }
});

test("ineligible events and oversized unrelated metadata retain existing behavior", () => {
  const cases = [frame(result("x".repeat(max), "", { background: true })), frame(result("x".repeat(max)))];
  cases[1]!.update.event!.tool = "OtherTool";
  const started = frame(result("x".repeat(max))); started.update.event!.type = "tool.started"; cases.push(started);
  const malformed = frame({ stdout: "x".repeat(max) }); cases.push(malformed);
  const hugeSnapshot = frame(result("x".repeat(max))); hugeSnapshot.update.snapshot.unrelated = "y".repeat(max); cases.push(hugeSnapshot);
  const hugeMetadata = frame(result("x".repeat(max), "", { unrelated: "y".repeat(max) })); cases.push(hugeMetadata);
  for (const value of cases) assert.equal(actual.projectBashEventFrameForTransport(value), value);
});

test("unchanged writer still rejects genuinely oversized non-Bash frames", () => {
  const f = transport();
  const value = frame(result("x".repeat(max))); value.update.event!.tool = "OtherTool";
  f.send(value);
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.socket.writes.length, 0);
});

for (const type of ["tool.completed", "tool.failed"]) {
  test(`actual sendEvent delivers oversized Bash ${type} and the next event`, () => {
    const f = transport();
    const value = frame(result("x".repeat(max)), type);
    f.send(value);
    assert.equal(f.socket.destroyed, false, "bounded terminal event must not disconnect the peer");
    const next = frame(result("next")); next.sequence = 2; f.send(next);
    assert.equal(f.socket.writes.length, 2);
    const delivered = JSON.parse(f.socket.writes[0]!) as Frame;
    assert.match(resultOf(delivered).stdout, /UTF-8 bytes omitted/u);
    assert.ok(Buffer.byteLength(f.socket.writes[0]!) <= max);
    assert.equal(resultOf(value).stdout.length, max);
    f.writer.dispose();
  });
}

test("actual subscribe replay projects retained raw entries without modifying history", () => {
  const value = frame(result("x".repeat(max)));
  const next = frame(result("next")); next.sequence = 2;
  const f = transport([value, next]);
  assert.equal(f.replay().replayed, true);
  assert.equal(f.socket.destroyed, false, "old oversized replay entries must not poison reconnection");
  assert.equal(f.socket.writes.length, 2);
  assert.equal(resultOf(value).transportProjection, undefined);
  assert.equal(resultOf(value).stdout.length, max);
  f.writer.dispose();
});

test("actual replay session filtering and small event bytes stay unchanged", () => {
  const value = frame(result("small"));
  const f = transport([value]); f.replay();
  assert.equal(f.socket.writes[0], actual.encodeHostFrame(value));
  const filtered = transport([frame(result("x".repeat(max)))]); filtered.replay(0, new Set(["other"]));
  assert.equal(filtered.socket.destroyed, false); assert.equal(filtered.socket.writes.length, 0);
  f.writer.dispose(); filtered.writer.dispose();
});
