import { randomUUID } from "node:crypto";
/** 一次性命令只适配输入、权限交互和输出；执行归 Runtime Host。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { saveAttachment, type AgentAttachment } from "../../attachments/store.js";
import { createFileConfigStore } from "../../config/store.js";
import { connectOrSpawnRuntimeHost } from "../../runtime/RuntimeHost.js";
import { confirmPermissionRequest } from "../../permission/confirm.js";
import { resolveWorkspacePath } from "../../workspace/resolvePath.js";
import { withCliAbortSignal } from "../sigint.js";
import { validateRunOptions, assertCompletedCliRun, type RunCommandOptions, type RunCommandResult } from "../../runtime/oneShot.js";
const maxRunAttachments = 8;
const maxRunAttachmentBytes = 20 * 1024 * 1024;
const maxRunAttachmentTotalBytes = 40 * 1024 * 1024;
const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

export async function runCommand(workspaceRoot: string, input: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  validateRunOptions(options);
  const client = await connectOrSpawnRuntimeHost(workspaceRoot, { workspaceRoot, resumeInterrupted: false, surface: "cli", clientId: `run-${process.pid}` });
  if (!client) throw new Error("Runtime Host is unavailable.");
  try {
    await client.waitForReady();
    const config = await createFileConfigStore(workspaceRoot).load(workspaceRoot);
    const attachments = await loadRunAttachments(workspaceRoot, client.persistenceRoot, config.workspace.ignore, options.attachment);
    const { sessionId } = await client.ensureSession({ isolation: options.isolated ? "worktree" : "shared", writeIntent: true,
      runOptions: options, processLifetime: options.json && process.env.BINY_MANAGED_PROCESS_LIFETIME === "execution-environment" ? "execution-environment" : "runtime" });
    const runId = randomUUID();
    const result = await withCliAbortSignal(async signal => {
      const unsubscribe = client.subscribe(update => {
        if (update.event?.type !== "permission.requested" || update.event.sessionId !== sessionId) return;
        const event = update.event;
        void (async () => {
          const response = options.headless ? { approved: true, scope: "session" as const } : await confirmPermissionRequest({
            ...event.request, toolName: event.request.tool, sessionId, projectRoot: workspaceRoot,
            actionType: event.request.actionType as import("../../agent/types.js").AgentPermissionRequest["actionType"],
            riskLevel: event.request.riskLevel as import("../../agent/types.js").AgentPermissionRequest["riskLevel"]
          }, signal);
          await client.answerPermissionRequest(event.requestId, response, sessionId);
        })().catch(() => { void client.cancelRunRequest(runId, "cancelled", sessionId).catch(() => undefined); });
      });
      const abort = () => { void client.cancelRunRequest(runId, "cancelled", sessionId).catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try { signal.throwIfAborted(); return await client.executeRun(sessionId, input, attachments, options, runId); }
      finally { signal.removeEventListener("abort", abort); unsubscribe(); }
    });
    const { output, ...report } = result;
    if (options.json) console.log(JSON.stringify(report));
    else {
      if (output) console.log(output);
      console.log(`\nSession: ${report.sessionFile}`);
      console.log(`Verification: ${report.verificationStatus}`);
      if (report.approval) console.log(`Approve this exact check with: biny task approve ${report.taskRunId} --approval-id '${report.approval.approvalId}'`);
      if (report.verificationStatus !== "not_run" && report.verificationStatus !== "completed") throw new Error(report.verificationReason ?? `Task verification ended with ${report.verificationStatus}.`);
      assertCompletedCliRun({ status: report.status, stopReason: report.stopReason, steps: report.steps, error: report.error, output });
    }
    return report;
  } finally { await client.close(); }
}

/** 把工作区图片复制到项目附件目录，并为当前请求保留一份 base64 模型输入。 */
export async function loadRunAttachments(
  workspaceRoot: string,
  persistenceRoot: string,
  ignore: string[],
  requestedPaths: readonly string[] = []
): Promise<AgentAttachment[]> {
  const uniquePaths = [...new Set(requestedPaths.map((value) => value.trim()).filter(Boolean))];
  if (uniquePaths.length > maxRunAttachments) {
    throw new Error(`biny run accepts at most ${String(maxRunAttachments)} image attachments.`);
  }

  const loaded: Array<{ bytes: Buffer; mimeType: string; resolvedPath: string }> = [];
  let totalBytes = 0;
  for (const requestedPath of uniquePaths) {
    const mimeType = imageMimeTypes.get(path.extname(requestedPath).toLowerCase());
    if (!mimeType) throw new Error(`Unsupported image attachment type: ${requestedPath}`);
    const resolvedPath = resolveWorkspacePath(workspaceRoot, requestedPath, ignore);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${requestedPath}`);
    const bytes = await fs.readFile(resolvedPath);
    if (bytes.byteLength < 1) throw new Error(`Attachment is empty: ${requestedPath}`);
    if (bytes.byteLength > maxRunAttachmentBytes) {
      throw new Error(`Attachment exceeds 20 MiB: ${requestedPath}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxRunAttachmentTotalBytes) {
      throw new Error("Image attachments exceed the 40 MiB total limit.");
    }

    if (!matchesImageSignature(bytes, mimeType)) {
      throw new Error(`Attachment content does not match ${mimeType}: ${requestedPath}`);
    }
    loaded.push({ bytes, mimeType, resolvedPath });
  }
  return await Promise.all(loaded.map(async ({ bytes, mimeType, resolvedPath }) => {
    const reference = await saveAttachment(persistenceRoot, path.basename(resolvedPath), mimeType, bytes);
    return { ...reference, data: bytes.toString("base64") };
  }));
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === "image/jpeg") return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") {
    const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return mimeType === "image/webp"
    && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}
