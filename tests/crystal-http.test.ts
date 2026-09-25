import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { handleActivityHttpRequest, startActivityHttpServer } from "../src/activity/httpServer.js";
import { CrystalService } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import type { CrystalHttpDependencies } from "../src/agent/context/crystalHttp.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { CrystalConfig } from "../src/agent/context/crystalTypes.js";

await testCrystalHttpLifecycle();

async function testCrystalHttpLifecycle(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-http-"));
  const storage = new CrystalStorage({ agentDir: root });
  let config: CrystalConfig = {
    passiveEnabled: true,
    semanticScanEnabled: false,
    contour: { count: 4, turns: 3, spread: 2 },
    nucleus: { count: 8, turns: 5, spread: 2 },
    dormantDays: 14
  };
  let model: AgentModel | undefined;
  const service = new CrystalService({
    storage,
    getConfig: () => config,
    getModel: () => model,
    readAnchorText: async ({ threadId, anchorId }) => (
      threadId === "thread-http" && anchorId === "turn-1" ? "Turn evidence from the session." : undefined
    )
  });
  await service.initialize();
  const crystal = {
    service,
    getConfig: () => config,
    setConfig: (next: CrystalConfig): void => { config = next; }
  };

  try {
    const overview = await request({ method: "GET", pathname: "/api/crystal/overview" }, crystal);
    assert.equal(overview.status, 200);
    assert.deepEqual((overview.body as { slots: unknown[]; slotCapacity: number }).slots, []);
    assert.equal((overview.body as { slotCapacity: number }).slotCapacity, 3);

    const configResponse = await request({
      method: "PUT",
      pathname: "/api/crystal/config",
      body: { passiveEnabled: false, contour: { count: 2, turns: 2, spread: 1 }, nucleus: { count: 3, turns: 3, spread: 1 }, dormantDays: 30 }
    }, crystal);
    assert.equal(configResponse.status, 200);
    assert.equal((configResponse.body as { config: CrystalConfig }).config.passiveEnabled, false);
    assert.equal(config.dormantDays, 30);

    const bundleResponse = await request({
      method: "POST",
      pathname: "/api/crystal/bundles",
      body: { threadId: "thread-http", anchorIds: ["turn-1", 2], name: "Release notes" }
    }, crystal);
    assert.equal(bundleResponse.status, 200);
    const bundleId = (bundleResponse.body as { id: string }).id;
    assert.ok(bundleId);
    const bundles = await request({
      method: "GET",
      pathname: "/api/crystal/bundles",
      searchParams: new URLSearchParams("threadId=thread-http")
    }, crystal);
    assert.equal(bundles.status, 200);
    assert.equal((bundles.body as Array<{ id: string }>)[0]?.id, bundleId);

    const seedResponse = await request({
      method: "POST",
      pathname: "/api/crystal/seeds",
      body: { name: "Release Theme", threadId: "thread-http", bundleIds: [bundleId], anchorIds: ["turn-1"] }
    }, crystal);
    assert.equal(seedResponse.status, 200);
    const seedId = (seedResponse.body as { id: string; slot?: number }).id;
    assert.equal((seedResponse.body as { slot?: number }).slot, 1);

    const detail = await request({ method: "GET", pathname: `/api/crystal/${seedId}` }, crystal);
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { materials: unknown[] }).materials.length, 2);

    const typeResponse = await request({ method: "POST", pathname: `/api/crystal/${seedId}/type`, body: { type: "concept" } }, crystal);
    assert.equal(typeResponse.status, 200);
    assert.equal((typeResponse.body as { type: string }).type, "concept");
    const checklistResponse = await request({
      method: "PUT",
      pathname: `/api/crystal/${seedId}/checklist`,
      body: { field: "definition", value: "A release focus", sources: ["note:pending"] }
    }, crystal);
    assert.equal(checklistResponse.status, 200);
    assert.equal((checklistResponse.body as { checklist: Record<string, { value: string }> }).checklist.definition?.value, "A release focus");
    const unavailablePrefill = await request({ method: "POST", pathname: `/api/crystal/${seedId}/prefill`, body: {} }, crystal);
    assert.equal(unavailablePrefill.status, 503);

    const materialResponse = await request({
      method: "POST",
      pathname: `/api/crystal/${seedId}/material`,
      body: { kind: "note", ref: { text: "Release Theme is the focus for this release." } }
    }, crystal);
    assert.deepEqual(materialResponse.body, { added: true });
    const materialId = service.storage.listMaterials(seedId).find((material) => material.kind === "note")?.id;
    assert.ok(materialId);

    model = prefillModel(() => `note:${String(materialId)}`, "Turn evidence from the session.");
    const prefillResponse = await request({ method: "POST", pathname: `/api/crystal/${seedId}/prefill`, body: {} }, crystal);
    assert.equal(prefillResponse.status, 200);
    assert.deepEqual((prefillResponse.body as { filled: string[] }).filled, ["includes", "excludes", "examples", "source"]);

    const validateResponse = await request({ method: "GET", pathname: `/api/crystal/${seedId}/validate` }, crystal);
    assert.deepEqual(validateResponse.body, { ready: true, missing: [], conflicted: [] });
    const confirmResponse = await request({ method: "POST", pathname: `/api/crystal/${seedId}/confirm`, body: {} }, crystal);
    assert.equal((confirmResponse.body as { stage: string }).stage, "formal");

    const secondSeed = service.createSeed("Dormant Theme");
    const slotResponse = await request({ method: "POST", pathname: `/api/crystal/${secondSeed.id}/slot`, body: { slot: null } }, crystal);
    assert.equal((slotResponse.body as { dormant: boolean }).dormant, true);
    const dormantResponse = await request({ method: "POST", pathname: `/api/crystal/${secondSeed.id}/dormant`, body: { dormant: false } }, crystal);
    assert.equal((dormantResponse.body as { dormant: boolean }).dormant, false);
    const cancelResponse = await request({ method: "POST", pathname: `/api/crystal/${secondSeed.id}/cancel`, body: { keepObserving: false } }, crystal);
    assert.equal((cancelResponse.body as { dormant: boolean }).dormant, true);

    const missing = await request({ method: "GET", pathname: "/api/crystal/missing" }, crystal);
    assert.equal(missing.status, 404);

    const api = await startActivityHttpServer({
      loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
      crystal
    }, { token: "crystal-http-test-token" });
    try {
      const response = await fetch(`http://${api.host}:${String(api.port)}/api/crystal/seeds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer crystal-http-test-token" },
        body: JSON.stringify({ name: "Loopback Theme" })
      });
      assert.equal(response.status, 200);
      const loopbackSeed = await response.json() as { id: string };
      assert.ok(loopbackSeed.id);
      const invalid = await fetch(`http://${api.host}:${String(api.port)}/api/crystal/seeds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer crystal-http-test-token" },
        body: "not-json"
      });
      assert.equal(invalid.status, 400);
    } finally {
      await api.close();
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function request(
  request: { method: string; pathname: string; searchParams?: URLSearchParams; body?: unknown },
  crystal: CrystalHttpDependencies
): Promise<{ status: number; body: unknown }> {
  return await handleActivityHttpRequest(request, {
    loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: "/tmp/biny-crystal-http" }),
    crystal
  });
}

function prefillModel(source: () => string, expectedMaterial?: string): AgentModel {
  return {
    provider: "test",
    modelId: "crystal-http-prefill",
    stream: async (request, _options) => (async function* (): AsyncGenerator<ModelStreamEvent> {
      if (expectedMaterial) assert.match(JSON.stringify(request.messages), new RegExp(expectedMaterial, "u"));
      const tag = source();
      yield {
        type: "text-delta",
        text: JSON.stringify({
          definition: { value: "A release focus", sources: [tag] },
          includes: { value: "Release planning", sources: [tag] },
          excludes: { value: "Unrelated work", sources: [tag] },
          examples: { value: "Release Theme", sources: [tag] },
          source: { value: "Project note", sources: [tag] }
        })
      };
      yield { type: "finish", reason: "stop" };
    })()
  };
}
