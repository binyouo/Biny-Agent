/**
 * 归档工具结果读取模块。
 *
 * 工具输出因回合预算或模型投影被移出对话时，只在上下文里留下 `.biny/tool-results` 引用。
 * 该目录被 workspace ignore 规则挡在 `Read` 之外，因此按需取回必须走这个受限入口：
 * 它只接受归档引用形态的路径，不接受任意工作区路径。
 */
import { z } from "zod";
import { readToolResultArchive, resolveToolResultArchivePath } from "../../session/toolResultArchive.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

const defaultLength = 16_000;
const maxLength = 200_000;

/**
 * Retrieving an archived result is the one tool output the turn budget must not
 * archive again: the model asked for this content explicitly, and re-archiving
 * it would answer an archive reference with another archive reference. The
 * `length` cap above is what bounds it instead.
 */
export const readToolResultToolName = "read_tool_result";

export interface ReadToolResultArgs {
  archivePath: string;
  offset?: number;
  length?: number;
}

export interface ReadToolResultResult {
  archivePath: string;
  tool: string;
  archivedAt: string;
  totalCharacters: number;
  offset: number;
  /** Next UTF-16 code-unit offset; pass it unchanged for the next page. */
  nextOffset: number;
  content: string;
  hasMore: boolean;
}

export function createReadToolResultTool(context: ToolContext): Tool<ReadToolResultArgs, ReadToolResultResult> {
  return {
    name: readToolResultToolName,
    description: `Read a tool result archived out of the model context because it was large or superseded. Pass the archivePath reported in the result. Returns at most ${String(maxLength)} UTF-16 code units; page through longer results with nextOffset as offset. Page boundaries preserve surrogate pairs.`,
    promptSnippet: "Read a paginated tool result archived outside the conversation",
    promptGuidelines: ["When a tool result reports an archivePath, use read_tool_result and continue paging until enough evidence is available"],
    parameters: {
      type: "object",
      properties: {
        archivePath: { type: "string", minLength: 1, description: "The .biny/tool-results reference reported by an archived tool result." },
        offset: { type: "integer", minimum: 0, description: "UTF-16 code-unit offset to start from. Defaults to 0; an offset inside a surrogate pair rounds back to its start." },
        length: { type: "integer", minimum: 1, maximum: maxLength, description: `UTF-16 code units to return. Defaults to ${String(defaultLength)}; a length of 1 may return a whole surrogate pair (2 units).` }
      },
      required: ["archivePath"],
      additionalProperties: false
    },
    schema: z.object({
      archivePath: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(maxLength).optional()
    }),
    // 与 filesystem.* 分开：subagent 的能力白名单不包含它，子 agent 不会意外读到父会话归档。
    capability: "toolresult.read",
    risk: "read",
    resolveExecution(args) {
      // 解析失败要在权限询问之前暴露，而不是等到执行阶段。
      resolveToolResultArchivePath(context.workspaceRoot, args.archivePath);
      return {
        accesses: ToolAccesses.readFile(resolveToolResultArchivePath(context.workspaceRoot, args.archivePath)),
        display: { kind: "generic", summary: "Read archived tool result", detail: args.archivePath },
        description: `Read archived tool result ${args.archivePath}`,
        approvalRule: `read_tool_result(${args.archivePath})`,
        async execute({ signal }) {
          const envelope = await readToolResultArchive(context.workspaceRoot, args.archivePath, signal);
          let offset = Math.min(args.offset ?? 0, envelope.output.length);
          if (insideSurrogatePair(envelope.output, offset)) offset -= 1;
          const length = args.length ?? defaultLength;
          let nextOffset = Math.min(offset + length, envelope.output.length);
          if (insideSurrogatePair(envelope.output, nextOffset)) {
            // Even length: 1 must advance through an emoji instead of stalling.
            nextOffset += nextOffset === offset + 1 ? 1 : -1;
          }
          const content = envelope.output.slice(offset, nextOffset);
          return {
            archivePath: args.archivePath,
            tool: envelope.tool,
            archivedAt: envelope.archivedAt,
            totalCharacters: envelope.output.length,
            offset,
            nextOffset,
            content,
            hasMore: nextOffset < envelope.output.length
          };
        }
      };
    }
  };
}

function insideSurrogatePair(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}
