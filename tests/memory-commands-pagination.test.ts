import assert from "node:assert/strict";
import { runMemoryCommand } from "../src/agent/context/memoryCommands.js";
import type { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";

const entries: MemoryEntry[] = Array.from({ length: 501 }, (_, index) => ({
  id: `memory-${String(index)}`,
  content: index === 500 ? "最后一条长期事实" : `事实 ${String(index)}`,
  source: "manual",
  tags: [],
  importance: 0.5,
  durability: "permanent",
  accessCount: 0,
  revision: index + 1,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z"
}));
const deleted: string[] = [];
const memory = {
  listMemoryEntries: async ({ limit, offset }: { limit?: number; offset?: number } = {}) => ({
    entries: entries.slice(offset ?? 0, (offset ?? 0) + (limit ?? entries.length)),
    storeRevision: 501,
    total: entries.length
  }),
  deleteEntryById: async (id: string) => {
    deleted.push(id);
    return { deleted: true };
  }
} as unknown as LocalMemory;

assert.match(await runMemoryCommand(memory, ["show", "memory-500"]), /最后一条长期事实/);
const listing = await runMemoryCommand(memory, ["list"]);
assert.match(listing, /Memory entries \(100\)/u);
assert.doesNotMatch(listing, /memory-100/u);
assert.match(await runMemoryCommand(memory, ["forget", "memory-500"]), /Deleted 1 memory entry/);
assert.deepEqual(deleted, ["memory-500"]);

console.log("memory command pagination tests passed");
