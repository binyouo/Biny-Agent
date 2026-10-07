/** Malformed Host archive requests must not be interpreted as a restore. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { MemoryArchiveResult } from "../src/agent/context/memoryTypes.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { executeRuntimeHostMemoryOperation } from "../src/runtime/host/memory-operations.js";

await test("Host rejects non-boolean archive states before changing active or archived facts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-archive-state-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const memory = new LocalMemory(root, () => { throw new Error("Manual archive must not call a model"); });
  const verifier = new MemoryStorage(root);
  const context = {
    getCommands: () => ({ agent: { getLocalMemory: () => memory } }) as unknown as CommandRuntime,
    scheduleEmbeddingRebuild: () => { throw new Error("Manual archive must not schedule a rebuild"); }
  };
  const execute = async (payload: Record<string, unknown>) => await executeRuntimeHostMemoryOperation(context, payload);
  try {
    const active = (await memory.writeEntry({ content: "Keep this active fact unchanged", threadId: "thread-a" })).entry!;
    const storedActive = await verifier.getEntry(active.id);
    for (const archived of [undefined, null, "true", "false", 0, 1, [], {}]) {
      await t.test(`rejects archived=${JSON.stringify(archived) ?? "missing"}`, async () => {
        const source = (await memory.writeEntry({ content: "Keep this archived fact unchanged", threadId: "thread-b" })).entry!;
        const archive = (await memory.archiveEntry(source.id, true)).entry!;
        const before = await verifier.listEntries({ includeArchived: true });
        for (const id of [archive.id, active.id]) {
          const payload: Record<string, unknown> = { action: "archive", id };
          if (archived !== undefined) payload.archived = archived;
          await assert.rejects(execute(payload), { message: "Runtime Host field archived must be a boolean." });
          assert.deepEqual(await verifier.listEntries({ includeArchived: true }), before,
            "rejected archive state must preserve all persisted facts, IDs and store revision");
        }
      });
    }

    await t.test("explicit booleans preserve archive, restore, no-op and missing-ID results", async () => {
      const source = (await memory.writeEntry({ content: "Boolean state transition control" })).entry!;
      const archived = await execute({ action: "archive", id: source.id, archived: true }) as MemoryArchiveResult;
      assert.equal(archived.archived, true);
      assert.ok(archived.entry?.archivedAt);
      assert.equal(archived.entry.originalId, source.id);
      assert.equal(await verifier.getEntry(source.id), undefined);
      assert.deepEqual(await verifier.getEntry(archived.entry.id), archived.entry);
      assert.deepEqual(await execute({ action: "archive", id: archived.entry.id, archived: true }), archived);

      const restored = await execute({ action: "archive", id: archived.entry.id, archived: false }) as MemoryArchiveResult;
      assert.equal(restored.archived, false);
      assert.ok(restored.entry);
      assert.equal(restored.entry.archivedAt, undefined);
      assert.notEqual(restored.entry.id, source.id);
      assert.notEqual(restored.entry.id, archived.entry.id);
      assert.equal(restored.entry.content, source.content);
      assert.equal(await verifier.getEntry(archived.entry.id), undefined);
      assert.deepEqual(await verifier.getEntry(restored.entry.id), restored.entry);
      assert.deepEqual(await execute({ action: "archive", id: restored.entry.id, archived: false }), restored);
      for (const flag of [false, true]) {
        assert.deepEqual(await execute({ action: "archive", id: "missing-memory", archived: flag }),
          { archived: false, revision: restored.revision });
      }
      assert.deepEqual(await verifier.getEntry(active.id), storedActive);
    });
  } finally {
    verifier.close();
    memory.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
