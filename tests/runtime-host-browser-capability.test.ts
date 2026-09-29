import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { connectRuntimeHost, spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { isProcessAlive, terminateSpawnedHost } from "../src/runtime/host/lifecycle.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-browser-capability-"));
const configDir = path.join(root, "config");
await saveConfig(root, {
  ...structuredClone(defaultConfig),
  defaultModel: "local-test",
  web: { ...defaultConfig.web, fetch: { ...defaultConfig.web.fetch, enabled: true } },
  providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
  models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
}, { globalDir: configDir });

let owner: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
let desktop: Awaited<ReturnType<typeof connectRuntimeHost>>;
let observer: Awaited<ReturnType<typeof connectRuntimeHost>>;
const endpoint = { endpoint: "/tmp/biny-test-browser.sock", token: "browser-test-token", projectId: "project-1" };
try {
  owner = await spawnRuntimeHost(root, {
    workspaceRoot: root,
    configDir,
    lifecycleMode: "service",
    surface: "desktop",
    browserAutomation: endpoint
  });
  desktop = owner.client;
  assert.ok(desktop.hostInfo?.capabilities.includes("browser.automation.lease"));
  assert.ok((await desktop.listTools()).some((tool) => tool.name === "BrowserOpen"), "private IPC bootstrap should attach the initial browser capability");

  assert.equal(await desktop.setBrowserAutomation(endpoint), true);
  const attachedTools = await desktop.listTools();
  assert.ok(attachedTools.some((tool) => tool.name === "BrowserOpen"));
  assert.ok(attachedTools.some((tool) => tool.name === "WebSearch"));

  assert.equal(await desktop.setBrowserAutomation(undefined), true);
  const explicitlyDetachedTools = await desktop.listTools();
  assert.ok(!explicitlyDetachedTools.some((tool) => tool.name.startsWith("Browser")));
  assert.ok(!explicitlyDetachedTools.some((tool) => tool.name === "WebSearch"));
  assert.equal(await desktop.setBrowserAutomation(endpoint), true);

  await desktop.close();
  desktop = undefined;
  observer = await connectRuntimeHost(root, { configDir, clientId: "observer", surface: "tui" });
  assert.ok(observer);
  await assert.rejects(observer.setBrowserAutomation(endpoint), /Only a Desktop client/u);
  const detachedTools = await waitFor(async () => {
    const tools = await observer!.listTools();
    return tools.some((tool) => tool.name.startsWith("Browser")) || tools.some((tool) => tool.name === "WebSearch")
      ? undefined
      : tools;
  });
  assert.ok(!detachedTools.some((tool) => tool.name.startsWith("Browser")), "a disconnected Desktop must remove its browser tools from the Host");
  assert.ok(!detachedTools.some((tool) => tool.name === "WebSearch"));
  assert.ok(detachedTools.some((tool) => tool.name === "WebFetch"), "detaching Desktop must preserve direct HTTP fetching");

  const reattached = await connectRuntimeHost(root, { configDir, clientId: "desktop-reopened", surface: "desktop" });
  assert.ok(reattached);
  assert.equal(await reattached.setBrowserAutomation(endpoint), true);
  assert.ok((await reattached.listTools()).some((tool) => tool.name === "BrowserOpen"));

  owner.process.disconnect();
  const afterParentExit = await waitFor(async () => {
    const tools = await reattached.listTools();
    return tools.some((tool) => tool.name.startsWith("Browser")) || tools.some((tool) => tool.name === "WebSearch")
      ? undefined
      : tools;
  });
  assert.ok(isProcessAlive(owner.process.pid!), "a service Host must outlive the spawning Desktop process");
  assert.ok(!afterParentExit.some((tool) => tool.name.startsWith("Browser")));
  assert.ok(!afterParentExit.some((tool) => tool.name === "WebSearch"));

  await reattached.close();
  console.log("runtime host browser capability tests passed");
} finally {
  await desktop?.close().catch(() => undefined);
  await observer?.close().catch(() => undefined);
  if (owner) await terminateSpawnedHost(owner.process);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 2_000;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    value = await read();
    if (value === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.notEqual(value, undefined, "timed out waiting for Host browser capability update");
  return value;
}
