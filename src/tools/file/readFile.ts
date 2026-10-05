/**
 * 文件读取工具模块。
 *
 * `Read` 读取工作区内通过路径校验的 UTF-8 文本文件；桌面端还可读取由应用保存的
 * `@attachments/` 虚拟路径，但不能借此访问任意用户目录。
 */
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import { formatHashlineLine } from "./hashline.js";
import { visitBoundUtf8Lines } from "./safeFileIo.js";

export interface ReadFileArgs {
  // 工具层只接受相对路径；resolveWorkspacePath 会拒绝 ../ 和被忽略的目录。
  path: string;
  startLine?: number;
  lineCount?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  nextStartLine?: number;
}

const defaultLineCount = 200;
const maxLineCount = 2_000;
const maxPageBytes = 1024 * 1024;

export function createReadFileTool(context: ToolContext, hashline = false): Tool<ReadFileArgs, ReadFileResult> {
  // 实验模式才附加编辑锚点；原始路径仍用于展示和后续 Edit。
  return {
    name: "Read",
    description: `Read a page of a UTF-8 workspace file or supplied attachment.${hashline ? " Lines are returned as LINE#HASH:text for use by Edit." : " Returns the original text without edit tags."} Use startLine and lineCount to page through large files.`,
    promptSnippet: hashline ? "Read UTF-8 file contents with LINE#HASH edit anchors" : "Read UTF-8 file contents",
    promptGuidelines: [hashline ? "Use Read before Edit and pass its LINE#HASH anchors unchanged; read again when an anchor is stale" : "Read before editing and copy the exact text including whitespace"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative UTF-8 text file path to read." },
        startLine: { type: "integer", minimum: 1, description: "First one-based file line to return. Defaults to 1." },
        lineCount: { type: "integer", minimum: 1, maximum: maxLineCount, description: `Maximum lines to return. Defaults to ${String(defaultLineCount)}.` }
      },
      required: ["path"],
      additionalProperties: false
    },
    schema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      lineCount: z.number().int().min(1).max(maxLineCount).optional()
    }),
    capability: "filesystem.read",
    risk: "read",
    resolveExecution(args) {
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
  const attachmentPrefix = "@attachments/";
  if (!requestedPath.startsWith(attachmentPrefix)) {
    return resolveWorkspacePath(context.workspaceRoot, requestedPath, context.ignore);
  }
  if (!context.attachmentRoot) throw new Error("No attachments are available for this session.");
  const relativePath = requestedPath.slice(attachmentPrefix.length);
  return resolveWorkspacePath(context.attachmentRoot, relativePath, []);
}
