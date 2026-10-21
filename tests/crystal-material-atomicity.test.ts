/** Real HTTP/service/storage regression; every database and reference is synthetic. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Crystal, CrystalMaterial, CrystalMaterialKind } from "../src/agent/context/crystalTypes.js";
import type { CrystalServiceEvent } from "../src/agent/context/crystalService.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-atomicity-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External requests are forbidden in this fixture."); };

try {
  // Import only after isolating all module-level default paths.
  const { DatabaseSync } = await import("node:sqlite");
  const { CrystalStorage } = await import("../src/agent/context/crystalStorage.js");
  const { CrystalService } = await import("../src/agent/context/crystalService.js");
  const { handleCrystalHttpRequest } = await import("../src/agent/context/crystalHttp.js");
  const { defaultCrystalConfig } = await import("../src/agent/context/crystalTypes.js");
  const initialTime = "2026-10-01T00:00:00.000Z";
  const writeTime = "2026-10-02T00:00:00.000Z";
  const notifiedTime = "2026-10-03T00:00:00.000Z";
  const duplicateTime = "2026-10-04T00:00:00.000Z";
  const metadataFailure = /injected crystal metadata failure/u;
  const materialFailure = /injected material insert failure/u;
  const anchor = { threadId: "synthetic-thread", anchorId: "synthetic-anchor", day: "2026-10-02" };
  const turnRef = { threadId: anchor.threadId, anchorId: anchor.anchorId };

  async function fixture(semantic = false) {
    const directory = await mkdtemp(path.join(root, "case-"));
    let timestamp = initialTime;
    let failExtraction = false;
    const storage = new CrystalStorage({ agentDir: directory, now: () => new Date(timestamp) });
    const observer = new CrystalStorage({ agentDir: directory });
    const events: CrystalServiceEvent[] = [];
    const publications: Array<{ crystal: Crystal | undefined; materials: CrystalMaterial[] }> = [];
    const config = { ...defaultCrystalConfig, passiveEnabled: true, semanticScanEnabled: semantic };
    const service = new CrystalService({
      storage,
      now: () => new Date(timestamp),
      getConfig: () => config,
      getModel: () => { throw new Error("No model may be requested."); },
      extractTerms: async () => {
        if (failExtraction) throw new Error("injected extraction failure");
        return [];
      },
      embedText: semantic ? async () => new Float32Array([1, 0]) : undefined,
      onEvent: (event) => {
        events.push(event);
        // This independent connection sees committed state, never the writer's pending state.
        if (event.type === "material_added") publications.push({
          crystal: observer.getCrystal(event.crystalId!),
          materials: observer.listMaterials(event.crystalId!)
        });
      }
    });
    const sql = (statement: string): void => {
      const database = new DatabaseSync(storage.databasePath);
      try { database.exec(statement); } finally { database.close(); }
    };
    try {
      await service.initialize();
      await observer.initialize();
    } catch (error) {
      service.close();
      observer.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      service, storage, observer, events, publications,
      time: (value: string) => { timestamp = value; },
      extractionFailure: (value: boolean) => { failExtraction = value; },
      seed(name: string): Crystal {
        const seed = service.createSeed(name);
        return service.cancel(seed.id, true); // Active seed, notified=true, through the public API.
      },
      fault(id: string, kind: "metadata" | "material" = "metadata"): void {
        const quoted = `'${id.replaceAll("'", "''")}'`;
        sql(kind === "metadata"
          ? `CREATE TRIGGER fail_write BEFORE UPDATE ON crystals WHEN OLD.id = ${quoted}
             BEGIN SELECT RAISE(ABORT, 'injected crystal metadata failure'); END;`
          : `CREATE TRIGGER fail_write BEFORE INSERT ON crystal_materials WHEN NEW.crystal_id = ${quoted}
             BEGIN SELECT RAISE(ABORT, 'injected material insert failure'); END;`);
      },
      clearFault: () => sql("DROP TRIGGER fail_write"),
      async add(id: string, kind: CrystalMaterialKind, ref: unknown) {
        const response = await handleCrystalHttpRequest({
          method: "POST", pathname: `/api/crystal/${id}/material`, body: { kind, ref }
        }, { service, getConfig: () => config });
        assert.ok(response, "the real material route must handle this request");
        return response;
      },
      process: (text: string, anchorId = anchor.anchorId) => service.processAnchor({ ...anchor, anchorId, text }),
      async reopen(): Promise<void> {
        service.close();
        observer.close();
        await service.initialize();
        await observer.initialize();
      },
      async close(): Promise<void> {
        service.close();
        observer.close();
        await rm(directory, { recursive: true, force: true });
      }
    };
  }

  for (const [kind, ref] of [
    ["note", { text: "Synthetic note evidence" }],
    ["turn", turnRef],
    ["bundle", { bundleId: "synthetic-bundle" }]
  ] as const) {
    await test(`HTTP ${kind}: second-write failure rolls back, retry commits, duplicate has no side effects`, async () => {
      const f = await fixture();
      try {
        const before = f.seed("ManualTopic");
        f.time(writeTime);
        f.fault(before.id);
        const failed = await f.add(before.id, kind, ref);
        assert.equal(failed.status, 500);
        assert.match((failed.body as { error: string }).error, metadataFailure);
        assert.deepEqual(f.events, []);
        assert.deepEqual(f.observer.getCrystal(before.id), before);
        assert.deepEqual(f.observer.listMaterials(before.id), [], "failed metadata must roll back the preceding material insert");
        await f.reopen();
        assert.deepEqual(f.observer.getCrystal(before.id), before);
        assert.deepEqual(f.observer.listMaterials(before.id), []);

        f.clearFault();
        assert.deepEqual(await f.add(before.id, kind, ref), { status: 200, body: { added: true } });
        const expected = { ...before, notified: false, updatedAt: writeTime };
        assert.deepEqual(f.observer.getCrystal(before.id), expected);
        const materials = f.observer.listMaterials(before.id);
        assert.equal(materials.length, 1);
        assert.deepEqual(materials[0], { id: materials[0]!.id, crystalId: before.id, kind, ref, source: "user", createdAt: writeTime });
        assert.deepEqual(f.events, [{ type: "material_added", crystalId: before.id }]);
        assert.deepEqual(f.publications, [{ crystal: expected, materials }], "event subscribers see both committed writes");
        await f.reopen();
        assert.deepEqual(f.observer.getCrystal(before.id), expected);
        assert.deepEqual(f.observer.listMaterials(before.id), materials);

        f.time(notifiedTime);
        const notified = f.service.cancel(before.id, true);
        f.time(duplicateTime);
        f.fault(before.id); // A duplicate must not even attempt a metadata write.
        assert.deepEqual(await f.add(before.id, kind, ref), { status: 200, body: { added: false } });
        assert.deepEqual(f.observer.getCrystal(before.id), notified);
        assert.deepEqual(f.observer.listMaterials(before.id), materials);
        assert.equal(f.events.length, 1);
        await f.reopen();
        assert.deepEqual(f.observer.getCrystal(before.id), notified);
        assert.deepEqual(f.observer.listMaterials(before.id), materials);
      } finally { await f.close(); }
    });
  }

  await test("processAnchor name match: rollback leaves the anchor retryable and duplicate attachment preserves notification", async () => {
    const f = await fixture();
    try {
      const before = f.seed("DirectTopic");
      f.time(writeTime);
      f.fault(before.id);
      await assert.rejects(f.process("Review DirectTopic evidence"), metadataFailure);
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.observer.getCrystal(before.id), before);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), false);
      assert.deepEqual(f.observer.listMaterials(before.id), []);
      await f.reopen();
      assert.deepEqual(f.observer.listMaterials(before.id), []);
      assert.deepEqual(f.observer.getCrystal(before.id), before);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), false);

      f.clearFault();
      const result = await f.process("Review DirectTopic evidence");
      assert.equal(result.claimed, true);
      assert.equal(result.materialsAdded, 1);
      const expected = { ...before, notified: false, updatedAt: writeTime };
      const materials = f.observer.listMaterials(before.id);
      assert.equal(materials.length, 1);
      assert.deepEqual(materials[0]!.ref, turnRef);
      assert.equal(materials[0]!.source, "auto");
      assert.deepEqual(f.publications, [{ crystal: expected, materials }]);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), true);
      await f.reopen();
      assert.deepEqual(f.observer.getCrystal(before.id), expected);
      assert.deepEqual(f.observer.listMaterials(before.id), materials);

      // Existing partial success after a later extraction error must remain idempotent too.
      const nextAnchor = "extraction-retry-anchor";
      f.extractionFailure(true);
      await assert.rejects(f.process("Review DirectTopic again", nextAnchor), /injected extraction failure/u);
      assert.equal(f.observer.hasProcessedAnchor(nextAnchor), false);
      const bothMaterials = f.observer.listMaterials(before.id);
      assert.equal(bothMaterials.length, 2);
      f.time(notifiedTime);
      const notified = f.service.cancel(before.id, true);
      f.time(duplicateTime);
      f.fault(before.id);
      f.extractionFailure(false);
      const duplicate = await f.process("Review DirectTopic again", nextAnchor);
      assert.equal(duplicate.claimed, true);
      assert.equal(duplicate.materialsAdded, 0);
      assert.deepEqual(f.observer.getCrystal(before.id), notified);
      assert.deepEqual(f.observer.listMaterials(before.id), bothMaterials);
      assert.equal(f.events.length, 2);
      assert.equal((await f.process("Review DirectTopic again", nextAnchor)).claimed, false);
      await f.reopen();
      assert.deepEqual(f.observer.getCrystal(before.id), notified);
      assert.deepEqual(f.observer.listMaterials(before.id), bothMaterials);
    } finally { await f.close(); }
  });

  await test("second name-matched seed failure retains the first seed's committed material and retries only the second", async () => {
    const f = await fixture();
    try {
      const first = f.seed("FirstTopic"), second = f.seed("SecondTopic");
      f.time(writeTime);
      f.fault(second.id);
      await assert.rejects(f.process("FirstTopic and SecondTopic evidence"), metadataFailure);
      const firstMaterials = f.observer.listMaterials(first.id);
      assert.equal(firstMaterials.length, 1);
      const firstSaved = { ...first, notified: false, updatedAt: writeTime };
      assert.deepEqual(f.observer.getCrystal(first.id), firstSaved);
      assert.deepEqual(f.publications, [{ crystal: firstSaved, materials: firstMaterials }]);
      assert.deepEqual(f.events, [{ type: "material_added", crystalId: first.id }]);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), false);
      assert.deepEqual(f.observer.getCrystal(second.id), second);
      assert.deepEqual(f.observer.listMaterials(second.id), []);
      await f.reopen();
      assert.deepEqual(f.observer.listMaterials(first.id), firstMaterials);
      assert.deepEqual(f.observer.getCrystal(second.id), second);
      assert.deepEqual(f.observer.listMaterials(second.id), []);
      f.clearFault();
      f.time(notifiedTime);
      const result = await f.process("FirstTopic and SecondTopic evidence");
      assert.equal(result.claimed, true);
      assert.equal(result.materialsAdded, 1);
      assert.deepEqual(f.observer.getCrystal(first.id), firstSaved);
      assert.deepEqual(f.observer.listMaterials(first.id), firstMaterials);
      assert.equal(f.observer.listMaterials(second.id).length, 1);
      assert.deepEqual(f.observer.getCrystal(second.id), { ...second, notified: false, updatedAt: notifiedTime });
      assert.deepEqual(f.events.map((event) => event.crystalId), [first.id, second.id]);
      assert.deepEqual(f.publications[1], { crystal: f.observer.getCrystal(second.id), materials: f.observer.listMaterials(second.id) });
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), true);
    } finally { await f.close(); }
  });

  await test("no name match and first-write failures preserve metadata and emit no material event", async () => {
    const f = await fixture();
    try {
      const before = f.seed("OnlyTopic");
      f.time(writeTime);
      f.fault(before.id);
      const noMatch = await f.process("Unrelated synthetic evidence", "no-match");
      assert.equal(noMatch.claimed, true);
      assert.equal(noMatch.materialsAdded, 0);
      assert.deepEqual(f.observer.getCrystal(before.id), before);
      assert.deepEqual(f.observer.listMaterials(before.id), []);
      assert.deepEqual(f.events, []);
      f.clearFault();
      f.fault(before.id, "material");
      const failed = await f.add(before.id, "note", { text: "Never inserted" });
      assert.equal(failed.status, 500);
      assert.match((failed.body as { error: string }).error, materialFailure);
      await assert.rejects(f.process("OnlyTopic synthetic evidence"), materialFailure);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), false);
      assert.deepEqual(f.observer.getCrystal(before.id), before);
      assert.deepEqual(f.observer.listMaterials(before.id), []);
      assert.deepEqual(f.events, []);
      await f.reopen();
      assert.deepEqual(f.observer.getCrystal(before.id), before);
      assert.deepEqual(f.observer.listMaterials(before.id), []);
      f.clearFault();
      assert.equal((await f.process("OnlyTopic synthetic evidence")).materialsAdded, 1);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), true);
      assert.equal(f.events.length, 1);
    } finally { await f.close(); }
  });

  await test("semantic attachment remains transactional and best effort across a failed sibling", async () => {
    const f = await fixture(true);
    try {
      const failed = f.seed("SemanticFirst"), sibling = f.seed("SemanticSecond");
      f.time(writeTime);
      f.fault(failed.id);
      const result = await f.process("Unrelated synthetic input for semantic matching");
      assert.equal(result.claimed, true);
      assert.equal(result.materialsAdded, 1);
      assert.equal(f.observer.hasProcessedAnchor(anchor.anchorId), true);
      assert.deepEqual(f.observer.getCrystal(failed.id), failed);
      assert.deepEqual(f.observer.listMaterials(failed.id), []);
      const expected = { ...sibling, notified: false, updatedAt: writeTime };
      const materials = f.observer.listMaterials(sibling.id);
      assert.equal(materials.length, 1);
      assert.equal(materials[0]!.source, "auto-semantic");
      assert.deepEqual(f.publications, [{ crystal: expected, materials }]);
      assert.deepEqual(f.events, [{ type: "material_added", crystalId: sibling.id }]);
      await f.reopen();
      assert.deepEqual(f.observer.getCrystal(failed.id), failed);
      assert.deepEqual(f.observer.listMaterials(failed.id), []);
      assert.deepEqual(f.observer.listMaterials(sibling.id), materials);
      f.clearFault();
      assert.equal((await f.process("Unrelated synthetic input for semantic matching")).claimed, false);
      assert.deepEqual(f.observer.listMaterials(failed.id), [], "best effort does not replay a processed anchor");
      assert.equal((await f.process("Unrelated synthetic input for semantic matching", "fresh-semantic-anchor")).materialsAdded, 2);
      assert.equal(f.observer.listMaterials(failed.id).length, 1);
      assert.equal(f.observer.listMaterials(sibling.id).length, 2);
    } finally { await f.close(); }
  });
} finally {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
