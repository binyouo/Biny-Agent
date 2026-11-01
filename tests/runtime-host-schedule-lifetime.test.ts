import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost, connectRuntimeHost, spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { isProcessAlive, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";
import { discoverMemoryOwner } from "../src/runtime/memory/transport.js";
import { readyHostClient } from "./helpers/readyHostClient.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("scheduled heartbeat does not keep a Host after its last client exits", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-schedule-exit-"));
  const configDir = path.join(root, "config");
  const config = structuredClone(defaultConfig);
  config.heartbeat.enabled = true;
  config.context.memory.enabled = false;
  config.defaultModel = "local-test";
  config.providers = { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } };
  await saveConfig(root, config, { globalDir: configDir });
  const local = await createInteractiveAgentHost(root, { configStore: createFileConfigStore(root, { globalDir: configDir }) });
  const server = await startRuntimeHost(root, async () => local, { createRuntime: async () => { throw new Error("unexpected session"); }, configDir });
  const client = await readyHostClient(await connectRuntimeHost(root, { clientId: "desktop", surface: "desktop", configDir }));
  try {
    assert.ok(client);
    assert.equal((await client.heartbeatStatus() as { enabled: boolean }).enabled, true);
    assert.equal(await server.retireIfIdle(0), false, "connected clients retain scheduled work");
    await client.close();
    const deadline = Date.now() + 2_000;
    let retired = false;
    while (!retired && Date.now() < deadline) {
      retired = await server.retireIfIdle(0);
      if (!retired) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(retired, true, "enabled heartbeat must not retain the Host after the last client exits");
  } finally {
    await client?.close();
    await server.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
});

test("detached Host and its memory owner exit after the last client", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-process-schedule-exit-"));
  const configDir = path.join(root, "config");
  const agentDir = path.join(root, "agent");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = agentDir;
  const config = structuredClone(defaultConfig);
  config.heartbeat.enabled = true;
  config.context.memory.enabled = false;
  config.defaultModel = "local-test";
  config.providers = { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } };
  let host: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
  let other: Awaited<ReturnType<typeof connectRuntimeHost>>;
  try {
    await saveConfig(root, config, { globalDir: configDir });
    host = await readyHostClient(await spawnRuntimeHost(root, { workspaceRoot: root, configDir, idleGraceMs: 200 }));
    other = await readyHostClient(await connectRuntimeHost(root, { configDir, clientId: "second", surface: "tui" }));
    assert.ok(other);
    const ownerDeadline = Date.now() + 10_000;
    let owner = await discoverMemoryOwner(agentDir, configDir, false);
    while (!owner && Date.now() < ownerDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      owner = await discoverMemoryOwner(agentDir, configDir, false);
    }
    assert.ok(owner, "the running Host must attach to the shared memory owner");
    await host.client.close();
    assert.equal(isProcessAlive(host.process.pid!), true);
    assert.equal((await other.heartbeatStatus() as { enabled: boolean }).enabled, true);
    await other.close();
    const deadline = Date.now() + 8_000;
    while (isProcessAlive(host.process.pid!) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(isProcessAlive(host.process.pid!), false);
    const memoryDeadline = Date.now() + 40_000;
    while (isProcessAlive(owner.pid) && Date.now() < memoryDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(isProcessAlive(owner.pid), false, "the memory owner must exit after the Host disconnects");
  } finally {
    try {
      await other?.close();
      await host?.client.close();
      if (host) await terminateSpawnedHost(host.process);
      await removeTestRoot(root, { recursive: true, force: true });
    } finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
    }
  }
});
