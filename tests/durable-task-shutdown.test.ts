/**
 * Real CommandRuntime task admission and Host restart, with only a filesystem
 * result-delivery gate and a synthetic model transport. Intended for normal CI.
 * Lifecycle observers call the original methods unchanged. No closure, store,
 * cancellation or lifecycle implementation is replaced by a fake.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import type { TaskClosureResult } from "../src/runtime/TaskClosure.js";
import type { RuntimeHostFactory, HostRegistration } from "../src/runtime/host/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function holdWorkspaceStat(root: string, eligible: () => boolean) {
  const entered = deferred();
  const released = deferred();
  const original = fs.lstat;
  let held = false;
  fs.lstat = new Proxy(original, {
    apply(target, receiver, args: unknown[]) {
      const result = Reflect.apply(target, receiver, args) as Promise<unknown>;
      if (held || String(args[0]) !== root || !eligible()) return result;
      held = true;
      // lstat has no AbortSignal parameter. Preserve its real result and delay
      // only delivery, like a filesystem call already pending during shutdown.
      return result.then(async (metadata) => {
        entered.resolve();
        await released.promise;
        return metadata;
      });
    }
  });
  syncBuiltinESMExports();
  return {
    entered: entered.promise,
    release: released.resolve,
    restore() { fs.lstat = original; syncBuiltinESMExports(); }
  };
}

await test("durable task shutdown ownership", { timeout: 90_000 }, async (suite) => {
  const isolated = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-shutdown-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.BINY_AGENT_DIR = path.join(isolated, "agent");
  try {
    // Product imports occur only after all global persistence is isolated.
    const { defaultConfig } = await import("../src/config/schema.js");
    const { createInteractiveAgentHost } = await import("../src/runtime/InteractiveAgentRuntime.js");
    const { RuntimeHostServer } = await import("../src/runtime/host/server.js");
    const { runtimeHostProtocolVersion } = await import("../src/runtime/host/protocol.js");
    const { RuntimeEventAuthority } = await import("../src/runtime/RuntimeAuthority.js");
    const { DurableTaskRunStore } = await import("../src/runtime/TaskRunStore.js");
    const config = structuredClone(defaultConfig);
    config.defaultModel = "synthetic";
    config.providers = { local: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
    config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
    config.checkpoints.enabled = false;
    config.extensions.subagent.enabled = true;
    config.heartbeat.enabled = false;
    config.context.memory.enabled = false;
    config.context.identity.enabled = false;
    const configStore = { load: async () => structuredClone(config), save: async () => undefined };

    for (const stage of ["before-worker", "after-worker"] as const) {
      for (const action of ["close", "restart"] as const) {
        await suite.test(`${action} cancels and joins ${stage} snapshot before storage closes`, async () => {
          const root = path.join(isolated, `${action}-${stage}`);
          await fs.mkdir(root);
          await fs.writeFile(path.join(root, "artifact.txt"), "candidate\n");
          await fs.writeFile(path.join(root, "definition.txt"), "original verification definition\n");
          let providerCalls = 0;
          globalThis.fetch = async () => {
            providerCalls += 1;
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"candidate ready"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } });
          };
          const created: InteractiveAgentHost[] = [];
          const factory: RuntimeHostFactory = async (sessionId, options) => {
            const next = await createInteractiveAgentHost(root, {
              configStore, sessionId, resourceRegistry: options?.resourceRegistry
            });
            created.push(next);
            return next;
          };
          const initial = await factory("shutdown-session");
          const commands = initial.commands;
          const manager = commands.subagents;
          assert.ok(manager);
          const managerDrained = deferred();
          const originalManagerClose = manager.close;
          manager.close = function () {
            const result = originalManagerClose.call(this);
            void result.then(managerDrained.resolve, managerDrained.resolve);
            return result;
          };
          let agentCloseStarted = false;
          const originalAgentClose = commands.agent.close;
          commands.agent.close = function () {
            agentCloseStarted = true;
            return originalAgentClose.call(this);
          };
          let closureSettled = false;
          const storeCloseObserved: boolean[] = [];
          const originalStoreClose = commands.taskRuns.close;
          commands.taskRuns.close = function () {
            storeCloseObserved.push(closureSettled);
            originalStoreClose.call(this);
          };
          const registration: HostRegistration = {
            protocolVersion: runtimeHostProtocolVersion, persistenceRoot: root,
            agentRoot: process.env.BINY_AGENT_DIR, endpoint: path.join(root, "unused.sock"),
            registrationPath: path.join(root, "unused-registration.json"),
            lockPath: path.join(root, "unused-owner.lock"), rootHash: "test",
            hostEpoch: "test", token: "test", pid: process.pid, createdAt: new Date().toISOString()
          };
          // This exercises the real Host constructor, registry and public restart
          // method in process. No socket listener or process-election lock is needed.
          const host = action === "restart"
            ? new RuntimeHostServer(initial.runtime, commands, registration, { close: async () => undefined }, factory)
            : undefined;
          if (host) await host.initialize();
          const gate = holdWorkspaceStat(root, () => stage === "before-worker" ? providerCalls === 0 : providerCalls > 0);
          let taskCompletion: Promise<TaskClosureResult> | undefined;
          let shutdown: Promise<unknown> | undefined;
          let lateCompletion: Promise<TaskClosureResult> | undefined;
          try {
            const task = commands.taskRuns.create({
              sessionId: initial.runtime.getSnapshot().info.sessionId,
              task: { prompt: "Inspect the candidate", communication: true,
                verification: {
                  objective: "Check the candidate", artifactPaths: ["artifact.txt"],
                  allowedRepairPaths: ["artifact.txt"], maxAttempts: 1,
                  checks: [{ id: "check", command: "unused-check-must-not-run", definitionPaths: ["definition.txt"] }]
                } }
            });
            const late = commands.taskRuns.create({
              sessionId: initial.runtime.getSnapshot().info.sessionId,
              task: { prompt: "Must not be admitted during close", reportOnly: true }
            });
            taskCompletion = (await commands.startTaskRun(task.taskRunId)).completion;
            // Observe rejection immediately, including the intentionally broken baseline.
            const outcome = taskCompletion.then(
              (value) => { closureSettled = true; return { value }; },
              (error: unknown) => { closureSettled = true; return { error }; }
            );
            await bounded(Promise.race([
              gate.entered,
              outcome.then(() => { throw new Error("Task settled before the snapshot gate"); })
            ]), "snapshot gate");
            assert.equal(initial.runtime.getSnapshot().state.kind, "idle");
            assert.equal(commands.hasBackgroundWork(), true);
            assert.equal(providerCalls, stage === "before-worker" ? 0 : 1);
            assert.equal(commands.taskRuns.get(task.taskRunId)?.status, stage === "before-worker" ? "queued" : "verifying");
            let shutdownSettled = false;
            shutdown = (host ? host.restartRuntime() : initial.runtime.close()).finally(() => { shutdownSettled = true; });
            void shutdown.catch(() => undefined);
            // Observe the real scheduler close, then allow its caller's continuation
            // to run. An abort-only fix would already enter agent.close here.
            await bounded(managerDrained.promise, "child scheduler shutdown");
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(agentCloseStarted, false, "agent and recorder shutdown must wait for the task closure, not just its worker");
            assert.equal(shutdownSettled, false, "uninterruptible snapshot delivery still owns storage");
            assert.ok(commands.taskRuns.get(task.taskRunId), "the old store stays readable until its admitted closure settles");
            // Admission must close even though the store intentionally remains usable.
            let lateError: unknown;
            try {
              const admitted = await commands.startTaskRun(late.taskRunId);
              lateCompletion = admitted.completion;
              void lateCompletion.catch(() => undefined);
            } catch (error) { lateError = error; }
            assert.match(String(lateError), /Task runtime is closing/u);
            assert.equal(commands.taskRuns.get(late.taskRunId)?.attempts.length, 0);
            assert.equal(commands.cancelTaskRun(late.taskRunId).status, "cancelled", "cancellation remains available during drain");
            gate.release();
            await shutdown;
            const settled = await outcome;
            assert.ok("value" in settled, `closure rejected instead of durably cancelling: ${"error" in settled ? String(settled.error) : ""}`);
            assert.equal(settled.value.status, "cancelled");
            assert.deepEqual(storeCloseObserved, [true], "the original store closes only after durable settlement");
            assert.equal(providerCalls, stage === "before-worker" ? 0 : 1, "shutdown never dispatches or repeats the worker");
            const authority = await RuntimeEventAuthority.openReadOnly(root);
            assert.ok(authority);
            const reopened = await DurableTaskRunStore.open(root, authority);
            try {
              const persisted = reopened.get(task.taskRunId);
              assert.equal(persisted?.status, "cancelled");
              assert.equal(persisted?.attempts.length, 1);
              assert.equal(persisted?.attempts[0]?.status, "cancelled");
              assert.equal(reopened.get(late.taskRunId)?.attempts.length, 0);
              assert.equal(reopened.get(late.taskRunId)?.status, "cancelled");
              if (stage === "after-worker") {
                assert.equal((persisted?.attempts[0]?.artifacts as { output?: string })?.output, "candidate ready");
              }
            } finally { reopened.close(); authority.close(); }
            if (host) assert.equal(created.length, 2, "restart constructs its replacement only after the old closure settles");
          } finally {
            gate.release();
            gate.restore();
            await Promise.allSettled([...(taskCompletion ? [taskCompletion] : []), ...(lateCompletion ? [lateCompletion] : []), ...(shutdown ? [shutdown] : [])]);
            if (host) await host.close();
            for (const entry of created) await entry.runtime.close();
            manager.close = originalManagerClose;
            commands.agent.close = originalAgentClose;
            commands.taskRuns.close = originalStoreClose;
            globalThis.fetch = originalFetch;
          }
        });
      }
    }

    await suite.test("closing a completed task preserves its terminal result", async () => {
      const root = path.join(isolated, "completed-control");
      await fs.mkdir(root);
      globalThis.fetch = async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"finished report"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
      const current = await createInteractiveAgentHost(root, { configStore });
      try {
        const task = current.commands.taskRuns.create({
          sessionId: current.runtime.getSnapshot().info.sessionId,
          task: { prompt: "Return the report", reportOnly: true }
        });
        const result = await (await current.commands.startTaskRun(task.taskRunId)).completion;
        assert.equal(result.status, "completed");
        const before = current.commands.taskRuns.get(task.taskRunId);
        await current.runtime.close();
        const authority = await RuntimeEventAuthority.openReadOnly(root);
        assert.ok(authority);
        const reopened = await DurableTaskRunStore.open(root, authority);
        try { assert.deepEqual(reopened.get(task.taskRunId), before); }
        finally { reopened.close(); authority.close(); }
      } finally { await current.runtime.close(); globalThis.fetch = originalFetch; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(isolated, { recursive: true, force: true });
  }
});
