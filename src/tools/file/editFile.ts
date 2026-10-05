/**
 * 单文件变更工具，默认搜索替换，实验模式使用 Hashline 锚点。
 *
 * update、delete、move 共用同一准备和结果协议；每次调用只提交一个源文件，避免制造跨文件伪事务。
 */
import { z } from "zod";
import { createUnifiedDiff } from "../../utils/diff.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";
import type { FileChangeResult } from "./fileChange.js";
import { applyHashlineEdits, type HashlineEdit } from "./hashline.js";
import { applyStringEdit } from "./stringEdit.js";
import {
  atomicWriteUtf8File,
  deleteBoundRegularFile,
  maxEditFileBytes,
  moveBoundRegularFile,
  readUtf8FileForEdit,
  sameFileSnapshot,
  sameOptionalFileSnapshot,
  snapshotRegularFile
} from "./safeFileIo.js";

export type EditArgs =
  | { operation: "update"; path: string; edits: HashlineEdit[] }
  | { operation: "update"; path: string; old_string: string; new_string: string; replace_all: boolean }
  | { operation: "delete"; path: string }
  | { operation: "move"; path: string; to: string };

const hashlineEditsSchema = z.array(z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), pos: z.string().min(1), end: z.string().min(1).optional(), lines: z.array(z.string()) }),
  z.object({ op: z.literal("append"), pos: z.string().min(1).optional(), lines: z.array(z.string()) }),
  z.object({ op: z.literal("prepend"), pos: z.string().min(1).optional(), lines: z.array(z.string()) })
])).min(1);

const hashlineEditArgsSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("update"), path: z.string().min(1), edits: hashlineEditsSchema }),
  z.object({ operation: z.literal("delete"), path: z.string().min(1) }),
  z.object({ operation: z.literal("move"), path: z.string().min(1), to: z.string().min(1) })
]);
const stringEditArgsSchema = z.union([
  z.object({ operation: z.literal("update").default("update"), path: z.string().min(1), old_string: z.string().min(1), new_string: z.string().default(""), replace_all: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("delete"), path: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("move"), path: z.string().min(1), to: z.string().min(1) }).strict()
]);
export const editArgsSchema = z.union([hashlineEditArgsSchema, stringEditArgsSchema]);

export function createEditFileTool(context: ToolContext, hashline = false): Tool<EditArgs, FileChangeResult> {
  return {
    name: "Edit",
    description: `Update, delete, or move one UTF-8 workspace file. ${hashline ? "update uses Hashline anchors from Read; stale anchors fail without writing." : "Replace old_string with new_string. Read first; ambiguous matches require more context or replace_all. operation defaults to update."} delete and move reject symbolic links. Files are limited to ${String(maxEditFileBytes)} bytes.`,
    promptSnippet: "Update, delete, or move one workspace file",
    promptGuidelines: [
      hashline ? "Use operation update after Read and copy LINE#HASH anchors exactly" : "Read first and copy old_string exactly, including whitespace; new_string is the final replacement text",
      hashline ? "Group independent changes to one file into one Edit call; use lines arrays" : "Use replace_all only when every matching occurrence should change",
      "Use operation delete to remove a file, operation move to rename it, and Write only for new files or intentional full rewrites"
    ],
    parameters: hashline ? {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["update", "delete", "move"], description: "File operation to perform." },
        path: { type: "string", minLength: 1, description: "Workspace-relative source file path." },
        to: { type: "string", minLength: 1, description: "Workspace-relative destination path for move." },
        edits: {
          type: "array",
          minItems: 1,
          description: "Atomic Hashline operations for update.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace", "append", "prepend"] },
              pos: { type: "string", minLength: 1, description: "LINE#HASH anchor from Read." },
              end: { type: "string", minLength: 1, description: "Inclusive end anchor for replace." },
              lines: { type: "array", items: { type: "string" }, description: "Replacement lines without newline characters." }
            },
            required: ["op", "lines"],
            additionalProperties: false
          }
        }
      },
      required: ["operation", "path"],
      additionalProperties: false
    } : {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        old_string: { type: "string", minLength: 1 },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Replace every occurrence; defaults to false." },
        operation: { type: "string", enum: ["update", "delete", "move"], description: "Defaults to update." },
        to: { type: "string" }
      },
      required: ["path"],
      additionalProperties: false
    },
    schema: hashline ? hashlineEditArgsSchema : stringEditArgsSchema,
    capability: "filesystem.edit",
    risk: "write",
    async resolveExecution(args) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
      const path = toWorkspaceRelative(context.workspaceRoot, absolutePath);
      const absoluteDestination = args.operation === "move"
        ? resolveWorkspacePath(context.workspaceRoot, args.to, context.ignore)
        : undefined;
      const destinationPath = absoluteDestination
        ? toWorkspaceRelative(context.workspaceRoot, absoluteDestination)
        : undefined;
      const preparedSnapshot = args.operation === "update" ? undefined : await snapshotRegularFile(absolutePath);
      return {
        accesses: absoluteDestination
          ? [...ToolAccesses.readWriteFile(absolutePath), ...ToolAccesses.writeFile(absoluteDestination)]
          : ToolAccesses.readWriteFile(absolutePath),
        fileChange: { operation: args.operation, path, destinationPath },
        fileChangeIsResult: true,
        display: {
          kind: "file_io",
          operation: args.operation,
          path,
          destinationPath,
          detail: args.operation === "update" && "edits" in args ? `${String(args.edits.length)} operations` : undefined
        },
        description: args.operation === "move" ? `Move ${path} to ${destinationPath ?? args.to}` : `${capitalize(args.operation)} ${path}`,
        retrySafety: "unsafe",
        approvalRule: args.operation === "move" ? `Edit(move:${path}->${destinationPath ?? args.to})` : `Edit(${args.operation}:${path})`,
        async execute({ signal, approvedFile, onFileChangeCommitted, onExecutionState }) {
          signal?.throwIfAborted();
          const currentPath = resolveWorkspacePath(context.workspaceRoot, args.path, context.ignore);
          if (currentPath !== absolutePath) throw new Error("The edit target changed after the tool call was prepared.");
          if (approvedFile && approvedFile.path !== absolutePath) throw new Error("The approved edit target does not match the prepared tool target.");
          const { content, snapshot } = await readUtf8FileForEdit(absolutePath, signal, args.operation === "update");
          if (approvedFile && !sameOptionalFileSnapshot(approvedFile.snapshot, snapshot)) {
            throw new Error("The edit target changed after permission approval.");
          }
          if (preparedSnapshot && !sameFileSnapshot(preparedSnapshot, snapshot)) {
            throw new Error("The edit target changed after the tool call was prepared.");
          }
          const commit = (change: FileChangeResult["change"]) => async (evidence: string): Promise<void> => {
            await onFileChangeCommitted?.(change);
            if (!onFileChangeCommitted) onExecutionState?.("side_effect_committed", evidence);
          };
          if (args.operation === "delete") {
            const change: FileChangeResult["change"] = { operation: "delete", path, committed: true, diff: createUnifiedDiff(path, content, "") };
            await deleteBoundRegularFile(absolutePath, snapshot, signal, commit(change));
            return { change };
          }
          if (args.operation === "move") {
            if (resolveWorkspacePath(context.workspaceRoot, args.to, context.ignore) !== absoluteDestination) throw new Error("The move destination changed after preparation.");
            const change: FileChangeResult["change"] = { operation: "move", path, destinationPath, committed: true, diff: moveDiff(path, destinationPath!) };
            await moveBoundRegularFile(absolutePath, absoluteDestination!, snapshot, signal, commit(change));
            return { change };
          }
          const next = "edits" in args ? applyHashlineEdits(content, args.edits) : applyStringEdit(content, args.old_string, args.new_string, args.replace_all);
          const change: FileChangeResult["change"] = {
            operation: "update", path, committed: true,
            diff: createUnifiedDiff(path, content, next.content),
            edits: "edits" in args ? args.edits.length : (next as ReturnType<typeof applyStringEdit>).replacements, firstChangedLine: next.firstChangedLine
          };
          signal?.throwIfAborted();
          await atomicWriteUtf8File(
            absolutePath,
            next.content,
            approvedFile ? approvedFile.snapshot : snapshot,
            signal,
            commit(change)
          );
          return { change };
        }
      };
    }
  };
}

function moveDiff(from: string, to: string): string {
  return `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
