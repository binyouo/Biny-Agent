import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { forkSession } from "../src/session/fork.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { getSessionCatalogItem, updateSessionCatalogMetadata } from "../src/session/catalog.js";

test("model directory and configured profiles preserve explicit priority tier support", () => {
  const [entry] = parseModelCatalog({ data: [{ id: "routed-model", service_tiers: ["priority", "default"] }] }, "gateway", "openai-compatible");
  assert.deepEqual(entry?.capabilities.serviceTiers, ["priority"]);

  const config = configSchema.parse({
    ...structuredClone(defaultConfig),
    providers: {
      gateway: {
        type: "openai-compatible",
        baseUrl: "https://gateway.invalid/v1",
        requiresApiKey: false,
        modelProfiles: { "routed-model": { capabilities: { serviceTiers: ["priority"] } } }
      }
    },
    models: { selected: { provider: "gateway", model: "routed-model" } },
    defaultModel: "selected"
  });
  const manager = new ModelManager(process.cwd(), config);
  assert.deepEqual(manager.getCapabilities().serviceTiers, ["priority"]);
});

test("priority tier reaches an OpenAI compatible request only through its provider namespace", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const vercelModel = createVercelLanguageModel({
    providerAlias: "gateway",
    providerType: "openai-compatible",
    authMode: "api-key",
    api: "chat_completions",
    modelId: "routed-model",
    supportsReasoning: false,
    baseUrl: "https://gateway.invalid/v1",
    apiKey: "fixture-key",
    headers: {},
    fetcher: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    }
  });
  const model = { provider: "openai-compatible", providerAlias: "gateway", modelId: "routed-model", serviceTiers: ["priority" as const] };
  for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content: "hello" }], tools: [] }, {
    model,
    vercelModel,
    tools: [],
    maxSteps: 1,
    modelOptions: { serviceTier: "priority" }
  })) assert.notEqual(event.type, "error", JSON.stringify(event));

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.service_tier, "priority");
});

test("fast mode metadata persists with session branches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-fast-mode-"));
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "fast mode" });
    recorder.record({ type: "assistant_message", content: "saved" });
    await recorder.close();

    await updateSessionCatalogMetadata(root, recorder.sessionId, { fastMode: true });
    assert.equal((await getSessionCatalogItem(root, recorder.sessionId))?.fastMode, true);

    const branch = await forkSession(root, recorder.sessionId);
    assert.equal((await getSessionCatalogItem(root, branch.sessionId))?.fastMode, true);
    await updateSessionCatalogMetadata(root, branch.sessionId, { fastMode: false });
    assert.equal((await getSessionCatalogItem(root, branch.sessionId))?.fastMode, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
