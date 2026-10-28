/** Real Manager retryRuntime -> resident real Client -> JSONL resubscribe. CI only. */
import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { flush, observe, terminalFixture, until } from "./fixtures/runtime-host-terminal.js";

for (const sessionId of [undefined, "b"] as const) {
  test(`resident Desktop explicit retry ${sessionId ?? "blank draft"} waits for real client synchronization`, async t => {
    const f = await terminalFixture(t);
    const project = { id: "project", path: f.root, name: "Fixture" };
    const history = [{ type: "user_message", content: "existing history" }];
    const storageReads: string[] = [];
    type Args = ConstructorParameters<typeof DesktopAgentManager>;
    const state = {
      project: (id: string) => id === project.id ? project : undefined,
      selectedSessionId: () => sessionId
    } as unknown as Args[0];
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
    const config = { configPath: () => path.join(f.root, "config", "config.json"), load: async () => ({ ...structuredClone(defaultConfig), providers: {}, models: {} }) } as unknown as Args[2];
    const manager = new DesktopAgentManager(state, projects, config, () => undefined);
    const internals = manager as unknown as {
      runtimes: Map<string, { runtime: typeof f.client; unsubscribe(): void }>;
      runtimeErrors: Map<string, { kind: string; message: string; retryable: boolean }>;
    };
    let updates = 0;
    const managed = { runtime: f.client, unsubscribe: f.client.subscribeAllRuntimeEvents(() => { updates++; }) };
    // Seed the resident dependency and an error-cache sentinel. This checks retry
    // ordering, not how a consumer projects the original terminal failure.
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
      assert.equal(f.client.getFocusedSessionId(), sessionId ?? "a", "configuration restart keeps the requested session focused");
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
      assert.equal(f.requests.filter(frame => frame.operation === "run.submit" || frame.operation === "start-interrupted" || frame.operation === "cancel").length, 0);
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
  const state = {
    project: (id: string) => id === project.id ? project : undefined,
    selectedSessionId: () => undefined
  } as unknown as Args[0];
  const projects = {
    requireProject: () => project, dataRoot: async () => f.root,
    refreshStoredProject: async () => project,
    listWorkspaceSessions: async () => ({ sessions: [], sessionPage: { total: 0 } })
  } as unknown as Args[1];
  const config = {
    configPath: () => path.join(f.root, "config", "config.json"),
    load: async () => {
      return { ...structuredClone(defaultConfig), providers: {}, models: {} };
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
    assert.equal(f.requests.filter(frame => frame.operation === "run.submit" || frame.operation === "start-interrupted").length, 0);
    await f.unchanged();
  } finally { await manager.closeAll(); }
});

/** Only storage/configuration boundaries are synthetic; Manager and Client stay real. */
async function residentDesktopFixture(t: TestContext) {
  const owned: { manager?: DesktopAgentManager } = {};
  // Register before the wire fixture so Manager closes before mocks are restored.
  t.after(async () => { await owned.manager?.closeAll(); });
  const f = await terminalFixture(t);
  const project = { id: "project", path: f.root, name: "Fixture" };
  const members = new Map([[project.id, project]]);
  const history = [{ type: "user_message", content: "existing history" }];
  const storageReads: string[] = [];
  const selected: { sessionId?: string } = {};
  const counts = { dataRoots: 0, configLoads: 0, unsubscribed: 0, updates: 0 };
  type Args = ConstructorParameters<typeof DesktopAgentManager>;
  const requireProject = (id: string) => {
    const current = members.get(id);
    if (!current) throw new Error(`Project ${id} is not registered.`);
    return current;
  };
  const selectionTokens = new WeakMap<object, object>();
  const state = {
    project: (id: string) => members.get(id),
    selectedSessionId: () => selected.sessionId,
    captureSelectedSessionLifetime: (id: string) => {
      const owner = members.get(id);
      const token = owner ? selectionTokens.get(owner) : undefined;
      return () => owner !== undefined && members.get(id) === owner && selectionTokens.get(owner) === token;
    },
    setSelectedSession: async (id: string, sessionId: string | undefined) => {
      const owner = requireProject(id);
      selectionTokens.set(owner, {});
      selected.sessionId = sessionId;
    }
  } as unknown as Args[0];
  const projects = {
    requireProject,
    dataRoot: async () => { counts.dataRoots++; return f.root; },
    refreshStoredProject: async (id: string) => requireProject(id),
    listWorkspaceSessions: async () => ({ sessions: [], sessionPage: { total: 0 } }),
    openSession: async (_project: unknown, id: string) => {
      storageReads.push(id);
      return { session: { id, metadataRevision: "fixture-revision" }, events: structuredClone(history) };
    },
    markSessionRead: async (_project: unknown, sessionId: string) => ({ sessionId, metadataRevision: "fixture-read-revision" })
  } as unknown as Args[1];
  const config = {
    configPath: () => path.join(f.root, "config", "config.json"),
    load: async () => { counts.configLoads++; return { ...structuredClone(defaultConfig), providers: {}, models: {} }; }
  } as unknown as Args[2];
  const manager = new DesktopAgentManager(state, projects, config, () => { counts.updates++; });
  owned.manager = manager;
  const unsubscribe = f.client.subscribeAllRuntimeEvents(() => { counts.updates++; });
  manager["runtimes"].set(project.id, {
    runtime: f.client,
    unsubscribe: () => { counts.unsubscribed++; unsubscribe(); }
  });
  return { ...f, manager, project, members, history, storageReads, selected, counts };
}

for (const action of ["disposeProject", "closeAll"] as const) {
  test(`Desktop ${action} during held real recovery cannot restore a resident or error`, async t => {
    const f = await residentDesktopFixture(t);
    await f.terminal("entry");
    await f.ownerAvailable();
    f.state.subscribe = "hold";
    const retry = observe(f.manager.retryRuntime(f.project.id, "b"));
    await until(() => f.held.length === 1, "held Desktop recovery subscription");
    assert.equal(retry(), undefined);
    const requestCount = f.requests.length;
    const socketCount = f.sockets.length;
    const dataRoots = f.counts.dataRoots;
    if (action === "disposeProject") {
      await f.manager.disposeProject(f.project.id);
      f.members.delete(f.project.id);
    } else {
      await f.manager.closeAll();
    }
    f.held[0]!();
    await until(() => retry() !== undefined, "disposed recovery rejection");
    const result = retry();
    assert.ok(result && "error" in result);
    assert.match(String(result.error), /Project runtime was disposed/u);
    assert.equal(f.manager["runtimes"].has(f.project.id), false);
    assert.equal(f.manager["runtimeErrors"].has(f.project.id), false);
    assert.equal(f.manager["runtimeInitializations"].size, 0);
    assert.equal(f.manager["runtimeLifetimes"].has(f.project.id), false);
    assert.equal(f.counts.unsubscribed, 1);
    assert.equal(f.sockets.at(-1)?.destroyed, true);
    assert.equal(f.sockets.length, socketCount);
    assert.equal(f.requests.length, requestCount);
    assert.equal(f.counts.dataRoots, dataRoots);
    assert.equal(f.counts.configLoads, 1, "configuration reload precedes held reconnect");
    assert.deepEqual(f.storageReads, ["b"], "no post-disposal history projection");
    await f.unchanged();
  });
}

for (const installReplacement of [false, true]) {
  test(`Desktop settled recovery cannot enter a same-ID lifetime ${installReplacement ? "with a replacement" : "without a resident"}`, async t => {
    const gate: { release?: () => void; retry?: Promise<unknown>; manager?: DesktopAgentManager } = {};
    t.after(async () => {
      gate.release?.();
      await gate.manager?.closeAll();
      await Promise.allSettled([gate.retry]);
    });
    const f = await residentDesktopFixture(t);
    gate.manager = f.manager;
    const release = new Promise<void>(resolve => { gate.release = resolve; });
    const retryConnection = f.client.retryConnection.bind(f.client);
    let synchronized = false;
    // Delay only return to Manager after the actual Client has completed hello,
    // subscribe, snapshot reconciliation and its own connection validation.
    t.mock.method(f.client, "retryConnection", async () => {
      await retryConnection();
      synchronized = true;
      await release;
    });
    await f.terminal("entry");
    await f.ownerAvailable();
    f.state.subscribe = "hold";
    gate.retry = f.manager.retryRuntime(f.project.id, installReplacement ? "b" : undefined);
    const retry = observe(gate.retry);
    await until(() => f.held.length === 1, "real recovery before return gate");
    f.held[0]!();
    await until(() => synchronized, "real Client recovery completed");
    assert.equal(retry(), undefined);
    await f.manager.disposeProject(f.project.id);
    f.members.delete(f.project.id);
    f.members.set(f.project.id, { ...f.project });
    // A regressed continuation must settle its unwanted new discovery so the
    // assertions below catch it without leaving cleanup on a held subscribe.
    f.state.subscribe = "ok";
    const replacement: { client?: typeof f.client } = {};
    const replacementError = { kind: "startup_failed" as const, message: "replacement lifetime failure", retryable: true };
    if (installReplacement) {
      replacement.client = await f.connect();
      f.manager["runtimes"].set(f.project.id, { runtime: replacement.client, unsubscribe: () => undefined });
      // A public history read admits the replacement lifetime without a Host start.
      await f.manager.openSession(f.project.id, "a");
      f.manager["runtimeErrors"].set(f.project.id, replacementError);
    }
    const lifetime = f.manager["runtimeLifetimes"].get(f.project.id);
    assert.equal(lifetime !== undefined, installReplacement);
    const requestCount = f.requests.length;
    const socketCount = f.sockets.length;
    const dataRoots = f.counts.dataRoots;
    const configLoads = f.counts.configLoads;
    const updates = f.counts.updates;
    const storageReads = [...f.storageReads];
    gate.release!();
    await until(() => retry() !== undefined, "old recovery settlement");
    const result = retry();
    assert.ok(result && "error" in result);
    assert.match(String(result.error), /Project runtime was disposed/u);
    assert.equal(f.manager["runtimeLifetimes"].get(f.project.id), lifetime, "old continuation cannot admit a fresh lifetime");
    assert.equal(f.manager["runtimeInitializations"].size, 0);
    assert.equal(f.manager["runtimes"].get(f.project.id)?.runtime === replacement.client, true);
    assert.equal(f.manager["runtimeErrors"].get(f.project.id)?.message, installReplacement ? replacementError.message : undefined);
    assert.equal(f.sockets.length, socketCount, "old continuation cannot discover or create a runtime");
    assert.equal(f.requests.length, requestCount, "old continuation cannot ensure a replacement session");
    assert.equal(f.counts.dataRoots, dataRoots);
    assert.equal(f.counts.configLoads, configLoads);
    assert.equal(f.counts.updates, updates);
    assert.deepEqual(f.storageReads, storageReads);
    assert.equal(f.counts.unsubscribed, 1);
    await f.unchanged();
  });
}

test("Desktop interrupted-run consumer projects terminal recovery failure before explicit retry clears it", async t => {
  const f = await residentDesktopFixture(t);
  const receipt = await f.manager.resumeInterruptedTurn(f.project.id, "a");
  assert.ok(receipt);
  const terminal = await f.terminal("entry");
  const workspace = await f.manager.workspaceSnapshot(f.project.id, false);
  const document = await f.manager.openSession(f.project.id, "a");
  assert.equal(workspace.runtimeError?.message, terminal.message);
  assert.equal(document.runtimeError?.message, terminal.message);
  assert.equal(workspace.runtimeError?.retryable, true);
  assert.equal(document.runtimeError?.retryable, true);
  assert.deepEqual(document.events, f.history);
  assert.equal(f.requests.filter(frame => frame.operation === "start-interrupted").length, 1);
  await f.ownerAvailable();
  f.state.subscribe = "hold";
  const retry = observe(f.manager.retryRuntime(f.project.id, "a"));
  await until(() => f.held.length === 1, "consumer recovery subscription");
  assert.equal(retry(), undefined);
  assert.equal((await f.manager.workspaceSnapshot(f.project.id, false)).runtimeError?.message, terminal.message);
  f.held[0]!();
  await until(() => retry() !== undefined, "consumer error cleared after synchronization");
  const result = retry();
  assert.ok(result && "value" in result);
  assert.equal(result.value.workspace.runtimeError, undefined);
  assert.equal(result.value.document?.runtimeError, undefined);
  assert.deepEqual(result.value.document?.events, f.history);
  assert.equal(f.requests.filter(frame => frame.operation === "start-interrupted").length, 1, "retry must not restart the interrupted turn again");
  assert.equal(f.requests.filter(frame => frame.operation === "run.submit" || frame.operation === "cancel").length, 0);
  await f.unchanged();
});
