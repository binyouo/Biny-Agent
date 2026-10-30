/** 原生结构化 patch 的输入适配；单文件执行继续复用 Write/Edit 的权限、CAS 和提交回调。 */
import { applyDiff } from "@openai/agents-core/utils";
import { z } from "zod";
import { resolveWorkspaceFileEntry, resolveWorkspacePath } from "../../workspace/resolvePath.js";
import type { Tool, ToolContext } from "../types.js";
import { zodToolInput } from "../zodToolInput.js";
import { fileChangeOutputSchema, type FileChangeResult } from "./fileChange.js";
import { createEditFileTool } from "./editFile.js";
import { createWriteFileTool, readOptionalFile } from "./writeFile.js";
import { sameOptionalFileSnapshot } from "./safeFileIo.js";

export const patchArgsSchema = z.object({
  callId: z.string().min(1).describe("Must equal the dispatched tool call ID. In run_script this is supplied by the host; pass only operation."),
  operation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create_file"), path: z.string().min(1).describe("Workspace-relative path; must not exist"), diff: z.string().describe("New file lines prefixed with +, for example +hello\\n. An empty diff creates an empty file.") }).strict(),
    z.object({ type: z.literal("update_file"), path: z.string().min(1).describe("Workspace-relative existing UTF-8 file path"), diff: z.string().describe("Patch hunks with @@ markers, space-prefixed context, - removals, and + additions. Example: @@\\n-old\\n+new\\n") }).strict(),
    z.object({ type: z.literal("delete_file"), path: z.string().min(1).describe("Workspace-relative existing file path to remove; do not supply diff") }).strict()
  ])
}).strict();
export type PatchArgs = z.infer<typeof patchArgsSchema>;

export function patchContent(content: string, operation: PatchArgs["operation"]): string {
  return operation.type === "delete_file" ? "" : applyDiff(content, operation.diff, operation.type === "create_file" ? "create" : "default");
}

export function createApplyPatchTool(context: ToolContext): Tool<PatchArgs, FileChangeResult> {
  return {
    name: "apply_patch",
    description: [
      "Create, update, or delete one workspace file using a structured operation object. This tool uses JSON, not a freeform multi-file patch.",
      "create_file: supply path and diff with each new line prefixed by +. The target must not exist.",
      "update_file: Read first, then supply path and diff. Hunks use @@ markers, space-prefixed context lines, - removals, and + additions. Do not include ---/+++ file headers or *** Begin Patch / *** End Patch wrappers.",
      "delete_file: supply path only; the target must exist. Do not supply diff.",
      "Each call contains one operation for one file. Returns {change} with operation, path, committed, diff, and operation-specific details. Changed targets fail before writing; inspect the result before retrying."
    ].join("\n\n"),
    promptSnippet: "Create, update, or delete one file using a structured patch",
    promptGuidelines: ["Use apply_patch for file changes. Read before updating; do not retry with a different editing protocol after a failure."],
    providerTool: "openai-apply-patch",
    ...zodToolInput(patchArgsSchema),
    outputSchema: fileChangeOutputSchema,
    capability: "filesystem.edit",
    risk: "write",
    async resolveExecution({ callId, operation }) {
      const resolveSource = operation.type === "delete_file" ? resolveWorkspaceFileEntry : resolveWorkspacePath;
      const absolutePath = resolveSource(context.workspaceRoot, operation.path, context.ignore);
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

