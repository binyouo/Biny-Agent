/** Distinct canonical topics must never share counts, nuclei, or materials because of a short hash collision. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CrystalService, normalizeTerm, termId } from "../src/agent/context/crystalService.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { defaultCrystalConfig, type CrystalTerm } from "../src/agent/context/crystalTypes.js";

const topics = ["C#项目", "BB项目"] as const;
const legacyId = "tyj2r02";
const timestamp = "2026-10-01T12:00:00.000Z";

async function fixture(run: (service: CrystalService, storage: CrystalStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-term-collision-"));
  const storage = new CrystalStorage({ agentDir: root });
  const service = new CrystalService({
    storage,
    getConfig: () => ({ ...defaultCrystalConfig, semanticScanEnabled: false }),
    now: () => new Date(timestamp)
  });
  try {
    await service.initialize();
    await run(service, storage);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function record(service: CrystalService, anchorId: string, terms: readonly string[], day = "2026-10-01") {
  return service.processAnchor({ threadId: `thread-${day}`, anchorId, day, text: terms.join(" 与 "), terms });
}

function findTerm(storage: CrystalStorage, term: string): CrystalTerm {
  const rows = storage.listTerms().filter((row) => row.term === term);
  assert.equal(rows.length, 1, `one independent row for ${term}`);
  return rows[0]!;
}

function storedTerm(id: string, term: string): CrystalTerm {
  return { id, term, status: "latent", count: 0, turnIds: [], threadIds: [], days: [], occurrences: [],
    crystalId: undefined, createdAt: timestamp, updatedAt: timestamp };
}

test("fixed distinct canonical topics share the legacy short hash", () => {
  assert.equal(normalizeTerm(topics[0]), topics[0]);
  assert.equal(normalizeTerm(topics[1]), topics[1]);
  assert.notEqual(topics[0], topics[1]);
  assert.equal(termId(topics[0]), legacyId);
  assert.equal(termId(topics[1]), legacyId);
});

for (const ordered of [topics, [...topics].reverse()]) {
  test(`same-anchor topics stay independent and stable after reopening: ${ordered.join(" then ")}`, async () => fixture(async (service, storage) => {
    const first = await record(service, "shared-anchor", [...ordered, ordered[0]!]);
    assert.equal(first.claimed, true);
    assert.deepEqual(new Set(first.terms), new Set(topics));
    const before = topics.map((topic) => findTerm(storage, topic));
    assert.notEqual(before[0]!.id, before[1]!.id);
    for (const row of before) {
      assert.equal(row.count, 1);
      assert.deepEqual(row.turnIds, ["shared-anchor"]);
      assert.equal(row.occurrences.length, 1);
    }
    assert.equal((await record(service, "shared-anchor", ordered)).claimed, false);
    assert.deepEqual(topics.map((topic) => findTerm(storage, topic)), before);
    service.close();
    await service.initialize();
    await record(service, "after-reopen", ordered, "2026-10-02");
    for (let index = 0; index < topics.length; index += 1) {
      const row = findTerm(storage, topics[index]!);
      assert.equal(row.id, before[index]!.id, "identity survives reopening and a new anchor");
      assert.equal(row.count, 2);
      assert.deepEqual(row.turnIds, ["shared-anchor", "after-reopen"]);
    }
  }));

  test(`separate anchors keep thresholds and materials independent: ${ordered.join(" then ")}`, async () => fixture(async (service, storage) => {
    const expected = new Map(topics.map((topic) => [topic, [] as string[]]));
    for (let index = 0; index < 8; index += 1) {
      for (const topic of ordered) {
        const anchorId = `${topic}-${index}`;
        expected.get(topic as typeof topics[number])!.push(anchorId);
        const result = await record(service, anchorId, [topic], index % 2 ? "2026-10-02" : "2026-10-01");
        const row = findTerm(storage, topic);
        assert.equal(row.count, index + 1);
        assert.deepEqual(row.turnIds, expected.get(topic as typeof topics[number]));
        assert.equal(result.nucleated.length, index === 7 ? 1 : 0, "other topic cannot advance this threshold");
        assert.equal(row.status, index < 3 ? "latent" : index < 7 ? "contour" : "nucleus");
      }
    }
    assert.equal(storage.listTerms().length, 2);
    assert.equal(storage.listCrystals().length, 2);
    const rows = topics.map((topic) => findTerm(storage, topic));
    assert.notEqual(rows[0]!.id, rows[1]!.id);
    assert.notEqual(rows[0]!.crystalId, rows[1]!.crystalId);
    for (const row of rows) {
      const crystal = storage.getCrystal(row.crystalId!)!;
      assert.equal(crystal.name, row.term);
      assert.equal(crystal.termId, row.id);
      assert.equal(service.detail(crystal.id)?.term?.id, row.id);
      const materials = storage.listMaterials(crystal.id);
      assert.equal(materials.length, 8);
      assert.deepEqual(new Set(materials.map((material) => (material.ref as { anchorId: string }).anchorId)),
        new Set(expected.get(row.term as typeof topics[number])));
      assert.deepEqual(row.occurrences.map((anchor) => anchor.anchorId), expected.get(row.term as typeof topics[number]));
    }
  }));
}

test("a colliding topic preserves a legacy nucleus, history, and materials", async () => fixture(async (service, storage) => {
  const oldAnchors = Array.from({ length: 8 }, (_, index) => ({ threadId: "legacy-thread", anchorId: `legacy-${index}`,
    day: index % 2 ? "2026-09-30" : "2026-09-29", source: "conversation" as const }));
  const legacy: CrystalTerm = { ...storedTerm(legacyId, topics[0]), status: "nucleus", count: 8,
    turnIds: oldAnchors.map((anchor) => anchor.anchorId), threadIds: ["legacy-thread"], days: ["2026-09-29", "2026-09-30"],
    occurrences: oldAnchors, crystalId: "cry_existing_topic" };
  storage.putTerm(legacy);
  storage.putCrystal({ id: legacy.crystalId!, origin: "nucleus", stage: "candidate", name: topics[0], dormant: true,
    termId: legacyId, checklist: {}, notified: true, createdAt: timestamp, updatedAt: timestamp });
  for (const anchor of oldAnchors) storage.addMaterial(legacy.crystalId!, "turn",
    { threadId: anchor.threadId, anchorId: anchor.anchorId }, "auto");
  const oldCrystal = storage.getCrystal(legacy.crystalId!);
  const oldMaterials = storage.listMaterials(legacy.crystalId!);
  const other = await record(service, "new-other-topic", [topics[1]]);
  assert.deepEqual(other.woken, []);
  assert.equal(other.materialsAdded, 0);
  assert.deepEqual(storage.getTerm(legacyId), legacy);
  assert.deepEqual(storage.getCrystal(legacy.crystalId!), oldCrystal);
  assert.deepEqual(storage.listMaterials(legacy.crystalId!), oldMaterials);
  const secondId = findTerm(storage, topics[1]).id;
  assert.notEqual(secondId, legacyId);
  service.close();
  await service.initialize();
  await record(service, "other-after-reopen", [topics[1]]);
  assert.equal(findTerm(storage, topics[1]).id, secondId);
  assert.equal(findTerm(storage, topics[1]).count, 2);
  assert.deepEqual(storage.getTerm(legacyId), legacy);
  const own = await record(service, "own-after-reopen", [topics[0]]);
  assert.equal(own.woken.length, 1);
  assert.equal(own.woken[0]?.id, legacy.crystalId);
  assert.equal(storage.getTerm(legacyId)?.count, 9);
  assert.equal(storage.listMaterials(legacy.crystalId!).length, oldMaterials.length + 1);
  assert.equal(findTerm(storage, topics[1]).count, 2);
}));

test("an occupied fallback slot is preserved and the new identity survives reopening", async () => fixture(async (service, storage) => {
  const legacy = storedTerm(legacyId, topics[0]);
  const occupied = storedTerm(`${legacyId}_1`, "reservedtopic");
  storage.putTerm(legacy);
  storage.putTerm(occupied);
  await record(service, "occupied-slot", [topics[1]]);
  const secondId = findTerm(storage, topics[1]).id;
  assert.notEqual(secondId, legacy.id);
  assert.notEqual(secondId, occupied.id);
  assert.deepEqual(storage.getTerm(legacy.id), legacy);
  assert.deepEqual(storage.getTerm(occupied.id), occupied);
  service.close();
  await service.initialize();
  await record(service, "occupied-slot-reopen", [topics[1]]);
  assert.equal(findTerm(storage, topics[1]).id, secondId);
  assert.equal(findTerm(storage, topics[1]).count, 2);
  assert.deepEqual(storage.getTerm(occupied.id), occupied);
}));

test("noncolliding terms preserve normalization, duplicate suppression, and legacy IDs", async () => fixture(async (service, storage) => {
  await record(service, "noncolliding", ["UnchangedTopic", "unchangedtopic"]);
  const ordinary = findTerm(storage, "unchangedtopic");
  assert.equal(ordinary.id, termId("unchangedtopic"), "noncolliding legacy IDs stay unchanged");
  assert.equal(ordinary.count, 1);
}));
