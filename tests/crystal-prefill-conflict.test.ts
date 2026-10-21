/** Real Crystal HTTP/service/storage regressions; model replies are deterministic and never leave this process. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { handleCrystalHttpRequest, type CrystalHttpResponse } from "../src/agent/context/crystalHttp.js";
import { CrystalService } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { defaultCrystalConfig, type CrystalChecklist } from "../src/agent/context/crystalTypes.js";

interface PrefillResponse {
  checklist: CrystalChecklist;
  filled: string[];
}

interface Fixture {
  service: CrystalService;
  id: string;
  tag: string;
  request(method: string, action: string, body?: unknown): Promise<CrystalHttpResponse>;
  beginPrefill(): Promise<CrystalHttpResponse>;
  waitForModel(pending: Promise<CrystalHttpResponse>): Promise<void>;
  releaseModel(): void;
  modelCalls(): number;
}

await test("prefill preserves a saved conflict on an empty field and HTTP confirm remains blocked", async () => {
  await withFixture(async (fixture) => {
    const saved = await fixture.request("PUT", "checklist", {
      field: "definition", value: "", sources: ["user:manual"], conflict: true
    });
    assert.equal(saved.status, 200);
    const response = await fixture.beginPrefill();
    assertModelDefinition(response, fixture.tag);
    assert.equal((response.body as PrefillResponse).checklist.definition?.conflict, true);
    assert.deepEqual((response.body as PrefillResponse).filled, ["definition"]);
    await assertConflictBlocksConfirmation(fixture);
    assert.equal(fixture.modelCalls(), 1);
  });
});

await test("prefill preserves a conflict set through HTTP while the model is pending", async () => {
  await withFixture(async (fixture) => {
    const pending = fixture.beginPrefill();
    await fixture.waitForModel(pending);
    const saved = await fixture.request("PUT", "checklist", { field: "definition", conflict: true });
    assert.equal(saved.status, 200);
    assert.equal(fixture.service.detail(fixture.id)?.crystal.checklist.definition?.conflict, true);
    fixture.releaseModel();
    const response = await pending;
    assertModelDefinition(response, fixture.tag);
    assert.equal((response.body as PrefillResponse).checklist.definition?.conflict, true);
    await assertConflictBlocksConfirmation(fixture);
    assert.equal(fixture.modelCalls(), 1);
  }, true);
});

await test("prefill respects an explicit conflict clearance made while the model is pending", async () => {
  await withFixture(async (fixture) => {
    assert.equal((await fixture.request("PUT", "checklist", { field: "definition", conflict: true })).status, 200);
    const pending = fixture.beginPrefill();
    await fixture.waitForModel(pending);
    const cleared = await fixture.request("PUT", "checklist", { field: "definition", conflict: false });
    assert.equal(cleared.status, 200);
    fixture.releaseModel();
    const response = await pending;
    assertModelDefinition(response, fixture.tag);
    // The existing storage parser normalizes false to undefined. It must not restore the earlier true.
    assert.notEqual((response.body as PrefillResponse).checklist.definition?.conflict, true);
    assert.notEqual(fixture.service.detail(fixture.id)?.crystal.checklist.definition?.conflict, true);
    assert.deepEqual((await fixture.request("GET", "validate")).body, { ready: true, missing: [], conflicted: [] });
    assert.equal(fixture.service.detail(fixture.id)?.crystal.stage, "candidate");
    const confirmed = await fixture.request("POST", "confirm");
    assert.equal(confirmed.status, 200);
    assert.equal(fixture.service.detail(fixture.id)?.crystal.stage, "formal");
    assert.equal(fixture.modelCalls(), 1);
  }, true);
});

await test("prefill keeps an absent field unflagged and retains source filtering and duplicate order", async () => {
  await withFixture(async (fixture) => {
    assert.equal(fixture.service.detail(fixture.id)?.crystal.checklist.definition, undefined);
    const response = await fixture.beginPrefill();
    assertModelDefinition(response, fixture.tag);
    const definition = (response.body as PrefillResponse).checklist.definition!;
    assert.equal(Object.hasOwn(definition, "conflict"), false);
    assert.equal(fixture.service.detail(fixture.id)?.crystal.checklist.definition?.conflict, undefined);
    assert.deepEqual((await fixture.request("GET", "validate")).body, { ready: true, missing: [], conflicted: [] });
    assert.equal(fixture.service.detail(fixture.id)?.crystal.stage, "candidate");
    assert.equal(fixture.modelCalls(), 1);
  });
});

await test("prefill still leaves a nonempty manual edit and its conflict untouched", async () => {
  await withFixture(async (fixture) => {
    const pending = fixture.beginPrefill();
    await fixture.waitForModel(pending);
    const manual = { value: "Human reviewed definition", sources: ["user:manual"], conflict: true };
    assert.equal((await fixture.request("PUT", "checklist", { field: "definition", ...manual })).status, 200);
    fixture.releaseModel();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as PrefillResponse).checklist.definition, manual);
    assert.deepEqual(fixture.service.detail(fixture.id)?.crystal.checklist.definition, manual);
    await assertConflictBlocksConfirmation(fixture);
    assert.equal(fixture.modelCalls(), 1);
  }, true);
});

await test("prefill still discards a reply after the crystal type changes", async () => {
  await withFixture(async (fixture) => {
    const pending = fixture.beginPrefill();
    await fixture.waitForModel(pending);
    assert.equal((await fixture.request("POST", "type", { type: "entity" })).status, 200);
    const changed = fixture.service.detail(fixture.id)!.crystal;
    fixture.releaseModel();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as PrefillResponse).checklist, changed.checklist);
    assert.deepEqual(fixture.service.detail(fixture.id)!.crystal, changed);
    assert.equal(fixture.service.detail(fixture.id)?.crystal.checklist.definition, undefined);
    assert.equal(fixture.modelCalls(), 1);
  }, true);
});

await test("prefill still discards a reply after explicit manual confirmation", async () => {
  await withFixture(async (fixture) => {
    const pending = fixture.beginPrefill();
    await fixture.waitForModel(pending);
    assert.equal((await fixture.request("PUT", "checklist", {
      field: "definition", value: "Definition approved before the reply", sources: ["user:manual"], conflict: false
    })).status, 200);
    assert.equal((await fixture.request("POST", "confirm")).status, 200);
    const formal = fixture.service.detail(fixture.id)!.crystal;
    assert.equal(formal.stage, "formal");
    fixture.releaseModel();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as PrefillResponse).checklist, formal.checklist);
    assert.deepEqual(fixture.service.detail(fixture.id)!.crystal, formal);
    assert.equal(fixture.modelCalls(), 1);
  }, true);
});

function assertModelDefinition(response: CrystalHttpResponse, tag: string): void {
  assert.equal(response.status, 200);
  const item = (response.body as PrefillResponse).checklist.definition;
  assert.equal(item?.value, "Supported model definition");
  assert.deepEqual(item?.sources, [tag, tag]);
}

async function assertConflictBlocksConfirmation(fixture: Fixture): Promise<void> {
  const detail = fixture.service.detail(fixture.id)!;
  assert.equal(detail.crystal.checklist.definition?.conflict, true);
  assert.deepEqual(detail.validation, { ready: false, missing: [], conflicted: ["definition"] });
  const validation = await fixture.request("GET", "validate");
  assert.equal(validation.status, 200);
  assert.deepEqual(validation.body, detail.validation);
  const confirmed = await fixture.request("POST", "confirm");
  assert.equal(confirmed.status, 409);
  assert.deepEqual((confirmed.body as { validation: unknown }).validation, detail.validation);
  assert.equal(fixture.service.detail(fixture.id)?.crystal.stage, "candidate");
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, deferred = false): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-prefill-conflict-"));
  let enterModel!: () => void;
  let releaseModel!: () => void;
  const entered = new Promise<void>((resolve) => { enterModel = resolve; });
  const released = new Promise<void>((resolve) => { releaseModel = resolve; });
  if (!deferred) releaseModel();
  let calls = 0;
  let tag = "";
  let pending: Promise<CrystalHttpResponse> | undefined;
  const model: AgentModel = {
    provider: "test",
    modelId: "crystal-prefill-conflict",
    stream: async (request) => {
      calls += 1;
      enterModel();
      await released;
      assert.match(JSON.stringify(request.messages), /字段: definition/u);
      assert.ok(JSON.stringify(request.messages).includes(`[${tag}]`));
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "text-delta",
          text: JSON.stringify({
            definition: {
              value: "  Supported model definition  ",
              sources: [tag, "missing-source", tag, "user:manual"],
              conflict: false
            }
          })
        };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  let clockTick = 0;
  const service = new CrystalService({
    storage: new CrystalStorage({ agentDir: directory }),
    getModel: () => model,
    now: () => new Date(Date.UTC(2026, 9, 18) + clockTick++)
  });
  try {
    await service.initialize();
    const crystal = service.createSeed("Conflict preservation");
    service.setType(crystal.id, "concept");
    service.addMaterial(crystal.id, "note", { text: "A cited definition supported by this note." });
    tag = `note:${service.storage.listMaterials(crystal.id)[0]!.id}`;
    for (const field of ["includes", "excludes", "examples", "source"]) {
      service.updateChecklist(crystal.id, field, { value: `Reviewed ${field}`, sources: ["user:manual"] });
    }
    const request = async (method: string, action: string, body: unknown = {}): Promise<CrystalHttpResponse> => {
      const response = await handleCrystalHttpRequest({ method, pathname: `/api/crystal/${crystal.id}/${action}`, body }, {
        service, getConfig: () => defaultCrystalConfig
      });
      assert.ok(response);
      return response;
    };
    await run({
      service,
      id: crystal.id,
      tag,
      request,
      beginPrefill: () => {
        assert.equal(pending, undefined, "each fixture starts exactly one prefill");
        pending = request("POST", "prefill");
        return pending;
      },
      waitForModel: async (operation) => {
        await Promise.race([
          entered,
          operation.then(() => { throw new Error("Prefill completed before the model entry barrier."); })
        ]);
      },
      releaseModel,
      modelCalls: () => calls
    });
  } finally {
    releaseModel();
    try {
      await pending;
    } finally {
      service.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
