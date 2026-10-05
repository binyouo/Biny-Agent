/** 原生结构化 patch 的输入适配；单文件执行继续复用 Write/Edit 的权限、CAS 和提交回调。 */
import { applyDiff } from "@openai/agents-core/utils";
import { z } from "zod";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { Tool, ToolContext } from "../types.js";
import type { FileChangeResult } from "./fileChange.js";
import { createEditFileTool } from "./editFile.js";
import { createWriteFileTool, readOptionalFile } from "./writeFile.js";
import { sameOptionalFileSnapshot } from "./safeFileIo.js";

export const patchArgsSchema = z.object({
  callId: z.string().min(1),
  operation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create_file"), path: z.string().min(1), diff: z.string() }).strict(),
    z.object({ type: z.literal("update_file"), path: z.string().min(1), diff: z.string() }).strict(),
    z.object({ type: z.literal("delete_file"), path: z.string().min(1) }).strict()
  ])
}).strict();
export type PatchArgs = z.infer<typeof patchArgsSchema>;

export function patchContent(content: string, operation: PatchArgs["operation"]): string {
  return operation.type === "delete_file" ? "" : applyDiff(content, operation.diff, operation.type === "create_file" ? "create" : "default");
}

export function createApplyPatchTool(context: ToolContext): Tool<PatchArgs, FileChangeResult> {
  return {
    name: "apply_patch",
    description: "Apply one structured create_file, update_file, or delete_file operation in the workspace.",
    promptSnippet: "Create, update, or delete one file using a structured patch",
    promptGuidelines: ["Use apply_patch for file changes. Read before updating; do not retry with a different editing protocol after a failure."],
    providerTool: "openai-apply-patch",
    parameters: { type: "object", properties: { callId: { type: "string" }, operation: { type: "object", properties: { type: { type: "string", enum: ["create_file", "update_file", "delete_file"] }, path: { type: "string" }, diff: { type: "string" } }, required: ["type", "path"], additionalProperties: false } }, required: ["callId", "operation"], additionalProperties: false },
    schema: patchArgsSchema,
    capability: "filesystem.edit",
    risk: "write",
    async resolveExecution({ callId, operation }) {
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, operation.path, context.ignore);
      const before = await readOptionalFile(absolutePath, undefined, operation.type === "update_file");
      if (operation.type === "create_file" ? before.snapshot !== null : before.snapshot === null) {
        throw new Error(operation.type === "create_file" ? "Patch create target already exists." : "Patch target does not exist.");
      }
      const execution = operation.type === "delete_file"
        ? await createEditFileTool(context).resolveExecution({ operation: "delete", path: operation.path })
        : await createWriteFileTool(context).resolveExecution({ path: operation.path, content: patchContent(before.content, operation) });
      if ("isError" in execution) return execution;
      return {
        ...execution,
        fileChange: { operation: operation.type === "create_file" ? "create" : operation.type === "update_file" ? "update" : "delete", path: execution.fileChange!.path },
        approvalRule: `apply_patch(${operation.type}:${operation.path})`,
        async execute(input) {
          if (callId !== input.toolCallId) throw new Error("Patch callId does not match the dispatched tool call.");
          if (input.approvedFile && (input.approvedFile.path !== absolutePath || !sameOptionalFileSnapshot(input.approvedFile.snapshot, before.snapshot))) throw new Error("The approved file does not match the prepared patch target.");
          const current = await readOptionalFile(absolutePath, input.signal, operation.type === "update_file");
          if (!sameOptionalFileSnapshot(before.snapshot, current.snapshot)) throw new Error("Patch target changed after preparation. Read and prepare a new patch.");
          return await execution.execute({ ...input, approvedFile: { path: absolutePath, snapshot: before.snapshot } });
        }
      };
    }
  };
}
