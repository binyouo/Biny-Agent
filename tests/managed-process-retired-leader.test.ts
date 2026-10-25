/** Real service methods with synthetic OS adapters: no shell, process, socket or Host runs. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ManagedProcessService, ManagedProcessServiceOptions } from "../src/runtime/ManagedProcessService.js";

const file = new URL("../src/runtime/ManagedProcessService.ts", import.meta.url);
const source = readFileSync(file, "utf8");
const parsed = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const imports = parsed.statements.filter(ts.isImportDeclaration);
assert.deepEqual(imports.map(node => {
  assert.ok(ts.isStringLiteral(node.moduleSpecifier));
  return node.moduleSpecifier.text;
}), ["node:crypto", "node:child_process", "../tools/shell/shell.js", "node:fs", "node:fs/promises",
  "node:net", "node:path", "../tools/search/regexMatcher.js", "../session/store.js", "./managedProcessLog.js"],
"new dependencies require an explicitly reviewed inert adapter");
// Import declarations are never evaluated. Unknown dynamic imports/requires are forbidden.
function inspect(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword);
    assert.ok(!(ts.isIdentifier(node.expression) && node.expression.text === "require"));
  }
  ts.forEachChild(node, inspect);
}
inspect(parsed);
let body = source;
for (const node of [...imports].reverse()) body = body.slice(0, node.getStart(parsed)) + body.slice(node.end);
const javascript = stripTypeScriptTypes(body.replace(/^export /gmu, ""), { mode: "transform" });
type Service = Pick<ManagedProcessService, "start" | "status" | "stop" | "close">;
type Signal = 0 | "SIGTERM" | "SIGKILL";
type Operation = { kind: "kill"; pid: number; signal: Signal; foreign: boolean }
  | { kind: "spawn"; command: string; args?: readonly string[] };
const P = 987654321;
const C = 987654322;
const command = "synthetic-command-never-executed";
const forbidden = (name: string) => (): never => { throw new Error(`Forbidden adapter: ${name}`); };

function fixture(platform: "linux" | "win32" = "linux") {
  const events: Operation[] = [];
  let group = true;
  let positive = true;
  let descendant = false;
  let foreign = false;
  let groupError: string | undefined;
  const child = Object.assign(new EventEmitter(), {
    pid: P, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    unref() {}, kill: forbidden("child.kill")
  });
  const processAdapter = Object.freeze({ platform, kill(pid: number, signal: Signal) {
    assert.ok([P, -P, C].includes(pid), `unrecognized synthetic PID ${String(pid)}`);
    assert.ok([0, "SIGTERM", "SIGKILL"].includes(signal), "unrecognized signal");
    if (platform === "win32") assert.ok(pid > 0, "Windows must not probe a POSIX process group");
    events.push({ kind: "kill", pid, signal, foreign: foreign && pid > 0 });
    if (pid === -P && groupError) throw Object.assign(new Error("synthetic inaccessible group"), { code: groupError });
    const exists = pid === -P ? group : pid === C ? descendant : positive;
    if (!exists) throw Object.assign(new Error("synthetic absent process"), { code: "ESRCH" });
    if (signal !== 0) {
      if (pid === -P) group = false;
      else if (pid === C) descendant = false;
      else positive = false;
    }
    return true;
  } });
  const adapters = {
    process: processAdapter, path, Buffer, Date, Error, RangeError,
    DOMException, AbortController, AbortSignal, setTimeout, clearTimeout,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    constants: { O_CREAT: 1, O_EXCL: 2, O_WRONLY: 4, O_APPEND: 8, O_NOFOLLOW: 16 },
    agentDir: () => "/synthetic/state", ensureAgentDirs: async () => {},
    realpath: async (value: string) => value, stat: async () => ({ isDirectory: () => true }),
    open: async () => ({ fd: 123, writeFile: async () => {}, close: async () => {} }),
    appendFile: async () => {}, bindManagedProcessLog: async (value: string) => ({ path: value }),
    readManagedProcessLog: forbidden("readManagedProcessLog"),
    defaultShell: () => ({ kind: "posix", executable: "/synthetic/sh" }),
    shellCommandInvocation: forbidden("shellCommandInvocation"),
    CancellableRegexMatcher: { create: forbidden("regex worker") }, maxRegexQueryBytes: 65536,
    net: { createConnection: forbidden("network") }, fetch: forbidden("fetch"),
    exec: forbidden("exec"), execFile: forbidden("execFile"), require: forbidden("require"),
    spawn(requested: string, args?: readonly string[]) {
      events.push({ kind: "spawn", command: requested, args });
      if (requested === command) {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }
      assert.equal(requested, "ps", "only exact synthetic tree inspection is allowed");
      assert.equal(platform, "linux", "Windows control must not start a tree helper");
      assert.deepEqual(Array.from(args ?? []), ["-axo", "pid=,ppid="]);
      const helper = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: forbidden("helper.kill") });
      queueMicrotask(() => {
        if (foreign) helper.stdout.emit("data", Buffer.from(`${String(C)} ${String(P)}\n`));
        helper.emit("close", 0);
      });
      return helper;
    }
  };
  const Subject = runInNewContext(javascript + "\nManagedProcessService;", adapters, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
  }) as new (options: ManagedProcessServiceOptions) => Service;
  const service = new Subject({ workspaceRoot: "/synthetic/workspace", terminationGraceMs: 0, killSettleMs: 0 });
  return {
    service, events,
    async start() { return await service.start({ command }); },
    exitLeader(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      positive = false; child.exitCode = code; child.signalCode = signal; child.emit("exit", code, signal);
    },
    replacePid() { group = false; positive = true; descendant = true; foreign = true; },
    noGroup() { group = false; },
    inaccessibleGroup(code: string) { groupError = code; },
    async cleanup() { groupError = undefined; group = false; positive = false; descendant = false; await service.close(); }
  };
}

for (const ending of ["exit", "signal"] as const) {
  for (const operation of ["status", "stop", "close"] as const) {
    test(`retired leader ${ending} with reused positive PID: ${operation}`, async () => {
      const f = fixture();
      try {
        const started = await f.start();
        f.exitLeader(ending === "exit" ? 0 : null, ending === "signal" ? "SIGTERM" : null);
        assert.equal((await f.service.status(started.processId)).state, "running", "surviving group is still owned");
        f.replacePid();
        f.events.length = 0;
        const result = operation === "close" ? await f.service.close() : await f.service[operation](started.processId);
        assert.deepEqual(f.events.filter(event => event.kind === "kill" && event.pid > 0), [],
          "known-exited leader cannot grant authority even to probe a reused positive PID");
        assert.deepEqual(f.events.filter(event => event.kind === "spawn"), [], "must not inspect a foreign process tree");
        if (Array.isArray(result)) assert.equal(result[0]?.status, "not_needed");
        else {
          assert.equal(result.state, ending === "exit" ? "exited" : "failed");
          assert.equal(result.exitCode, ending === "exit" ? 0 : undefined);
          assert.equal(result.signal, ending === "signal" ? "SIGTERM" : undefined);
        }
      } finally { await f.cleanup(); }
    });
  }
}

test("surviving group after known leader exit remains cleanable", async () => {
  const f = fixture();
  try {
    const started = await f.start(); f.exitLeader();
    assert.equal((await f.service.status(started.processId)).state, "running");
    assert.equal((await f.service.stop(started.processId)).cleanup.status, "stopped");
    assert.ok(f.events.some(event => event.kind === "kill" && event.pid === -P && event.signal === "SIGTERM"));
  } finally { await f.cleanup(); }
});

test("normal live leader positive PID fallback remains active", async () => {
  const f = fixture();
  try {
    const started = await f.start(); f.noGroup();
    assert.equal((await f.service.status(started.processId)).state, "running");
    assert.equal((await f.service.stop(started.processId)).cleanup.status, "stopped");
  } finally { await f.cleanup(); }
});

for (const error of ["EPERM", "EACCES"]) {
  test(`inaccessible group ${error} remains potentially alive after leader exit`, async () => {
    const f = fixture();
    try {
      const started = await f.start(); f.exitLeader(); f.inaccessibleGroup(error);
      assert.equal((await f.service.status(started.processId)).state, "running");
    } finally { await f.cleanup(); }
  });
}

test("Windows preserves live positive PID lookup and terminal child exit", async () => {
  const f = fixture("win32");
  try {
    const started = await f.start();
    f.events.length = 0;
    assert.equal((await f.service.status(started.processId)).state, "running");
    assert.ok(f.events.some(event => event.kind === "kill" && event.pid === P && event.signal === 0));
    f.exitLeader(); f.replacePid(); f.events.length = 0;
    assert.equal((await f.service.status(started.processId)).state, "exited");
    assert.equal((await f.service.stop(started.processId)).state, "exited");
    assert.equal((await f.service.close())[0]?.status, "not_needed");
    assert.deepEqual(f.events, [], "terminal Windows child must not probe or invoke taskkill against a reused PID");
  } finally { await f.cleanup(); }
});
