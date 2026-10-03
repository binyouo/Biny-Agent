import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost, type RuntimeHostFactory } from "../src/runtime/RuntimeHost.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-goal-lifecycle-"));
const oldAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "state");
const modelStarted = deferred<void>();
const responses = new Set<ServerResponse>();
let goalRequests = 0;
const provider = createServer((request, response) => { void (async () => {
  let source = "";
  for await (const chunk of request) source += String(chunk);
  const body = JSON.parse(source) as { tools?: Array<{ function?: { name?: string } }> };
  if (body.tools?.some(tool => tool.function?.name === "GoalUpdate")) {
    goalRequests += 1;
    responses.add(response);
    response.once("close", () => responses.delete(response));
    modelStarted.resolve();
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { choices: [{ index: 0, delta: { content: JSON.stringify({ skillIds: [], tools: [] }) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""));
})().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }); });
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
const config = configSchema.parse({ ...defaultConfig,
  defaultModel: "local", toolModel: "local",
  providers: { test: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
  models: { local: { provider: "test", model: "local", capabilities: { tools: true, reasoning: false, streaming: true } } },
  permission: { ...defaultConfig.permission, mode: "auto" },
  thinking: { ...defaultConfig.thinking, enabled: false },
  chat: { ...defaultConfig.chat, defaultToolSelection: "all" },
  crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false }, skills: [] },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }
});
const factoryEntered = deferred<void>();
const factoryGate = deferred<void>();
const uncaught: Error[] = [];
const captureUncaught = (error: Error): void => { uncaught.push(error); };
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let ownerClient: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let restarting: Promise<unknown> | undefined;
process.on("uncaughtException", captureUncaught);
try {
  let primaryCreations = 0;
  const createRuntime: RuntimeHostFactory = async (sessionId, options) => {
    if (sessionId === "primary-session") {
      primaryCreations += 1;
      if (primaryCreations > 1) {
        factoryEntered.resolve();
        await factoryGate.promise;
      }
    }
    return await createInteractiveAgentHost(root, {
      ...options, sessionId,
      configStore: { load: async () => config, save: async () => undefined }
    });
  };
  host = await startRuntimeHost(root, async resources => await createRuntime("primary-session", { resourceRegistry: resources }), { createRuntime });
  client = await connectRuntimeHost(root);
  ownerClient = await connectRuntimeHost(root);
  await client.request("session.ensure", { sessionId: "other-session" });
  await ownerClient.request("session.ensure", { sessionId: "owned-session" });

  // Given the primary store has closed but its replacement factory is still pending,
  // When another session sets a Goal, Then scheduling must wait for the new authority owner.
  restarting = client.request("runtime.restart", { sessionId: "primary-session" });
  await bounded(factoryEntered.promise, "the replacement factory");
  const created = await client.request<{ accepted: boolean }>("session.goal.set", {
    sessionId: "other-session", objective: "Wait for a fresh user decision before completing the work."
  });
  assert.equal(created.accepted, true, JSON.stringify(created));
  // Goal ticks run at setImmediate; crossing that boundary observes an already-scheduled scan.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(uncaught.map(error => error.message), [], "A scheduled Goal tick cannot read the closed primary store during replacement.");
  assert.equal(goalRequests, 0, "The replacement window cannot admit new Goal work.");
  const owned = await ownerClient.request<{ accepted: boolean }>("session.goal.set", {
    sessionId: "owned-session", objective: "Continue only while this client owns the work."
  });
  assert.equal(owned.accepted, true, JSON.stringify(owned));
  const results = await Promise.allSettled([
    client.request<{ status: string }>("session.goal.get", { sessionId: "other-session" }),
    ownerClient.request("client.pause-owned-runs", {})
  ]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], "Resident-session Goal reads and owner exit must remain available while the primary store is closed.");
  assert.ok(results[0]!.status === "fulfilled");
  assert.equal(results[0]!.value.status, "active");
  assert.equal((await client.request<{ status: string }>("session.goal.get", { sessionId: "owned-session" })).status, "paused", "An owner exit must pause its Goal during primary replacement.");
  assert.equal((await client.request<{ status: string }>("session.goal.get", { sessionId: "other-session" })).status, "active", "Another client's Goal must remain eligible for the replacement wake.");

  factoryGate.resolve();
  await bounded(restarting, "the primary runtime restart");
  await bounded(modelStarted.promise, "Goal admission after replacement");
  assert.equal(goalRequests, 1, "Replacement completion must wake the Goal that was set while scheduling was suspended.");
  assert.deepEqual(uncaught.map(error => error.message), []);
  await client.request("session.goal.pause", { sessionId: "other-session" });
  await bounded(client.waitForIdle("other-session"), "the paused Goal run");
  assert.equal((await client.request<{ status: string }>("session.goal.get", { sessionId: "other-session" })).status, "paused");
} finally {
  factoryGate.resolve();
  await restarting?.catch(() => undefined);
  await ownerClient?.close();
  await client?.close();
  await host?.close();
  process.off("uncaughtException", captureUncaught);
  for (const response of responses) response.destroy();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("session goal Host lifecycle tests passed");
