import assert from "node:assert/strict";
import { createMemoryTools } from "../src/extensions/memory.js";
import type { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemorySearchOptions, MemorySearchResult } from "../src/agent/context/memoryTypes.js";

const searched: MemorySearchOptions[] = [];
const recall = createMemoryTools(
  () => ({} as LocalMemory),
  async (_query, _paths, options): Promise<MemorySearchResult> => {
    searched.push(options);
    return { matches: [], storeRevision: 0, report: { omitted: [] } };
  }
)[1]!;

const defaultExecution = await recall.resolveExecution({ query: "release checklist" });
assert.ok(!("isError" in defaultExecution));
await defaultExecution.execute({ toolCallId: "default" });
assert.equal(searched[0]?.limit, 5);
assert.equal(searched[0]?.threshold, 0.3);

const explicitExecution = await recall.resolveExecution({ query: "release checklist", limit: 3, threshold: 0.8 });
assert.ok(!("isError" in explicitExecution));
await explicitExecution.execute({ toolCallId: "explicit" });
assert.equal(searched[1]?.limit, 3);
assert.equal(searched[1]?.threshold, 0.8);

for (const threshold of [-0.1, 1.1]) {
  const invalid = await recall.resolveExecution({ query: "release checklist", threshold });
  assert.ok("isError" in invalid);
}

console.log("Memory recall tool search options passed");
