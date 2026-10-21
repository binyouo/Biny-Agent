/** 文件变更在工具准备、权限判断、执行结果和界面投影之间共用的稳定语义。 */
import { z } from "zod";
import { zodSchema } from "ai";
import type { JsonSchema } from "../schema.js";
export type FileChangeOperation = "create" | "update" | "delete" | "move";
export type PreparedFileChangeOperation = "write" | FileChangeOperation;

export interface PreparedFileChange {
  operation: PreparedFileChangeOperation;
  path: string;
  destinationPath?: string;
  /** 缺省为本地；远端来源由宿主绑定，不接受服务端自报。 */
  server?: string;
}

export interface CommittedFileChange {
  operation: FileChangeOperation;
  path: string;
  destinationPath?: string;
  committed: true;
  diff: string;
  bytes?: number;
  edits?: number;
  firstChangedLine?: number;
  server?: string;
}

export const committedFileChangeSchema = z.object({
  operation: z.enum(["create", "update", "delete", "move"]),
  path: z.string().min(1),
  destinationPath: z.string().min(1).optional(),
  committed: z.literal(true),
  diff: z.string(),
  bytes: z.number().int().nonnegative().optional(),
  edits: z.number().int().nonnegative().optional(),
  firstChangedLine: z.number().int().positive().optional(),
  server: z.string().min(1).optional()
}).strict().superRefine((change, context) => {
  if ((change.operation === "move") !== (change.destinationPath !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only move requires destinationPath." });
  }
});

export const fileChangeOutputSchema = zodSchema(z.object({
  change: committedFileChangeSchema.describe("Committed file change: operation, workspace-relative paths, diff, and operation-specific details.")
}).strict()).jsonSchema as JsonSchema;

export function parseFileChange(value: unknown): CommittedFileChange | undefined {
  const parsed = committedFileChangeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function assertMatchingFileChange(prepared: PreparedFileChange, change: CommittedFileChange): void {
  committedFileChangeSchema.parse(change);
  const matchesOperation = prepared.operation === "write"
    ? change.operation === "create" || change.operation === "update"
    : prepared.operation === change.operation;
  if (!matchesOperation || prepared.path !== change.path || prepared.destinationPath !== change.destinationPath || prepared.server !== change.server) {
    throw new Error("File change does not match the prepared operation and paths.");
  }
}

/** 参数入口只负责解释意图；运行时仍必须解析路径并校验资源访问声明。 */
export function preparedFileChange(tool: string, args: unknown): PreparedFileChange | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  if (tool === "apply_patch" && typeof record.operation === "object" && record.operation !== null) {
    const operation = record.operation as Record<string, unknown>;
    if (typeof operation.path !== "string" || !["create_file", "update_file", "delete_file"].includes(String(operation.type))) return undefined;
    return { operation: operation.type === "create_file" ? "create" : operation.type === "delete_file" ? "delete" : "update", path: operation.path };
  }
  if (typeof record.path !== "string" || !record.path) return undefined;
  if (tool === "Write") return { operation: "write", path: record.path };
  if (tool === "Edit" && record.operation === undefined && typeof record.old_string === "string") return { operation: "update", path: record.path };
  if (tool !== "Edit" || !["update", "delete", "move"].includes(String(record.operation))) return undefined;
  return {
    operation: record.operation as PreparedFileChangeOperation,
    path: record.path,
    destinationPath: record.operation === "move" && typeof record.to === "string" ? record.to : undefined
  };
}

/** 已派发后的契约或持久化错误不能被当作无副作用的普通失败。 */
export class FileChangeUncertainError extends Error {}

export interface FileChangeResult {
  change: CommittedFileChange;
}
