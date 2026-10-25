/**
 * 工作区文本搜索工具。
 *
 * Grep 支持字面量或正则、路径与 glob 过滤、上下文和结果分页；文件内容按行流式读取，
 * 不会因为大文件只搜索到固定字节前缀。命中行附带可直接交给 Edit 的 Hashline 锚点。
 */
import path from "node:path";
import { z } from "zod";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import { hashlineAnchor } from "../file/hashline.js";
import { readBoundedUtf8File, sameFileSnapshot, visitBoundUtf8Lines, type FileSnapshot } from "../file/safeFileIo.js";
import type { Tool, ToolContext } from "../types.js";
import { searchRipgrepFiles, maxSearchQueryBytes, RipgrepError, type RipgrepMatch } from "./ripgrep.js";

export interface SearchFilesArgs {
  query: string;
  mode?: "literal" | "regex";
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  offset?: number;
  limit?: number;
}

export interface SearchContextLine {
  line: number;
  text: string;
}

export interface SearchFilesMatch {
  path: string;
  line: number;
  /** One-based original UTF-16 column; casing-generated marks belong to their source letter. */
  column: number;
  anchor: string;
  text: string;
  before: SearchContextLine[];
  after: SearchContextLine[];
}

export interface SearchFilesResult {
  matches: SearchFilesMatch[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  scannedFiles: number;
  unreadableFiles?: string[];
  unreadableDirectories?: string[];
  fileLimitReached?: boolean;
}

const defaultLimit = 50;
const maxLimit = 200;
const maxScannedFiles = 10_000;

const searchSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["literal", "regex"]).optional(),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  caseSensitive: z.boolean().optional(),
  contextLines: z.number().int().min(0).max(10).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(maxLimit).optional()
}) satisfies z.ZodType<SearchFilesArgs>;

export function createSearchFilesTool(context: ToolContext): Tool<SearchFilesArgs, SearchFilesResult> {
  return {
    name: "Grep",
    description: "Search complete UTF-8 workspace files using ripgrep. Supports literal text or ripgrep regular expressions, workspace-relative path and glob filters, case control, context lines, and offset/limit pagination. Every match includes a Hashline anchor for Edit.",
    promptSnippet: "Search workspace text with filters, context, pagination, and Edit anchors",
    promptGuidelines: [
      "Use literal mode for exact text and regex mode only when pattern syntax is needed",
      "Use path or glob to narrow broad searches; continue with nextOffset when hasMore is true",
      "unreadableFiles, unreadableDirectories or fileLimitReached means the search is incomplete even when hasMore is false",
      "A Grep anchor can be passed to Edit only while that exact file line remains unchanged"
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Single-line literal text or ripgrep regular expression (up to 64 KiB). Regex uses Rust syntax, without lookaround or backreferences." },
        mode: { type: "string", enum: ["literal", "regex"], description: "Search interpretation. Defaults to literal." },
        path: { type: "string", minLength: 1, description: "Workspace-relative directory to search. Defaults to the workspace root." },
        glob: { type: "string", minLength: 1, description: "Optional glob matched against workspace-relative file paths." },
        caseSensitive: { type: "boolean", description: "Whether matching is case-sensitive. Defaults to true." },
        contextLines: { type: "integer", minimum: 0, maximum: 10, description: "Lines of context before and after each match. Defaults to 0." },
        offset: { type: "integer", minimum: 0, description: "Number of matching lines to skip. Defaults to 0." },
        limit: { type: "integer", minimum: 1, maximum: maxLimit, description: `Maximum matches to return. Defaults to ${String(defaultLimit)}.` }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: searchSchema,
    capability: "filesystem.search",
    risk: "read",
    resolveExecution(args) {
      const searchRoot = resolveWorkspaceDirectory(context.workspaceRoot, args.path ?? ".", context.ignore);
      const relativeRoot = toWorkspaceRelative(context.workspaceRoot, searchRoot).split(path.sep).join("/");
      const mode = args.mode ?? "literal";
      const caseSensitive = args.caseSensitive ?? true;
      if (Buffer.byteLength(args.query, "utf8") > maxSearchQueryBytes) throw new RipgrepError("Grep query exceeds its 64 KiB limit.");
      if (args.query.includes("\n") || args.query.includes("\0")) throw new RipgrepError("Grep queries must be a single line without NUL bytes.");
      const glob = args.glob?.trim();
      if (args.glob !== undefined && !glob) throw new Error("Grep requires a non-empty glob.");
      if (glob) path.matchesGlob("validation-path", glob);
      return {
        accesses: ToolAccesses.searchTree(searchRoot),
        display: { kind: "file_io", operation: "search", path: args.path ?? ".", detail: args.query },
        description: `Search ${args.path ?? "."} for ${args.query}`,
        approvalRule: `Grep(${args.query})`,
        async execute({ signal }) {
          signal?.throwIfAborted();
          const currentRoot = resolveWorkspaceDirectory(context.workspaceRoot, args.path ?? ".", context.ignore);
          if (currentRoot !== searchRoot) throw new Error("The search root changed after the tool call was prepared.");
          const offset = args.offset ?? 0;
          const limit = args.limit ?? defaultLimit;
          const contextLines = args.contextLines ?? 0;
          const unreadableDirectories: string[] = [];
          const candidates = await scanWorkspaceFiles(
            context.workspaceRoot,
            context.ignore,
            maxScannedFiles + 1,
            signal,
            (relativePath) => fileInScope(relativePath, relativeRoot, glob),
            relativeRoot === "." ? undefined : (relativePath) => directoryInScope(relativePath, relativeRoot),
            (relativePath) => unreadableDirectories.push(relativePath.split(path.sep).join("/"))
          );
          const fileLimitReached = candidates.length > maxScannedFiles;
          const matches: SearchFilesMatch[] = [];
          const unreadableFiles: string[] = [];
          let matchedLines = 0;
          let scannedFiles = 0;
          let hasMore = false;
          let stopSearch = false;

          const eligible = candidates.slice(0, maxScannedFiles);
          for (let batchStart = 0; batchStart < eligible.length && !stopSearch;) {
            const snapshots = new Map<string, FileSnapshot>();
            const batch: string[] = [];
            let pathBytes = 0;
            while (batchStart < eligible.length && batch.length < 64 && pathBytes < 16_384) {
              const file = eligible[batchStart++]!;
              pathBytes += Buffer.byteLength(file);
              batch.push(file);
              try {
                snapshots.set(file, (await readBoundedUtf8File(resolveWorkspacePath(context.workspaceRoot, file, context.ignore), 0, "truncate", signal)).snapshot);
              } catch {
                signal?.throwIfAborted();
              }
            }
            const nativeMatches = snapshots.size ? await searchRipgrepFiles({
              query: args.query, mode, caseSensitive, workspaceRoot: context.workspaceRoot,
              files: [...snapshots.keys()], maxMatches: offset + limit - matchedLines + 1, signal
            }) : new Map<string, RipgrepMatch[]>();
            for (const file of batch) {
              signal?.throwIfAborted();
              scannedFiles += 1;
              const initial = snapshots.get(file);
              if (!initial) { unreadableFiles.push(file); continue; }
              const found = nativeMatches.get(file);
              if (!found?.length) continue;
              const hits = new Map(found.map((hit) => [hit.line, hit]));
              const before: SearchContextLine[] = [];
              const pending: Array<{ match: SearchFilesMatch; remaining: number }> = [];
              const matchesBeforeFile = matches.length;
              const matchedLinesBeforeFile = matchedLines;
              const hasMoreBeforeFile: boolean = hasMore;
              try {
                const visitLine = (line: string, lineNumber: number, hit: number | undefined): boolean | void => {
                  for (const item of pending) {
                    if (item.remaining < 1) continue;
                    item.match.after.push({ line: lineNumber, text: line });
                    item.remaining -= 1;
                  }
                  if (hit !== undefined) {
                    if (matchedLines >= offset + limit) {
                      hasMore = true;
                    } else if (matchedLines >= offset) {
                      const match: SearchFilesMatch = {
                        path: file,
                        line: lineNumber,
                        column: hit + 1,
                        anchor: hashlineAnchor(line, lineNumber),
                        text: line,
                        before: [...before],
                        after: []
                      };
                      matches.push(match);
                      if (contextLines > 0) pending.push({ match, remaining: contextLines });
                    }
                    matchedLines += 1;
                  }
                  before.push({ line: lineNumber, text: line });
                  if (before.length > contextLines) before.shift();
                  if (hasMore && pending.every((item) => item.remaining === 0)) {
                    stopSearch = true;
                    return false;
                  }
                };
                const verified = await visitBoundUtf8Lines(resolveWorkspacePath(context.workspaceRoot, file, context.ignore), (line, lineNumber) => {
                  const hit = hits.get(lineNumber);
                  // ripgrep removes one initial UTF-8 BOM; preserve raw text and Edit anchors.
                  const bomOffset = hit && lineNumber === 1 && line.startsWith("\uFEFF") ? 1 : 0;
                  if (hit && hit.text !== line.slice(bomOffset)) throw new Error("File changed after the native search.");
                  return visitLine(line, lineNumber, hit ? hit.column - 1 + bomOffset : undefined);
                }, signal);
                if (!sameFileSnapshot(initial, verified.snapshot)) throw new Error("File changed after the search was prepared.");
              } catch (error) {
                if (signal?.aborted || error instanceof RipgrepError) throw error;
                matches.length = matchesBeforeFile;
                matchedLines = matchedLinesBeforeFile;
                hasMore = hasMoreBeforeFile;
                stopSearch = false;
                unreadableFiles.push(file);
              }
              if (stopSearch) break;
            }
          }
          const result: SearchFilesResult = {
            matches,
            offset,
            limit,
            hasMore,
            nextOffset: hasMore ? offset + matches.length : undefined,
            scannedFiles,
            unreadableFiles: unreadableFiles.length > 0 ? unreadableFiles : undefined,
            fileLimitReached: fileLimitReached || undefined
          };
          if (unreadableDirectories.length) result.unreadableDirectories = unreadableDirectories;
          return result;
        }
      };
    }
  };
}


function fileInScope(relativePath: string, relativeRoot: string, glob: string | undefined): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const inRoot = relativeRoot === "." || normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`);
  return inRoot && (glob === undefined || path.matchesGlob(normalized, glob));
}

function directoryInScope(relativePath: string, relativeRoot: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  // Walk from the workspace root as before, including ancestors of file or missing scopes.
  return normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`) || relativeRoot.startsWith(`${normalized}/`);
}
