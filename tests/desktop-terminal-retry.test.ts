/** Real Manager retryRuntime -> resident real Client -> JSONL resubscribe. CI only. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { flush, observe, terminalFixture, until } from "./fixtures/runtime-host-terminal.js";

for (const sessionId of [undefined, "b"] as const) {
  test(`resident Desktop explicit retry ${sessionId ?? "blank draft"} waits for real client synchronization`, async t => {
    const f = await terminalFixture(t);
    const project = { id: "project", path: f.root, name: "Fixture" };
    const history = [{ type: "user_message", content: "existing history" }];
    const storageReads: string[] = [];
    type Args = ConstructorParameters<typeof DesktopAgentManager>;
    const state = { selectedSessionId: () => sessionId } as unknown as Args[0];
    const projects = {
      requireProject: (id: string) => { assert.equal(id, project.id); return project; },
      dataRoot: async () => f.root,
      refreshStoredProject: async () => project,
      listWorkspaceSessions: async () => ({ sessions: [], sessionPage: { total: 0 } }),
      openSession: async (_project: unknown, id: string) => {
        storageReads.push(id);
        return { session: { id, metadataRevision: "fixture-revision" }, events: structuredClone(history) };
      },
      markSessionRead: async () => ({ sessionId, metadataRevision: "fixture-read-revision" })
    } as unknown as Args[1];
    // Explicit missing configuration prevents provider/model/catalog work. Resident
    // retry and cached workspace projection do not require rebuilding configuration.
    const config = { load: async () => { throw new Error("fixture has no provider configuration"); } } as unknown as Args[2];
    const manager = new DesktopAgentManager(state, projects, config, () => undefined);
    const internals = manager as unknown as {
      runtimes: Map<string, { runtime: typeof f.client; unsubscribe(): void }>;
      runtimeErrors: Map<string, { kind: string; message: string; retryable: boolean }>;
    };
    let updates = 0;
    const managed = { runtime: f.client, unsubscribe: f.client.subscribeAllRuntimeEvents(() => { updates++; }) };
    // Seed only the resident dependency, not retryRuntime/ensureRuntime/getRuntime,
    // resolveSessionRuntime, error handling, workspaceSnapshot, or openSession.
    internals.runtimes.set(project.id, managed);
    try {
      await f.terminal("entry");
      internals.runtimeErrors.set(project.id, { kind: "startup_failed", message: "original failure", retryable: true });
      await f.ownerAvailable(); f.state.subscribe = "hold";
      const retry = observe(manager.retryRuntime(project.id, sessionId));
      await until(() => f.held.length === 1, "manager-driven reconnect subscription");
      assert.equal(retry(), undefined, "manager must await resubscribe before reporting success");
      assert.equal(internals.runtimeErrors.get(project.id)?.message, "original failure");
      assert.equal(f.circuit.consecutiveFailures, 0);
      assert.equal(f.requests.some(frame => frame.operation === "session.ensure"), false, "resolve only after recovery");
      const failedRequest = f.requests.at(-1)!;
      f.sockets.at(-1)!.deliver({ kind: "response", requestId: failedRequest.requestId, ok: false, error: "fixture subscribe rejected" });
      await until(() => retry() !== undefined, "manager records failed recovery");
      const failed = retry(); assert.ok(failed && "value" in failed);
      assert.match(failed.value.workspace.runtimeError?.message ?? "", /fixture subscribe rejected/u);
      assert.equal(f.requests.some(frame => frame.operation === "session.ensure"), false);
      f.state.subscribe = "hold";
      const recovered = observe(manager.retryRuntime(project.id, sessionId));
      await until(() => f.held.length === 2, "manager second recovery subscription");
      assert.equal(recovered(), undefined);
      f.held[1]!();
      await until(() => recovered() !== undefined, "manager successful projection");
      const ready = recovered(); assert.ok(ready && "value" in ready);
      assert.equal(ready.value.workspace.runtimeError, undefined);
      assert.equal(internals.runtimes.get(project.id), managed, "retain same managed client and subscriptions");
      assert.equal(f.client.getFocusedSessionId(), "a", "explicit retry must not switch focus");
      if (sessionId === undefined) {
        assert.equal(ready.value.document, undefined); assert.deepEqual(storageReads, []);
        assert.equal(f.requests.some(frame => frame.operation === "session.ensure"), false);
      } else {
        assert.equal(ready.value.document?.runtimeSnapshot?.info.sessionId, sessionId);
        assert.deepEqual(ready.value.document?.events, history);
        assert.equal(f.requests.filter(frame => frame.operation === "session.ensure").length, 1);
      }
      const newIdle = observe(f.client.waitForIdle("a")); f.idle("a"); await flush();
      assert.deepEqual(newIdle(), { value: undefined }); assert.equal(updates, 1);
      assert.equal(f.requests.filter(frame => frame.operation === "submit" || frame.operation === "start-interrupted" || frame.operation === "cancel").length, 0);
      await f.unchanged();
    } finally { await manager.closeAll(); }
  });
}

test("Desktop retry replaces a retired resident through actual discovery instead of retrying it", { skip: process.platform === "win32" ? "Runtime Host discovery is Unix-only; no local Host/SQLite fallback" : false }, async t => {
  const f = await terminalFixture(t);
  f.state.capabilities = ["host.idle-retirement"];
  const retired = await f.connect();
  f.sockets[1]!.deliver({ kind: "retired", hostEpoch: "epoch-a", reason: "idle" }); await flush();
  assert.equal(retired.isRetired, true);
  f.state.epoch = "epoch-b"; await f.ownerAvailable();
  const project = { id: "retired-project", path: f.root, name: "Fixture" };
  type Args = ConstructorParameters<typeof DesktopAgentManager>;
  const state = { selectedSessionId: () => undefined } as unknown as Args[0];
  const projects = {
    requireProject: () => project, dataRoot: async () => f.root,
    refreshStoredProject: async () => project,
    listWorkspaceSessions: async () => ({ sessions: [], sessionPage: { total: 0 } })
  } as unknown as Args[1];
  let loads = 0;
  const config = {
    configPath: () => path.join(f.root, "config", "config.json"),
    load: async () => {
      if (loads++ === 0) return { permission: { mode: "ask" } };
      throw new Error("fixture omits optional catalog projection");
    }
  } as unknown as Args[2];
  const manager = new DesktopAgentManager(state, projects, config, () => undefined);
  const internal = manager as unknown as { runtimes: Map<string, { runtime: typeof f.client; unsubscribe(): void }> };
  let unsubscribed = 0;
  internal.runtimes.set(project.id, { runtime: retired, unsubscribe: () => { unsubscribed++; } });
  try {
    const result = await manager.retryRuntime(project.id);
    assert.equal(result.workspace.runtimeError, undefined);
    const replacement = internal.runtimes.get(project.id)?.runtime;
    assert.ok(replacement); assert.notEqual(replacement, retired);
    assert.equal(replacement.hostInfo?.hostEpoch, "epoch-b");
    assert.equal(unsubscribed, 1); assert.equal(f.sockets.length, 3);
    assert.equal(f.requests.filter(frame => frame.operation === "submit" || frame.operation === "start-interrupted").length, 0);
    await f.unchanged();
  } finally { await manager.closeAll(); }
});
