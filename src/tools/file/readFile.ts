/**
 * 文件读取工具模块。
 *
 * `Read` 读取工作区内通过路径校验的 UTF-8 文本文件；桌面端还可读取由应用保存的
 * `@attachments/` 虚拟路径。工具结果归档使用受限的虚拟引用和字符分页。
 */
import { z } from "zod";
import { isToolResultArchiveReference, readToolResultArchive, resolveToolResultArchivePath } from "../../session/toolResultArchive.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { formatHashlineLine } from "./hashline.js";
import { visitBoundUtf8Lines } from "./safeFileIo.js";

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  lineCount?: number;
  offset?: number;
  length?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  nextStartLine?: number;
}

export interface ReadArchivedResult {
  path: string;
  tool: string;
  archivedAt: string;
  totalCharacters: number;
  offset: number;
  /** Next UTF-16 code-unit offset; pass it unchanged for the next page. */
  nextOffset: number;
  content: string;
  hasMore: boolean;
}

const defaultArchiveLength = 16_000;
const maxArchiveLength = 200_000;
const defaultLineCount = 200;
const maxLineCount = 2_000;
const maxPageBytes = 1024 * 1024;

export function createReadFileTool(context: ToolContext, hashline = false): Tool<ReadFileArgs, ReadFileResult | ReadArchivedResult> {
  // 实验模式才附加编辑锚点；原始路径仍用于展示和后续 Edit。
  return {
    name: "Read",
    description: `Read a page of a UTF-8 workspace file, supplied attachment, or archived tool result.${hashline ? " Lines are returned as LINE#HASH:text for use by Edit." : " Returns the original text without edit tags."} Use startLine and lineCount for files. For .biny/tool-results references, Read returns the original archived output without edit tags; use offset and length (UTF-16 code units, default 16000, max 200000), then nextOffset to continue. Surrogate pairs are preserved.`,
    promptSnippet: hashline ? "Read UTF-8 file contents with LINE#HASH edit anchors" : "Read UTF-8 file contents",
    promptGuidelines: ["When a result reports archivePath, pass it as Read.path and page with offset and length", hashline ? "Use Read before Edit and pass its LINE#HASH anchors unchanged; read again when an anchor is stale" : "Read before editing and copy the exact text including whitespace"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative UTF-8 file path, supplied attachment path, or .biny/tool-results reference." },
        startLine: { type: "integer", minimum: 1, description: "First one-based file line to return. Defaults to 1." },
        lineCount: { type: "integer", minimum: 1, maximum: maxLineCount, description: `Maximum lines to return. Defaults to ${String(defaultLineCount)}.` },
        offset: { type: "integer", minimum: 0, description: "Archived results only: UTF-16 code-unit offset, default 0; rounds back when inside a surrogate pair." },
        length: { type: "integer", minimum: 1, maximum: maxArchiveLength, description: "Archived results only: maximum UTF-16 code units, default 16000; length 1 may return a whole surrogate pair." }
      },
      required: ["path"],
      additionalProperties: false
    },
    schema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      lineCount: z.number().int().min(1).max(maxLineCount).optional(),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(maxArchiveLength).optional()
    }),
    capability: "filesystem.read",
    risk: "read",
    resolveExecution(args) {
      const archive = isToolResultArchiveReference(args.path);
      if (archive && (args.startLine !== undefined || args.lineCount !== undefined)) {
        throw new Error("Archived tool results use offset and length, not startLine and lineCount.");
      }
      if (!archive && (args.offset !== undefined || args.length !== undefined)) {
        throw new Error("Workspace files and attachments use startLine and lineCount, not offset and length.");
      }
      const absolutePath = resolveReadablePath(context, args.path);
      return {
        accesses: ToolAccesses.readFile(absolutePath),
        display: { kind: "file_io", operation: "read", path: args.path },
        description: `Read ${args.path}`,
        approvalRule: `Read(${args.path})`,
        async execute({ signal }) {
          signal?.throwIfAborted();
          const currentPath = resolveReadablePath(context, args.path);
          if (currentPath !== absolutePath) throw new Error("The read target changed after the tool call was prepared.");
          if (archive) {
            const envelope = await readToolResultArchive(context.workspaceRoot, args.path, signal);
            let offset = Math.min(args.offset ?? 0, envelope.output.length);
            if (insideSurrogatePair(envelope.output, offset)) offset -= 1;
            let nextOffset = Math.min(offset + (args.length ?? defaultArchiveLength), envelope.output.length);
            if (insideSurrogatePair(envelope.output, nextOffset)) {
              nextOffset += nextOffset === offset + 1 ? 1 : -1;
            }
            return {
              path: args.path,
              tool: envelope.tool,
              archivedAt: envelope.archivedAt,
              totalCharacters: envelope.output.length,
              offset,
              nextOffset,
              content: envelope.output.slice(offset, nextOffset),
              hasMore: nextOffset < envelope.output.length
            };
          }
          const startLine = args.startLine ?? 1;
          const lineCount = args.lineCount ?? defaultLineCount;
          const formattedLines: string[] = [];
          let pageBytes = 0;
          const { hasRemaining: hasMore } = await visitBoundUtf8Lines(absolutePath, (line, lineNumber) => {
            if (lineNumber < startLine) return;
            const formatted = hashline ? formatHashlineLine(line, lineNumber) : line;
            pageBytes += Buffer.byteLength(formatted, "utf8") + (formattedLines.length > 0 ? 1 : 0);
            if (pageBytes > maxPageBytes) {
              throw new Error(`Read page exceeds the ${String(maxPageBytes)}-byte output limit; request fewer lines.`);
            }
            formattedLines.push(formatted);
            return formattedLines.length < lineCount;
          }, signal);
          const endLine = formattedLines.length === 0 ? startLine - 1 : startLine + formattedLines.length - 1;
          return {
            path: args.path,
            content: formattedLines.join("\n"),
            startLine,
            endLine,
            hasMore,
            nextStartLine: hasMore ? endLine + 1 : undefined
          };
        }
      };
    }
  };
}

function resolveReadablePath(context: ToolContext, requestedPath: string): string {
  if (isToolResultArchiveReference(requestedPath)) return resolveToolResultArchivePath(context.workspaceRoot, requestedPath);
  const attachmentPrefix = "@attachments/";
  if (!requestedPath.startsWith(attachmentPrefix)) {
    return resolveWorkspacePath(context.workspaceRoot, requestedPath, context.ignore);
  }
  if (!context.attachmentRoot) throw new Error("No attachments are available for this session.");
  const relativePath = requestedPath.slice(attachmentPrefix.length);
  return resolveWorkspacePath(context.attachmentRoot, relativePath, []);
}

function insideSurrogatePair(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}
