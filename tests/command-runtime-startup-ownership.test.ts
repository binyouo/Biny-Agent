import assert from "node:assert/strict";
import io, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { sessionFilePath } from "../src/session/store.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";
import { RuntimeHostResourceRegistry, RuntimeHostResourceScope } from "../src/runtime/host/resources.js";

async function fixture(t: TestContext, subagents = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-startup-ownership-"));
  const workspace = path.join(root, "workspace");
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  await fs.mkdir(workspace);
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "fixture",
    providers: { fixture: { type: "openai-compatible", baseUrl: "https://unused-model.invalid/v1", requiresApiKey: false } },
    models: { fixture: { provider: "fixture", model: "fixture" } },
    checkpoints: { ...defaultConfig.checkpoints, enabled: false },
    extensions: { ...defaultConfig.extensions, skills: [], plugins: [], globalPlugins: [], mcp: {},
      subagent: { ...defaultConfig.extensions.subagent, enabled: subagents } },
    context: { ...defaultConfig.context, identity: { ...defaultConfig.context.identity, enabled: false },
      memory: { ...defaultConfig.context.memory, enabled: false, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  });
  const closes: string[] = [];
  const manual: Array<() => unknown> = [];
  const descriptors = new Map<number, io.Stats>();
  const expectedFile = sessionFilePath(workspace, "ownership-fixture");
  const open = io.openSync;
  // Observe only this synthetic recorder's real descriptor. No I/O is replaced.
  t.mock.method(io, "openSync", (...args: Parameters<typeof io.openSync>) => {
    const descriptor = open(...args);
    if (args[0] === expectedFile) descriptors.set(descriptor, io.fstatSync(descriptor));
    return descriptor;
  });
  syncBuiltinESMExports();
  const sink = RuntimeEventAuthority.prototype.asSink;
  t.mock.method(RuntimeEventAuthority.prototype, "asSink", function (this: RuntimeEventAuthority) {
    manual.push(() => this.close());
    return sink.call(this);
  });
  const start = RuntimeHostResourceScope.prototype.start;
  t.mock.method(RuntimeHostResourceScope.prototype, "start", function (this: RuntimeHostResourceScope) {
    manual.push(() => this.close());
    return start.call(this);
  });
  t.after(async () => {
    // Assertion snapshots always precede this fallback for intentionally RED runs.
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const close of manual) await close();
    for (const [descriptor, identity] of descriptors) {
      try {
        const current = io.fstatSync(descriptor);
        if (current.dev === identity.dev && current.ino === identity.ino) io.closeSync(descriptor);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
    }
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const configStore = { load: async () => config, save: async () => { throw new Error("Unexpected config save"); } };
  return { workspace, config, configStore, closes, manual,
    create: (registry?: RuntimeHostResourceRegistry) => createCommandRuntime(workspace, {
      sessionId: "ownership-fixture", configStore, resourceRegistry: registry, resourceBoot: "blocking"
    }),
    assertDescriptorClosed() {
      assert.equal(descriptors.size, 1, "one real recorder descriptor was acquired");
      for (const descriptor of descriptors.keys()) assert.throws(() => io.fstatSync(descriptor), { code: "EBADF" });
    }
  };
}

function observeCleanup(t: TestContext, closes: string[], throwView = false, failAgent = false) {
  const syncOwners: Array<[string, { close(): void }]> = [
    ["automation", AutomationStore.prototype], ["graphs", GoalGraphStore.prototype],
    ["goals", SessionGoalStore.prototype], ["capabilities", CapabilityStore.prototype],
    ["communication", TaskCommunication.prototype], ["tasks", DurableTaskRunStore.prototype],
    ["authority", RuntimeEventAuthority.prototype]
  ];
  for (const [name, prototype] of syncOwners) {
    const close = prototype.close;
    t.mock.method(prototype, "close", function (this: typeof prototype) {
      closes.push(name);
      close.call(this);
      if (name === "automation" && throwView) throw new Error("cleanup failure after real close");
    });
  }
  const asyncOwners: Array<[string, { close(): Promise<unknown> }]> = [
    ["subagents", SubagentTaskManager.prototype], ["agent", AgentSession.prototype],
    ["processes", ManagedProcessService.prototype], ["recorder", SessionRecorder.prototype],
    ["scope", RuntimeHostResourceScope.prototype]
  ];
  for (const [name, prototype] of asyncOwners) {
    const close = prototype.close;
    t.mock.method(prototype, "close", async function (this: typeof prototype) {
      closes.push(name);
      if (name === "agent" && failAgent) throw new Error("agent cleanup failed before recorder");
      return await close.call(this);
    });
  }
}

const views = ["automation", "graphs", "goals", "capabilities", "communication", "tasks", "authority"];
for (const throwView of [false, true]) {
  await test(`early managed-process initialization failure drains acquired owners (cleanup throws: ${throwView})`, async (t) => {
    const f = await fixture(t);
    const primary = new Error("managed-process initialization sentinel");
    observeCleanup(t, f.closes, throwView);
    t.mock.method(ManagedProcessService.prototype, "initialize", async function (this: ManagedProcessService) {
      f.manual.push(() => this.close());
      throw primary;
    });
    await assert.rejects(f.create(), (error) => error === primary);
    t.diagnostic(JSON.stringify({ phase: "managed-process initialization", throwView, closes: f.closes }));
    assert.deepEqual(f.closes, ["processes", "recorder", "scope", ...views]);
    f.assertDescriptorClosed();
  });
}

for (const failAgent of [false, true]) {
  await test(`agent initialization failure preserves recorder ownership (agent close fails: ${failAgent})`, async (t) => {
    const f = await fixture(t, true);
    const primary = new Error("agent initialization sentinel");
    observeCleanup(t, f.closes, false, failAgent);
    t.mock.method(AgentSession.prototype, "initialize", async function (this: AgentSession) {
      f.manual.push(() => this.close());
      throw primary;
    });
    await assert.rejects(f.create(), (error) => error === primary);
    t.diagnostic(JSON.stringify({ phase: "agent initialization", failAgent, closes: f.closes }));
    assert.deepEqual(f.closes, ["subagents", "agent", ...(failAgent ? ["processes", "recorder"] : ["recorder", "processes"]), "scope", ...views]);
    f.assertDescriptorClosed();
  });
}

for (const shared of [false, true]) {
  await test(`successful startup transfers ${shared ? "shared" : "private"} MCP ownership to runtime.close`, async (t) => {
    const f = await fixture(t);
    f.config.extensions.mcp.fixture = { enabled: true, type: "http", url: "https://ownership.invalid/mcp",
      transportProtocol: "streamable-http", timeoutMs: 2_000, args: [], stderr: "ignore" };
    // No Agent initialization, turns, providers, processes or optional background work.
    t.mock.method(AgentSession.prototype, "initialize", async () => undefined);
    const state = { starts: 0, closes: 0 };
    t.mock.method(StreamableHTTPClientTransport.prototype, "start", async () => { state.starts += 1; });
    t.mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
      if (!("method" in message) || !("id" in message)) return;
      assert.ok(message.method === "initialize" || message.method === "tools/list");
      this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
        ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [] } });
    });
    t.mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
      state.closes += 1;
      this.onclose?.();
    });
    const registry = shared ? new RuntimeHostResourceRegistry() : undefined;
    const retained = registry?.acquire(f.workspace, f.config);
    let runtime: CommandRuntime | undefined;
    try {
      runtime = await f.create(registry);
      assert.deepEqual(state, { starts: 1, closes: 0 });
      assert.equal(runtime.mcp.listServers()[0]?.connected, true);
      await runtime.close();
      runtime = undefined;
      f.assertDescriptorClosed();
      assert.equal(state.closes, shared ? 0 : 1);
      if (registry && retained) {
        assert.equal(retained.mcp.listServers()[0]?.connected, true);
        await registry.release(retained);
        assert.equal(state.closes, 1);
      }
    } finally {
      await runtime?.close();
      await registry?.close();
    }
  });
}
