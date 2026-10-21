/** Public Crystal HTTP/service/storage behavior with isolated real storage and no model calls. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleCrystalHttpRequest, type CrystalHttpResponse } from "../src/agent/context/crystalHttp.js";
import { CrystalService, type CrystalDetail, type CrystalServiceEvent } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { defaultCrystalConfig, type Crystal, type CrystalMaterial, type CrystalMaterialKind } from "../src/agent/context/crystalTypes.js";

interface DetailResponse extends Crystal {
  materials: CrystalMaterial[];
  related: CrystalDetail["related"];
}

interface Fixture {
  service: CrystalService;
  storage: CrystalStorage;
  observer: CrystalStorage;
  events: CrystalServiceEvent[];
  request(method: string, pathname: string, body?: unknown): Promise<CrystalHttpResponse>;
  seed(name: string, materials?: { threadId?: string; anchorIds?: string[]; bundleIds?: string[] }): Promise<string>;
  add(id: string, kind: CrystalMaterialKind, ref: unknown): Promise<boolean>;
  detail(id: string): Promise<DetailResponse>;
  reopen(): Promise<void>;
}

const forward = { threadId: "thread-one", anchorId: "anchor-one" };
const reverse = { anchorId: "anchor-one", threadId: "thread-one" };

for (const [label, first, repeated] of [
  ["thread first", forward, reverse],
  ["anchor first", reverse, forward]
] as const) {
  await test(`HTTP material attachment is idempotent with ${label}`, async () => {
    await withFixture(async (f) => {
      const id = await f.seed("Reference identity");
      assert.equal(await f.add(id, "turn", first), true);
      const before = f.observer.getCrystal(id);
      const materials = f.observer.listMaterials(id);
      assert.equal(materials.length, 1);
      assert.equal(JSON.stringify(materials[0]!.ref), JSON.stringify(first), "retain the original reference representation");
      assert.equal(f.events.filter((event) => event.type === "material_added").length, 1);

      assert.equal(await f.add(id, "turn", repeated), false);
      assert.deepEqual(f.observer.listMaterials(id), materials);
      assert.deepEqual(f.observer.getCrystal(id), before, "a duplicate must not change timestamps or notification state");
      assert.equal(f.events.filter((event) => event.type === "material_added").length, 1);
      assert.equal((await f.detail(id)).materials.length, 1);

      await f.reopen();
      assert.equal(await f.add(id, "turn", repeated), false);
      assert.deepEqual(f.observer.listMaterials(id), materials);
      assert.deepEqual(f.observer.getCrystal(id), before);
    });
  });
}

for (const kind of ["turn", "bundle", "note"] as const) {
  await test(`HTTP ${kind} references compare all nested JSON keys without changing their values`, async () => {
    await withFixture(async (f) => {
      const id = await f.seed(`Nested ${kind}`);
      const first = {
        threadId: "thread-nested", anchorId: "anchor-nested", bundleId: "bundle-nested", text: "Evidence",
        metadata: { z: null, a: { second: false, first: "value" } },
        sequence: [{ y: 2, x: 1 }, "tail"]
      };
      const repeated = {
        sequence: [{ x: 1, y: 2 }, "tail"],
        metadata: { a: { first: "value", second: false }, z: null },
        text: "Evidence", bundleId: "bundle-nested", anchorId: "anchor-nested", threadId: "thread-nested"
      };
      assert.equal(await f.add(id, kind, first), true);
      const before = f.observer.listMaterials(id);
      assert.equal(await f.add(id, kind, repeated), false);
      assert.deepEqual(f.observer.listMaterials(id), before);
      assert.equal(JSON.stringify(before[0]!.ref), JSON.stringify(first));
      assert.equal((await f.detail(id)).materials.length, 1);
    });
  });
}

await test("HTTP seed batch associations and later attachments share reference identity", async () => {
  await withFixture(async (f) => {
    const bundle = await f.request("POST", "/api/crystal/bundles", { threadId: forward.threadId, anchorIds: [forward.anchorId] });
    assert.equal(bundle.status, 200);
    const bundleId = (bundle.body as { id: string }).id;
    const id = await f.seed("Batch references", {
      threadId: forward.threadId,
      anchorIds: [forward.anchorId, forward.anchorId],
      bundleIds: [bundleId, bundleId]
    });
    const before = f.observer.listMaterials(id);
    assert.equal(before.length, 2);
    assert.equal(await f.add(id, "turn", reverse), false);
    assert.equal(await f.add(id, "bundle", { bundleId }), false);
    assert.deepEqual(f.observer.listMaterials(id), before);
    assert.equal((await f.detail(id)).materials.length, 2);
  });
});

await test("HTTP attachment recognizes a restored reverse-order reference after storage reopens", async () => {
  await withFixture(async (f) => {
    const id = await f.seed("Legacy reference");
    const legacy: CrystalMaterial = {
      id: 7001, crystalId: id, kind: "turn", ref: reverse, source: "auto", createdAt: "2025-01-02T03:04:05.000Z"
    };
    assert.equal(f.storage.importMaterial(legacy), true);
    const before = f.observer.getCrystal(id);
    await f.reopen();
    assert.equal(await f.add(id, "turn", forward), false);
    assert.deepEqual(f.observer.listMaterials(id), [legacy]);
    assert.deepEqual(f.observer.getCrystal(id), before);
    assert.deepEqual(f.events, []);
    assert.deepEqual((await f.detail(id)).materials, [legacy]);
  });
});

await test("HTTP details report a shared reference in both directions despite object key order", async () => {
  await withFixture(async (f) => {
    const left = await f.seed("Left reference");
    const right = await f.seed("Right reference");
    assert.equal(await f.add(left, "turn", forward), true);
    assert.equal(await f.add(right, "turn", reverse), true);
    assert.equal((await f.detail(left)).related.find((entry) => entry.id === right)?.shared, 1);
    assert.equal((await f.detail(right)).related.find((entry) => entry.id === left)?.shared, 1);
    assert.equal(f.observer.listMaterials(left).length, 1);
    assert.equal(f.observer.listMaterials(right).length, 1);
  });
});

await test("legacy duplicate record IDs remain intact while HTTP shared counts use distinct references", async () => {
  await withFixture(async (f) => {
    const left = await f.seed("Legacy left");
    const right = await f.seed("Legacy right");
    const timestamp = "2025-02-03T04:05:06.000Z";
    for (const material of [
      { id: 7101, crystalId: left, ref: forward },
      { id: 7102, crystalId: left, ref: reverse },
      { id: 7103, crystalId: right, ref: forward }
    ]) {
      assert.equal(f.storage.importMaterial({ ...material, kind: "turn", source: "user", createdAt: timestamp }), true);
    }
    const leftRows = f.observer.listMaterials(left);
    assert.equal((await f.detail(left)).related.find((entry) => entry.id === right)?.shared, 1);
    assert.equal((await f.detail(right)).related.find((entry) => entry.id === left)?.shared, 1);
    assert.equal(f.storage.importMaterial({ id: 7104, crystalId: right, kind: "turn", ref: reverse, source: "user", createdAt: timestamp }), true);
    const rightRows = f.observer.listMaterials(right);
    assert.equal((await f.detail(left)).related.find((entry) => entry.id === right)?.shared, 1);
    assert.equal((await f.detail(right)).related.find((entry) => entry.id === left)?.shared, 1);
    assert.equal(await f.add(left, "turn", reverse), false);
    await f.reopen();
    assert.deepEqual(f.observer.listMaterials(left), leftRows);
    assert.deepEqual(f.observer.listMaterials(right), rightRows);
    assert.deepEqual(leftRows.map((material) => material.id).sort((a, b) => a - b), [7101, 7102]);
    assert.deepEqual(rightRows.map((material) => material.id).sort((a, b) => a - b), [7103, 7104]);
    assert.equal((await f.detail(left)).materials.length, 2, "historical records are not deleted or rewritten");
    assert.equal((await f.detail(right)).related.find((entry) => entry.id === left)?.shared, 1);
  });
});

await test("HTTP identity keeps kind, extra fields, array order, JSON types and prototype-named keys distinct", async () => {
  await withFixture(async (f) => {
    const id = await f.seed("Identity distinctions");
    const variants: Array<{ kind: CrystalMaterialKind; ref: unknown }> = [
      { kind: "turn", ref: forward },
      { kind: "turn", ref: { ...forward, threadId: "another-thread" } },
      { kind: "turn", ref: { ...forward, anchorId: "another-anchor" } },
      { kind: "bundle", ref: forward },
      { kind: "note", ref: forward },
      { kind: "turn", ref: { ...forward, source: "activity" } },
      { kind: "turn", ref: { ...forward, source: "conversation" } },
      { kind: "turn", ref: { ...forward, extra: null } },
      { kind: "turn", ref: { ...forward, extra: "null" } },
      { kind: "turn", ref: { ...forward, extra: { sequence: [1, 2] } } },
      { kind: "turn", ref: { ...forward, extra: { sequence: [2, 1] } } },
      { kind: "turn", ref: { ...forward, extra: { sequence: ["1", 2] } } },
      { kind: "turn", ref: { ...forward, extra: { sequence: [1, 2, 2] } } },
      { kind: "turn", ref: { ...forward, extra: {} } },
      { kind: "turn", ref: { ...forward, extra: [] } },
      { kind: "turn", ref: JSON.parse('{"threadId":"thread-one","anchorId":"anchor-one","__proto__":{"source":"activity"}}') as unknown }
    ];
    for (const { kind, ref } of variants) assert.equal(await f.add(id, kind, ref), true);
    assert.equal((await f.detail(id)).materials.length, variants.length);
    const saved = f.observer.listMaterials(id);
    assert.equal(saved.length, variants.length);
    assert.equal(Object.hasOwn(saved.at(-1)!.ref as object, "__proto__"), true);
    for (const [index, variant] of variants.entries()) {
      assert.equal(saved[index]?.kind, variant.kind);
      assert.equal(JSON.stringify(saved[index]?.ref), JSON.stringify(variant.ref));
    }
  });
});

await test("storage compares the exact JSON representation obtained from one serialization", async () => {
  await withFixture(async (f) => {
    const id = await f.seed("JSON representation");
    let serializations = 0;
    const ref = {
      toJSON: () => {
        serializations += 1;
        return { text: "Evidence", omitted: undefined, nonFinite: Number.NaN, time: new Date("2025-04-05T06:07:08.000Z") };
      }
    };
    assert.equal(f.storage.addMaterial(id, "note", ref, "user"), true);
    assert.equal(serializations, 1);
    const before = f.observer.listMaterials(id);
    assert.deepEqual(before[0]!.ref, { text: "Evidence", nonFinite: null, time: "2025-04-05T06:07:08.000Z" });
    assert.equal(await f.add(id, "note", { time: "2025-04-05T06:07:08.000Z", nonFinite: null, text: "Evidence" }), false);
    assert.equal(serializations, 1);
    assert.deepEqual(f.observer.listMaterials(id), before);
  });
});

await test("storage keeps JSON serialization failures and leaves the next attachment usable", async () => {
  await withFixture(async (f) => {
    const id = await f.seed("Invalid serialization");
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    assert.throws(() => f.storage.addMaterial(id, "note", cycle, "user"), TypeError);
    assert.throws(() => f.storage.addMaterial(id, "note", { value: 1n }, "user"), TypeError);
    assert.throws(() => f.storage.addMaterial(id, "note", undefined, "user"));
    assert.deepEqual(f.observer.listMaterials(id), []);
    assert.equal(await f.add(id, "note", { text: "Still usable" }), true);
    assert.equal(f.observer.listMaterials(id).length, 1);
  });
});

await test("reference deduplication participates in the caller's transaction and rolls back with it", async () => {
  await withFixture(async (f) => {
    const id = await f.seed("Transactional attachment");
    const rollback = new Error("Roll back the enclosing operation");
    assert.throws(() => f.storage.transaction(() => {
      assert.equal(f.storage.addMaterial(id, "turn", forward, "user"), true);
      assert.equal(f.storage.addMaterial(id, "turn", reverse, "auto"), false);
      assert.equal(f.storage.listMaterials(id).length, 1);
      throw rollback;
    }), (error: unknown) => error === rollback);
    assert.deepEqual(f.observer.listMaterials(id), []);
    assert.equal(await f.add(id, "turn", reverse), true);
    assert.equal(await f.add(id, "turn", forward), false);
    assert.equal(f.observer.listMaterials(id).length, 1);
  });
});

await test("exact material-ID restoration retains its existing reference and metadata conflict contract", async () => {
  await withFixture(async (f) => {
    const id = await f.seed("Import contract");
    const material: CrystalMaterial = {
      id: 7201, crystalId: id, kind: "turn", ref: forward, source: "user", createdAt: "2025-03-04T05:06:07.000Z"
    };
    assert.equal(f.storage.importMaterial(material), true);
    assert.equal(f.storage.importMaterial(material), false);
    assert.throws(() => f.storage.importMaterial({ ...material, ref: reverse }), /id conflicts/u);
    assert.throws(() => f.storage.importMaterial({ ...material, ref: { ...forward, extra: true } }), /id conflicts/u);
    assert.throws(() => f.storage.importMaterial({ ...material, source: "auto" }), /id conflicts/u);
    assert.throws(() => f.storage.importMaterial({ ...material, createdAt: "2025-03-05T05:06:07.000Z" }), /id conflicts/u);
    assert.deepEqual(f.observer.listMaterials(id), [material]);
    const restoredDuplicate = { ...material, id: 7202, ref: reverse };
    assert.equal(f.storage.importMaterial(restoredDuplicate), true);
    assert.deepEqual(f.observer.listMaterials(id), [material, restoredDuplicate]);
  });
});

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-reference-identity-"));
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 9, 18) + tick++);
  const storage = new CrystalStorage({ agentDir: root, now });
  const observer = new CrystalStorage({ agentDir: root });
  const events: CrystalServiceEvent[] = [];
  const config = { ...defaultCrystalConfig, passiveEnabled: false, semanticScanEnabled: false };
  const service = new CrystalService({ storage, now, getConfig: () => config, onEvent: (event) => { events.push(event); } });
  const request = async (method: string, pathname: string, body: unknown = {}): Promise<CrystalHttpResponse> => {
    const response = await handleCrystalHttpRequest({ method, pathname, body }, { service, getConfig: () => config });
    assert.ok(response);
    return response;
  };
  try {
    await service.initialize();
    await observer.initialize();
    await run({
      service, storage, observer, events, request,
      seed: async (name, materials = {}) => {
        const response = await request("POST", "/api/crystal/seeds", { name, ...materials });
        assert.equal(response.status, 200);
        const id = (response.body as Crystal).id;
        assert.equal(typeof id, "string");
        assert.ok(id);
        return id;
      },
      add: async (id, kind, ref) => {
        const response = await request("POST", `/api/crystal/${id}/material`, { kind, ref });
        assert.equal(response.status, 200);
        const added = (response.body as { added: boolean }).added;
        assert.equal(typeof added, "boolean");
        assert.deepEqual(response.body, { added });
        return added;
      },
      detail: async (id) => {
        const response = await request("GET", `/api/crystal/${id}`);
        assert.equal(response.status, 200);
        return response.body as DetailResponse;
      },
      reopen: async () => {
        observer.close();
        service.close();
        await service.initialize();
        await observer.initialize();
      }
    });
  } finally {
    observer.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
}
