/** CI-only: run the full CLI module in a dependency-isolated VM, with the real SIGINT helper and safe native Promise observers. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as oneShot from "../src/runtime/oneShot.js";
import { withCliAbortSignal } from "../src/cli/sigint.js";

interface Turn { status: string; stopReason: string; steps: number; output: string }
interface Runtime {
  waitForReady(): Promise<void>;
  ensureSession(input: unknown): Promise<{ sessionId: string }>;
  executeRun(sessionId: string, input: string, attachments: unknown[]): Promise<Turn>;
  subscribe(listener: unknown): () => void;
  cancelRunRequest(runId: string, reason: string, sessionId: string): Promise<unknown>;
  getSnapshot(): { info: Record<string, string> };
  usage(): Promise<{ summary: Record<string, number> }>;
  close(): Promise<void>;
}
interface Loaded { runCommand(root: string, input: string, options: { json: boolean }): Promise<Record<string, unknown>> }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = readFileSync(path.join(process.cwd(), "src/cli/commands/run.ts"), "utf8");
// Full module, not a rewritten callback. Only the test adds access to the private
// function; imports used by uncalled entrypoints cannot start a Host or a model.
const compiled = ts.transpileModule(source, {
  fileName: "run.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
});
assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
const allowedImports = new Set([
  "node:crypto", "../../permission/confirm.js", "../../runtime/oneShot.js", "node:fs", "node:path", "../../runtime/taskVerification.js",
  "../../attachments/store.js", "../../config/store.js", "../../runtime/CommandRuntime.js",
  "../../runtime/SessionLease.js", "../../runtime/RuntimeHost.js",
  "../../workspace/resolvePath.js", "../sigint.js", "../runDeadline.js"
]);
const completed: Turn = { status: "completed", stopReason: "model_stop", steps: 1, output: "finished" };

for (const rpcMode of ["accepted", "not-active", "rejected", "no-sigint"] as const) {
  for (const completionMode of ["resolved", "rejected"] as const) {
    test(`attached SIGINT: ${rpcMode} RPC, ${completionMode} completion`, { timeout: 10_000 }, async (t) => {
      const source = new EventEmitter();
      const listening = deferred<void>();
      const completion = deferred<Turn>();
      const rpc = deferred<unknown>();
      // Safety observers bypass the own catch spy, so baseline failure stays
      // contained but cannot receive credit for the product's missing observer.
      const safety = Promise.prototype.then.call(rpc.promise, () => undefined, () => undefined) as Promise<void>;
      const completionSafety = completion.promise.then(() => undefined, () => undefined);
      const originalCatch = rpc.promise.catch.bind(rpc.promise);
      let productObservers = 0;
      Object.defineProperty(rpc.promise, "catch", { configurable: true, value: (handler: (error: unknown) => unknown) => {
        productObservers++; return originalCatch(handler);
      } });
      let signalRemovals = 0;
      const outputs: unknown[][] = [];
      const module = { exports: {} };
      const loaded = runInNewContext(compiled.outputText + "\nmodule.exports;", {
        module, exports: module.exports,
        require: (specifier: string) => {
          assert.ok(allowedImports.has(specifier), `unreviewed dependency: ${specifier}`);
          if (specifier === "node:path") return path;
          if (specifier === "node:crypto") return { randomUUID: () => "submitted-run" };
          if (specifier === "../../runtime/oneShot.js") return oneShot;
          if (specifier === "../../runtime/RuntimeHost.js") return { connectOrSpawnRuntimeHost: async () => runtime };
          if (specifier === "../../config/store.js") return { createFileConfigStore: () => ({ load: async () => ({ workspace: { ignore: [] } }) }) };
          if (specifier === "../sigint.js") return { withCliAbortSignal: <T>(execute: (signal: AbortSignal) => Promise<T>) =>
            withCliAbortSignal(async signal => {
              const remove = signal.removeEventListener.bind(signal);
              t.mock.method(signal, "removeEventListener", (...args: Parameters<typeof remove>) => { signalRemovals++; remove(...args); });
              const pending = execute(signal); listening.resolve(); return await pending;
            }, source) };
          return Object.freeze({});
        },
        process: { pid: 123, env: {} },
        console: { log: (...args: unknown[]) => { outputs.push(args); }, error: () => assert.fail("no new logging contract") }
      }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Loaded;
      let closes = 0; let usageReads = 0; let ready = false;
      const cancellations: unknown[][] = [];
      const runtime: Runtime = {
        waitForReady: async () => { ready = true; },
        ensureSession: async input => { assert.equal(ready, true); assert.deepEqual(JSON.parse(JSON.stringify(input)), { isolation: "shared", writeIntent: true, runOptions: { json: true }, processLifetime: "runtime" }); return { sessionId: "submitted-session" }; },
        executeRun: (sessionId, input, attachments) => {
          assert.equal(sessionId, "submitted-session"); assert.equal(input, "do work");
          assert.equal(attachments.length, 0);
          return completion.promise;
        },
        subscribe: () => () => undefined,
        cancelRunRequest: (...args) => { cancellations.push(args); return rpc.promise; },
        getSnapshot: () => ({ info: { sessionId: "another-focused-session" } }),
        usage: async () => { usageReads++; return { summary: {} }; },
        close: async () => { closes++; }
      };
      const run = loaded.runCommand("/fixture", "do work", { json: true });
      let settlement: { result?: unknown; error?: unknown } | undefined;
      const currentSettlement = () => settlement;
      const observedRun = run.then(result => { settlement = { result }; }, error => { settlement = { error }; });
      const completionFailure = new Error("authoritative completion failed after reconnect");
      try {
        await listening.promise;
        assert.equal(source.listenerCount("SIGINT"), 1);
        if (rpcMode === "no-sigint") {
          if (completionMode === "rejected") completion.reject(completionFailure);
          else completion.resolve(completed);
          await observedRun;
          const settled = currentSettlement(); assert.ok(settled);
          if (completionMode === "rejected") assert.equal(settled.error, completionFailure);
          else assert.equal((settled.result as Record<string, unknown>).status, "completed");
          assert.equal(productObservers, 0); assert.deepEqual(cancellations, []);
          assert.equal(closes, 1); assert.equal(signalRemovals, 1); assert.equal(source.listenerCount("SIGINT"), 0);
          assert.equal(usageReads, 0, "usage is included in the Host response");
          assert.equal(outputs.length, completionMode === "resolved" ? 1 : 0);
          return;
        }
        source.emit("SIGINT");
        const observersAtAbortReturn = productObservers;
        assert.deepEqual(cancellations, [["submitted-run", "cancelled", "submitted-session"]]);
        if (rpcMode === "rejected") rpc.reject(new Error("Runtime Host connection closed."));
        else rpc.resolve({ accepted: rpcMode === "accepted", reason: rpcMode === "not-active" ? "Run is not active." : undefined });
        await safety;
        assert.equal(currentSettlement(), undefined, "the cancellation RPC does not settle the authoritative completion");
        assert.equal(closes, 0, "do not close early while recovery/completion remains pending");
        assert.equal(source.emit("SIGINT"), false, "only the first SIGINT is handled");
        assert.equal(cancellations.length, 1, "never replay cancellation");
        if (completionMode === "rejected") completion.reject(completionFailure);
        else completion.resolve(completed);
        await observedRun;
        const settled = currentSettlement(); assert.ok(settled);
        if (completionMode === "rejected") assert.equal(settled.error, completionFailure);
        else assert.match(String(settled.error), /Operation interrupted by SIGINT/u);
        assert.equal(closes, 1);
        assert.equal(signalRemovals, 1);
        assert.equal(source.listenerCount("SIGINT"), 0);
        assert.equal(usageReads, 0); assert.deepEqual(outputs, []);
        assert.equal(observersAtAbortReturn, 1, "product rejection observer must be installed synchronously, independently of test safety");
      } finally {
        rpc.resolve(undefined); completion.resolve(completed);
        await Promise.all([safety, completionSafety, observedRun]);
      }
    });
  }
}
