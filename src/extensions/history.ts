/**
 * 会话原文检索工具。
 *
 * 记忆库只保存被提取出的事实；本工具补上"发生过的事"这条检索路径：对会话 JSONL 的
 * 派生 FTS5 索引做全文检索。索引是增量推进的，检索前先把当前会话的新增消息刷进去。
 */
import { z } from "zod";
import { sessionSearchRefreshMaxAgeMs, type SessionSearchIndex } from "../session/searchIndex.js";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";

const searchHistorySchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(50).optional()
});

export interface SearchHistoryDeps {
  getIndex: () => SessionSearchIndex | undefined;
  /** 检索前先增量刷新当前会话，保证本回合消息立即可搜。 */
  flushCurrentSession?: () => Promise<void>;
}

export function createHistoryTools(deps: SearchHistoryDeps): Tool[] {
  return [{
    name: "search_history",
    description: "Full-text search past conversation transcripts (what was actually said, not extracted facts). Use when the user references an earlier conversation, decision or wording and the memory library has no matching entry.",
    promptSnippet: "Search past conversation transcripts by keyword",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords expected to appear verbatim in past user or assistant messages." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum number of hits; defaults to 8." }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: searchHistorySchema,
    source: "builtin",
    capability: "memory.read",
    risk: "read",
    resolveExecution(args: unknown) {
      const parsed = searchHistorySchema.safeParse(args);
      if (!parsed.success) {
        const message = "search_history requires a query.";
        return { isError: true as const, result: message, errorMessage: message };
      }
      const { query, limit } = parsed.data;
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic" as const, summary: "Search history", detail: query },
        description: `Search conversation transcripts for: ${query}`,
        approvalRule: "search_history",
        async execute(): Promise<unknown> {
          const index = deps.getIndex();
          if (!index) throw new Error("Session history search is unavailable.");
          await deps.flushCurrentSession?.();
          await index.refreshAll({ maxAgeMs: sessionSearchRefreshMaxAgeMs });
          const hits = index.search(query, { limit: limit ?? 8 });
          return { query, hits };
        }
      };
    }
  }];
}
