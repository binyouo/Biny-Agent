import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";
import { executeRuntimeHostMemoryOperation } from "../src/runtime/host/memory-operations.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { MemoryEntriesResult } from "../src/agent/context/memoryTypes.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-list-default-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const memory = new LocalMemory(root);
try {
  const old = (await memory.writeEntry({ content: "Old important fact", importance: 1 },
    { now: new Date("2026-09-01T00:00:00.000Z") })).entry!;
  const recent = (await memory.writeEntry({ content: "Recent ordinary fact", importance: 0.1 },
    { now: new Date("2026-09-02T00:00:00.000Z") })).entry!;
  for (let index = 0; index < 99; index += 1) {
    await memory.writeEntry({ content: `Extra fact ${String(index)}`, importance: 0.5 },
      { now: new Date(2026, 8, 3, 0, index) });
  }
  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const context = { getCommands: () => commands, scheduleEmbeddingRebuild: () => undefined };
  const list = async (payload: Record<string, unknown>): Promise<MemoryEntriesResult> =>
    await executeRuntimeHostMemoryOperation(context, { action: "list", ...payload }) as MemoryEntriesResult;

  const first = await list({});
  assert.equal(first.entries.length, 100, "public list defaults to 100 entries");
  assert.equal(first.total, 101, "total counts the entire matching store");
  assert.equal(first.entries.some((entry) => entry.id === old.id), false);
  assert.equal(first.entries.some((entry) => entry.id === recent.id), true);
  assert.equal(first.entries.at(-1)?.id, recent.id,
    "updatedAt is the display ordering authority, even when an older entry has higher importance");

  const second = await list({ offset: 100, limit: 5 });
  assert.deepEqual(second.entries.map((entry) => entry.id), [old.id]);
  assert.equal(second.total, 101);
  assert.equal((await list({ limit: 101 })).entries.length, 101, "explicit limit is respected");
  assert.equal((await memory.listMemoryEntries()).entries.length, 101,
    "internal full-store scans remain complete");

  const archivedOld = (await memory.archiveEntry(old.id, true)).entry!;
  const database = new DatabaseSync(path.join(root, "agent", AGENT_DATABASE_FILE));
  try {
    database.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run("{damaged", recent.id);
    database.prepare("UPDATE memory_archive SET metadata = ? WHERE id = ?").run("{damaged", archivedOld.id);
  } finally {
    database.close();
  }
  const firstPage = await memory.listMemoryEntries({ limit: 1 });
  assert.equal(firstPage.entries.length, 1);
  assert.equal(firstPage.entries[0]?.content, "Extra fact 98",
    "an active page must not decode unrelated rows outside the requested page");
  assert.equal(firstPage.total, 100);
  const archivedPage = await memory.listMemoryEntries({ includeArchived: true, limit: 1 });
  assert.equal(archivedPage.entries[0]?.content, "Extra fact 98",
    "an all-memory page must not decode unrelated active or archived rows");
  assert.equal(archivedPage.total, 101);
} finally {
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

console.log("memory list default tests passed");
