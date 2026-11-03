import { readyHostClient } from "./helpers/readyHostClient.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import type { CommandRuntimeOptions } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { SessionLeaseStore } from "../src/runtime/SessionLease.js";
import { createRuntimeHostFactory } from "../src/runtime/host/runtimeFactory.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-factory-")));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.defaultModel = "fixture";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://factory.invalid/v1", requiresApiKey: false } };
  config.models = { fixture: { provider: "fixture", model: "fixture" } };
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  config.heartbeat.enabled = false;
  config.computer.enabled = false;
  config.checkpoints.enabled = false;
  const configStore: AgentConfigStore = { load: async () => structuredClone(config), save: async () => undefined };
  const options: CommandRuntimeOptions = { persistenceRoot: root, configStore };
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Factory tests must not contact a model."); });
  const hosts: InteractiveAgentHost[] = [];
  const closers: Array<() => void | Promise<void>> = [];
  const closeCounts = new Map<InteractiveAgentRuntime, number>();
  const originalClose = InteractiveAgentRuntime.prototype.close;
  t.mock.method(InteractiveAgentRuntime.prototype, "close", function (this: InteractiveAgentRuntime) {
    closeCounts.set(this, (closeCounts.get(this) ?? 0) + 1);
    return originalClose.call(this);
  });
  t.after(async () => {
    for (const close of closers) await close();
    for (const host of hosts) if (!closeCounts.has(host.runtime)) await host.runtime.close();
    assert.equal(network.mock.callCount(), 0);
    await rm(root, { recursive: true, force: true });
  });
  return { root, options, configStore, hosts, closeCounts, closers };
}

test("Host factory keeps persistence fixed while creating fresh worktree sessions and resuming history", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const worktree = path.join(f.root, "worktree");
  await mkdir(worktree);
  const factory = createRuntimeHostFactory(f.root, () => f.options, host => { f.hosts.push(host); });
  const fresh = await factory("fresh-session", { fresh: true, workspaceRoot: worktree });
  assert.equal(fresh.runtime.getSnapshot().info.sessionId, "fresh-session");
  assert.equal(fresh.commands.workspaceRoot, worktree);
  assert.equal(fresh.commands.persistenceRoot, f.root);
  assert.equal(f.closeCounts.get(fresh.runtime), undefined, "successful delivery must transfer an open runtime");
  await createSessionFile(f.root, "saved-session", Buffer.from('{"type":"user_message","content":"saved fact"}\n'));
  const resumed = await factory("saved-session");
  assert.equal(resumed.runtime.getSnapshot().info.sessionId, "saved-session");
  assert.ok(resumed.commands.agent.getInfo().sessionFile.endsWith("saved-session.jsonl"));
});

test("Host registry rejects a writer conflict, closes the unregistered runtime once and supports retry", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await createSessionFile(f.root, "blocked-session", Buffer.from('{"type":"user_message","content":"held fact"}\n'));
  const leases = await SessionLeaseStore.open(f.root);
  f.closers.unshift(() => leases.close());
  const held = leases.acquire("blocked-session");
  const factory = createRuntimeHostFactory(f.root, () => f.options, host => { f.hosts.push(host); });
  const server = await startRuntimeHost(f.root, registry => factory("primary-session", { fresh: true, resourceRegistry: registry }), { createRuntime: factory });
  f.closers.unshift(async () => { await server.close(); });
  const client = await readyHostClient(await connectRuntimeHost(f.root));

  assert.ok(client);
  f.closers.unshift(async () => { await client.close(); });
  await assert.rejects(client.ensureSession({ sessionId: "blocked-session", focus: false }), /writer|lease|another process/iu);
  const rejected = f.hosts.at(-1)!;
  assert.equal(f.closeCounts.get(rejected.runtime), 1);
  await assert.rejects(rejected.runtime.startDraft(), /closed/iu);
  assert.equal(client.runtimeSnapshots().some(entry => entry.sessionId === "blocked-session"), false);
  assert.equal(client.getSnapshot("primary-session").state.kind, "idle");
  held.close();
  const retried = await client.ensureSession({ sessionId: "blocked-session", focus: false });
  assert.equal(retried.sessionId, "blocked-session");
  assert.equal(f.closeCounts.get(f.hosts.at(-1)!.runtime), undefined);
});

for (const stage of ["create", "initialize"] as const) {
  test(`Host factory releases owned resources after ${stage} failure`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const failure = new Error(`${stage} failed`);
    if (stage === "create") t.mock.method(f.configStore, "load", async () => { throw failure; });
    const factory = createRuntimeHostFactory(f.root, () => f.options, host => {
      f.hosts.push(host);
      throw failure;
    });
    await assert.rejects(factory("failed-session", { fresh: true }), error => error === failure);
    assert.equal(f.hosts.length, stage === "create" ? 0 : 1);
    if (stage === "initialize") {
      const rejected = f.hosts[0]!;
      assert.equal(f.closeCounts.get(rejected.runtime), 1);
      await assert.rejects(rejected.runtime.startDraft(), /closed/iu);
    } else assert.equal(f.closeCounts.size, 0, "the factory cannot close a runtime that was never returned");
  });
}

test("Host factory retains initialization and cleanup failures together", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const failure = new Error("initialization failed");
  const closeFailure = new Error("cleanup failed");
  const factory = createRuntimeHostFactory(f.root, () => f.options, host => {
    f.hosts.push(host);
    const close = host.runtime.close.bind(host.runtime);
    t.mock.method(host.runtime, "close", async () => { await close(); throw closeFailure; });
    throw failure;
  });
  await assert.rejects(factory(), error => error instanceof AggregateError
    && error.cause === failure && error.errors[0] === failure && error.errors[1] === closeFailure);
  assert.equal(f.closeCounts.get(f.hosts[0]!.runtime), 1);
});

for (const attachedAfterCreate of [false, true]) {
  test(`Host factory applies browser ${attachedAfterCreate ? "attachment" : "revocation"} during awaited creation`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const originalLoad = f.configStore.load;
    t.mock.method(f.configStore, "load", async () => {
      enter();
      await barrier;
      return await originalLoad();
    });
    const endpoint = { endpoint: path.join(f.root, "synthetic-browser.sock"), token: "synthetic-browser-token" };
    let current = attachedAfterCreate ? undefined : endpoint;
    const factory = createRuntimeHostFactory(f.root, () => ({ ...f.options, browserAutomation: current }), host => {
      f.hosts.push(host);
      host.commands.setBrowserAutomation!(current);
    });
    const pending = factory("first", { fresh: true });
    try {
      await entered;
      current = attachedAfterCreate ? endpoint : undefined;
    } finally {
      release();
    }
    const first = await pending;
    assert.equal(first.commands.listTools().some(tool => tool.name === "BrowserOpen"), attachedAfterCreate);
    current = attachedAfterCreate ? undefined : endpoint;
    const second = await factory("second", { fresh: true });
    assert.equal(second.commands.listTools().some(tool => tool.name === "BrowserOpen"), !attachedAfterCreate);
  });
}
