/** CLI 和工具共用的浏览器文件边界：项目路径、拒绝路径、有界读取和新建式原子落盘。 */
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../workspace/resolvePath.js";
import { matchingDeniedPath } from "../permission/pathPolicy.js";
import { readBoundedBinaryFile, atomicWriteBinaryFile } from "../tools/file/safeFileIo.js";
import { relayBinarySchema, relaySchemas } from "./relayProtocol.js";
import { requestBrowserRelay } from "./relayClient.js";

export const transferSchemas = {
  screenshot: relaySchemas.screenshot.extend({ path: z.string().min(1) }),
  download: relaySchemas.download.extend({ path: z.string().min(1) }),
  upload: relaySchemas.upload.omit({ files: true }).extend({ paths: z.array(z.string().min(1)).min(1).max(10) })
};
export async function transferBrowserFile(method: keyof typeof transferSchemas, input: unknown, options: {
  workspaceRoot: string; ignore: string[]; deniedPaths?: readonly string[]; signal?: AbortSignal; file?: string;
  onDispatched?(): void; onCommit?(evidence: string): void;
}): Promise<unknown> {
  const resolve = (requested: string, write: boolean): string => {
    const resolved = resolveWorkspacePath(options.workspaceRoot, requested, options.ignore);
    if (matchingDeniedPath(resolved, options.deniedPaths ?? [], options.workspaceRoot, write)) throw new Error("文件路径被项目权限禁止。");
    return resolved;
  };
  options.signal?.throwIfAborted();
  if (method === "upload") {
    const { paths, ...args } = transferSchemas.upload.parse(input);
    const files = []; let total = 0;
    for (const requested of paths) {
      const data = await readBoundedBinaryFile(resolve(requested, false), 8 * 1024 * 1024 - total, options.signal);
      total += data.length;
      const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip" };
      files.push({ name: path.basename(requested), mimeType: types[path.extname(requested).toLowerCase()] ?? "application/octet-stream", data: data.toString("base64") });
    }
    options.signal?.throwIfAborted(); options.onDispatched?.();
    return requestBrowserRelay("upload", { ...args, files }, options);
  }
  const { path: requested, ...args } = transferSchemas[method].parse(input);
  const destination = resolve(requested, true);
  options.onDispatched?.();
  const result = relayBinarySchema.parse(await requestBrowserRelay(method, args, options));
  options.signal?.throwIfAborted();
  if (resolve(requested, true) !== destination) throw new Error("文件保存位置已变化。");
  const data = Buffer.from(result.data, "base64");
  if (data.length > 8 * 1024 * 1024) throw new Error("浏览器文件超过 8 MiB 限制。");
  if (method === "screenshot" && !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("截图不是有效 PNG 数据。");
  const bytes = await atomicWriteBinaryFile(destination, data, options.signal, options.onCommit);
  return { path: requested, bytes, mimeType: result.mimeType };
}
