/**
 * 工作区文件枚举工具。
 *
 * `Glob` 以稳定的路径顺序返回文件，并通过最后一条路径作为游标继续分页。扫描始终复用
 * workspace ignore 规则；path 只缩小搜索根，pattern 仍匹配工作区相对路径。
 */
import path from "node:path";
import { z } from "zod";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { resolveWorkspaceDirectory, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

export interface ListFilesArgs {
  path?: string;
  pattern?: string;
  cursor?: string;
  limit?: number;
}

export interface ListFilesResult {
  files: string[];
  hasMore: boolean;
  nextCursor?: string;
  unreadableDirectories?: string[];
}

const defaultLimit = 200;
const maxLimit = 1_000;

const listSchema = z.object({
  path: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(maxLimit).optional()
}) satisfies z.ZodType<ListFilesArgs>;

export function createListFilesTool(context: ToolContext): Tool<ListFilesArgs, ListFilesResult> {
  return {
    name: "Glob",
    description: "List workspace files in stable path order. Supports a workspace-relative root path, glob filtering, and cursor pagination.",
    promptSnippet: "List workspace files with root, glob, and cursor pagination",
    promptGuidelines: [
      "Continue with nextCursor when hasMore is true; pattern matches workspace-relative paths",
      "unreadableDirectories means the listing is incomplete even when hasMore is false"
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative directory to list. Defaults to the workspace root." },
        pattern: { type: "string", minLength: 1, description: "Optional glob matched against workspace-relative file paths." },
        cursor: { type: "string", minLength: 1, description: "Exclusive workspace-relative path cursor returned by a previous page." },
        limit: { type: "integer", minimum: 1, maximum: maxLimit, description: `Maximum files to return. Defaults to ${String(defaultLimit)}.` }
      },
      required: [],
      additionalProperties: false
    },
    schema: listSchema,
    capability: "filesystem.list",
    risk: "read",
    resolveExecution(args) {
      const listRoot = resolveWorkspaceDirectory(context.workspaceRoot, args.path ?? ".", context.ignore);
      const relativeRoot = normalizePath(toWorkspaceRelative(context.workspaceRoot, listRoot));
      const pattern = args.pattern?.trim();
      const cursor = args.cursor;
      if (args.pattern !== undefined && !pattern) throw new Error("Glob requires a non-empty pattern.");
      if (args.cursor !== undefined && !cursor) throw new Error("Glob requires a non-empty cursor.");
      if (pattern) path.matchesGlob("validation-path", pattern);
      return {
        accesses: ToolAccesses.searchTree(listRoot),
        display: { kind: "file_io", operation: "list", path: args.path ?? ".", detail: pattern ?? `limit ${String(args.limit ?? defaultLimit)}` },
        description: pattern ? `Expand ${pattern} under ${args.path ?? "."}` : `List ${args.path ?? "."}`,
        approvalRule: "Glob",
        async execute({ signal }) {
          signal?.throwIfAborted();
          const currentRoot = resolveWorkspaceDirectory(context.workspaceRoot, args.path ?? ".", context.ignore);
          if (currentRoot !== listRoot) throw new Error("The list root changed after the tool call was prepared.");
          const limit = args.limit ?? defaultLimit;
          const unreadableDirectories: string[] = [];
          const candidates = await scanWorkspaceFiles(
            context.workspaceRoot,
            context.ignore,
            limit + 1,
            signal,
            (relativePath) => {
              const normalized = normalizePath(relativePath);
              return isUnderRoot(normalized, relativeRoot)
                && (pattern === undefined || path.matchesGlob(normalized, pattern))
                && (cursor === undefined || normalized > cursor);
            },
            relativeRoot === "." ? undefined : (relativePath) => {
              const normalized = normalizePath(relativePath);
              return isUnderRoot(normalized, relativeRoot) || isUnderRoot(relativeRoot, normalized);
            },
            (relativePath) => {
              const normalized = normalizePath(relativePath);
              if (isUnderRoot(normalized, relativeRoot) || isUnderRoot(relativeRoot, normalized)) unreadableDirectories.push(normalized);
            }
          );
          const files = candidates.slice(0, limit).map(normalizePath);
          const hasMore = candidates.length > limit;
          const result: ListFilesResult = {
            files,
            hasMore,
            nextCursor: hasMore ? files.at(-1) : undefined
          };
          if (unreadableDirectories.length) result.unreadableDirectories = unreadableDirectories;
          return result;
        }
      };
    }
  };
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isUnderRoot(relativePath: string, relativeRoot: string): boolean {
  return relativeRoot === "." || relativePath === relativeRoot || relativePath.startsWith(`${relativeRoot}/`);
}
