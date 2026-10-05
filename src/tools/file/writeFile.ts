/**
 * 文件写入工具模块。
 *
 * `Write` 会在工作区内创建必要父目录并写入完整文件内容。是否允许写入、如何展示 diff、
 * 以及用户是否确认，都由 agent loop 在调用这个工具前完成。
 */
import { z } from "zod";
import { createUnifiedDiff } from "../../utils/diff.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import type { FileChangeResult } from "./fileChange.js";
import { atomicWriteWorkspaceUtf8File, readUtf8FileForEdit } from "./safeFileIo.js";

export interface WriteFileArgs {
  // path 可以创建新文件及其缺失父目录，所有目录仍需通过 workspace canonical 校验。
  path: string;
  content: string;
}

export function createWriteFileTool(context: ToolContext): Tool<WriteFileArgs, FileChangeResult> {
  // Write 的权限确认在 agent loop 完成；这里保持纯粹的文件写入实现。
  return {
    name: "Write",
    description: "Atomically write a UTF-8 file in the workspace, safely creating missing parent directories.",
    promptSnippet: "Create a new file or replace a file with complete UTF-8 content",
    promptGuidelines: ["Use Write for new files or intentional full rewrites; use Edit for localized changes"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path to create or overwrite." },
        content: { type: "string", description: "Complete UTF-8 file content to write." }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    capability: "filesystem.write",
    risk: "write",
    resolveExecution(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const path = toWorkspaceRelative(context.workspaceRoot, absolutePath);
      return {
        accesses: ToolAccesses.writeFile(absolutePath),
        fileChange: { operation: "write", path },
        fileChangeIsResult: true,
        display: { kind: "file_io", operation: "write", path, content: args.content },
        description: `Write ${path}`,
        retrySafety: "unsafe",
        approvalRule: `Write(${args.path})`,
        async execute({ signal, approvedFile, onFileChangeCommitted, onExecutionState }) {
          signal?.throwIfAborted();
          const currentPath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          if (currentPath !== absolutePath) throw new Error("The write target changed after the tool call was prepared.");
          if (approvedFile && approvedFile.path !== absolutePath) {
            throw new Error("The approved write target does not match the prepared tool target.");
          }
          const before = await readOptionalFile(absolutePath, signal);
          const change: FileChangeResult["change"] = {
            operation: before.snapshot ? "update" : "create",
            path,
            committed: true,
            diff: createUnifiedDiff(path, before.content, args.content),
            bytes: Buffer.byteLength(args.content, "utf8")
          };
          await atomicWriteWorkspaceUtf8File(
            context.workspaceRoot,
            absolutePath,
            args.content,
            approvedFile ? approvedFile.snapshot : before.snapshot,
            signal,
            async (evidence) => {
              await onFileChangeCommitted?.(change);
              if (!onFileChangeCommitted) onExecutionState?.("side_effect_committed", evidence);
            }
          );
          return { change };
        }
      };
    }
  };
}

export async function readOptionalFile(filePath: string, signal?: AbortSignal, requireValidUtf8 = false): Promise<{
  content: string;
  snapshot: Awaited<ReturnType<typeof readUtf8FileForEdit>>["snapshot"] | null;
}> {
  try {
    return await readUtf8FileForEdit(filePath, signal, requireValidUtf8);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { content: "", snapshot: null };
    }
    throw error;
  }
}
