import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryWriteResult } from "../src/agent/context/memoryTypes.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { executeRuntimeHostMemoryOperation } from "../src/runtime/host/memory-operations.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";

const invalidContent = [
  { name: "number", value: 42 },
  { name: "null", value: null },
  { name: "boolean", value: true },
  { name: "object", value: { text: "The release uses npm" } },
  { name: "array", value: ["The release uses npm"] },
  { name: "empty string", value: "" },
  { name: "whitespace", value: " \n\t " }
];

for (const { name, value } of invalidContent) {
  test(`Host rejects ${name} content instead of confirming or partially applying a memory correction`, async () => {
    await withMemory(async (memory, reader, update) => {
      const original = await memory.writeEntry({ content: "The release uses pnpm", tags: ["release"] });
      assert.ok(original.entry);
      const before = await reader.listEntries();
      for (const activeOnly of [undefined, true]) {
        await assert.rejects(update(original.entry.id, { content: value, tags: ["incorrect"] }, activeOnly),
          /patch\.content must be a non-empty string/u);
        assert.deepEqual(await reader.listEntries(), before,
          "rejected corrections must preserve all fact fields, timestamps and store revision");
      }
    });
  });
}

test("Host persists valid text corrections and metadata-only edits without changing missing-ID results", async () => {
  await withMemory(async (memory, reader, update) => {
    const original = await memory.writeEntry({ content: "The release uses npm", tags: ["release"] });
    assert.ok(original.entry);
    const corrected = await update(original.entry.id, { content: "  项目发布使用 pnpm 10.6.5  " });
    assert.equal(corrected?.written, true);
    assert.equal(corrected.entry?.content, "项目发布使用 pnpm 10.6.5");
    assert.equal(corrected.entry?.id, original.entry.id);
    assert.equal(corrected.entry?.createdAt, original.entry.createdAt);
    assert.deepEqual(corrected.entry?.tags, ["release"]);
    assert.deepEqual(await reader.getEntry(original.entry.id), corrected.entry);

    const retagged = await update(original.entry.id, { tags: ["workflow"], importance: 0.8 }, true);
    assert.equal(retagged?.written, true);
    assert.equal(retagged.entry?.content, corrected.entry?.content, "omitting content leaves the fact intact");
    assert.deepEqual(retagged.entry?.tags, ["workflow"]);
    assert.equal(retagged.entry?.importance, 0.8);
    assert.deepEqual(await reader.getEntry(original.entry.id), retagged.entry);

    const beforeMissing = await reader.listEntries();
    assert.deepEqual(await update("missing-fact", { content: "Valid replacement" }),
      { written: false, revision: beforeMissing.storeRevision });
    assert.equal(await update("missing-fact", { content: "Valid replacement" }, true), null);
    assert.deepEqual(await reader.listEntries(), beforeMissing);
  });
});

type Update = (id: string, patch: Record<string, unknown>, activeOnly?: boolean) => Promise<MemoryWriteResult | null>;

async function withMemory(run: (memory: LocalMemory, reader: MemoryStorage, update: Update) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-update-content-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const memory = new LocalMemory(root, () => { throw new Error("Manual updates must not call a model"); });
  const reader = new MemoryStorage(root);
  try {
    const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
    const context = { getCommands: () => commands, scheduleEmbeddingRebuild: () => undefined };
    await run(memory, reader, async (id, patch, activeOnly) =>
      await executeRuntimeHostMemoryOperation(context, { action: "update", id, patch, activeOnly }) as MemoryWriteResult | null);
  } finally {
    reader.close();
    memory.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
