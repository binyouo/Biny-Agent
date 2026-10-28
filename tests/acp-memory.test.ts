import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { canonicalMemoryRoot, serveMemoryOwner } from "../src/runtime/memory/transport.js";
import { globalAgentDir, globalConfigDir } from "../src/config/paths.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";

test("ACP recalls persisted shared memory, excludes foreign and disabled Activity facts, and respects the memory switch", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-memory-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/acp-embedding\.invalid\/v1\/embeddings$/u);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "fixture-embed");
    return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0, 0] })) });
  };
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } },
      embeddings: { type: "openai-compatible", baseUrl: "https://acp-embedding.invalid/v1", requiresApiKey: false,
        embeddingModels: [{ id: "fixture-embed", displayName: "Fixture", dimensions: 3, recommendedThreshold: 0.2 }] } },
    models: { external: { provider: "external", model: "default" } }, activity: { ...defaultConfig.activity, enabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: true, generateMemories: false,
      embeddingModel: { kind: "provider", provider: "embeddings", model: "fixture-embed" }, maxRecalled: 10 } } });
  await ensureAgentDirs(root);
  const memoryRoot = await canonicalMemoryRoot(globalAgentDir());
  const owner = await serveMemoryOwner(memoryRoot, globalConfigDir(), new AgentMemoryOwner(memoryRoot, { load: async () => config, save: async () => undefined }));
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager(), toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
  try {
    await agent.initialize();
    const memory = agent.getLocalMemory();
    await memory.writeEntry({ content: "shared-fixture preference", source: "manual" });
    await memory.writeEntry({ content: "foreign-fixture private preference", source: "manual", userId: "another-user" });
    await memory.writeEntry({ content: "activity-fixture preference", source: "manual", activitySessionId: "activity-session" });
    assert.equal((await agent.runTask("fixture preference")).status, "completed");
    const initialRequests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(initialRequests.find((request) => request.method === "session/prompt").params.prompt,
      [{ type: "text", text: "fixture preference" }], "new connections must not inherit permission to receive memory");
    Object.assign(config.providers.external!.acp!, { allowMemory: true });
    assert.equal((await agent.runTask("fixture preference authorized")).status, "completed");
    config.context.memory.useMemories = false;
    assert.equal((await agent.runTask("fixture preference again")).status, "completed");
    const requests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const prompts = requests.filter((request) => request.method === "session/prompt");
    assert.deepEqual(prompts[0].params.prompt, [{ type: "text", text: "fixture preference" }], "new connections must not inherit permission to receive memory");
    const first = JSON.stringify(prompts[1].params.prompt);
    assert.match(first, /shared-fixture/u);
    assert.doesNotMatch(first, /foreign-fixture|activity-fixture/u);
    assert.deepEqual(prompts[2].params.prompt, [{ type: "text", text: "fixture preference again" }]);
  } finally { await agent.close(); await owner.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
