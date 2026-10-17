/** External query stand-ins for coordinator tests; memory and transcript domains stay real. */
import { z } from "zod";
import type { LocalMemory } from "../../src/agent/context/LocalMemory.js";
import type { MemorySearchOptions, MemorySearchResult } from "../../src/agent/context/memoryTypes.js";
import type { SessionSearchIndex } from "../../src/session/searchIndex.js";
import { searchConversationHistory } from "../../src/session/searchHistory.js";
import { ToolAccesses } from "../../src/tools/access.js";
import type { Tool } from "../../src/tools/types.js";

export function createMemoryQueryFixture(getMemory: () => LocalMemory | undefined,
  search?: (query: string, paths: string[], options: MemorySearchOptions) => Promise<MemorySearchResult>): Tool {
  const schema = z.object({ query: z.string().trim().min(1), limit: z.number().optional(), threshold: z.number().optional(), tags: z.array(z.string()).optional(), threadId: z.string().optional() });
  const query: Tool = {
    name: "WebSearch", description: "Search a fixture shared durable memory library", risk: "read", capability: "web.search",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, threshold: { type: "number" }, tags: { type: "array", items: { type: "string" } }, threadId: { type: "string" } }, required: ["query"], additionalProperties: false }, schema,
    resolveExecution(args) {
      const { query, ...options } = schema.parse(args);
      return { accesses: ToolAccesses.none(), approvalRule: "WebSearch", async execute({ signal }) {
        signal?.throwIfAborted();
        if (!getMemory() || !search) throw new Error("Fixture query unavailable.");
        const result = await search(query, [], { limit: 5, threshold: 0.3, ...options, signal });
        signal?.throwIfAborted();
        return result;
      } };
    }
  };
  return query;
}

export function createHistoryQueryFixture(deps: {
  getIndex: () => Pick<SessionSearchIndex, "refreshAll" | "search"> | undefined;
  flushCurrentSession?: (signal?: AbortSignal) => Promise<void>;
}): Tool {
  return { name: "mcp__history__search", description: "Search fixture transcripts across projects", risk: "read",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
    schema: z.object({ query: z.string(), limit: z.number().optional() }),
    resolveExecution(args: { query: string; limit?: number }) {
      return { accesses: ToolAccesses.none(), approvalRule: "mcp__history__search", async execute({ signal }) {
        signal?.throwIfAborted();
        const index = deps.getIndex();
        signal?.throwIfAborted();
        if (!index) throw new Error("Session history search is unavailable.");
        await deps.flushCurrentSession?.(signal);
        signal?.throwIfAborted();
        return await searchConversationHistory(index as SessionSearchIndex, args.query, { limit: args.limit, signal });
      } };
    }
  };
}
