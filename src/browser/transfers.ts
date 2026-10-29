/** CLI 和工具共用的浏览器文件边界：项目路径、拒绝路径、有界读取和新建式原子落盘。 */
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../workspace/resolvePath.js";
import { matchingDeniedPath } from "../permission/pathPolicy.js";
import { readBoundedBinaryFile, atomicWriteBinaryFile } from "../tools/file/safeFileIo.js";
import { relayBinarySchema, relaySchemas } from "./relayProtocol.js";
import { requestBrowserRelay } from "./relayClient.js";
import { browserClipboardReadResultSchema, maxBrowserClipboardImageBytes } from "./clipboardSchema.js";
import type { ToolExecutionContext } from "../tools/types.js";

export const transferSchemas = {
  screenshot: relaySchemas.screenshot.extend({ path: z.string().min(1).optional() }),
  download: relaySchemas.download.extend({ path: z.string().min(1) }),
  upload: relaySchemas.upload.omit({ files: true }).extend({ paths: z.array(z.string().min(1)).min(1).max(10) })
};
export interface BrowserFileOptions {
  workspaceRoot: string; ignore: string[]; deniedPaths?: readonly string[]; signal?: AbortSignal; file?: string; sessionId?: string;
  onDispatched?(): void; onCommit?(evidence: string): void;
  onImage?: ToolExecutionContext["onImage"];
}

function resolveBrowserFile(requested: string, write: boolean, options: BrowserFileOptions): string {
  const resolved = resolveWorkspacePath(options.workspaceRoot, requested, options.ignore);
  if (matchingDeniedPath(resolved, options.deniedPaths ?? [], options.workspaceRoot, write)) throw new Error("文件路径被项目权限禁止。");
  return resolved;
}

export async function readBrowserUploadFiles(paths: string[], options: BrowserFileOptions) {
  const files = []; let total = 0;
  for (const requested of transferSchemas.upload.shape.paths.parse(paths)) {
    const data = await readBoundedBinaryFile(resolveBrowserFile(requested, false, options), 8 * 1024 * 1024 - total, options.signal);
    total += data.length;
    const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip" };
    files.push({ name: path.basename(requested), mimeType: types[path.extname(requested).toLowerCase()] ?? "application/octet-stream", data: data.toString("base64") });
  }
  return files;
}

export function prepareBrowserFile(requested: string, options: BrowserFileOptions, png = false) {
  const destination = resolveBrowserFile(requested, true, options);
  return async (value: unknown) => {
    const result = relayBinarySchema.parse(value);
    options.signal?.throwIfAborted();
    if (resolveBrowserFile(requested, true, options) !== destination) throw new Error("文件保存位置已变化。");
    const data = Buffer.from(result.data, "base64");
    if (data.length > 8 * 1024 * 1024) throw new Error("浏览器文件超过 8 MiB 限制。");
    if (png && !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("截图不是有效 PNG 数据。");
    const bytes = await atomicWriteBinaryFile(destination, data, options.signal, options.onCommit);
    return { path: requested, bytes, mimeType: result.mimeType };
  };
}

export function prepareBrowserScreenshot(requested: string | undefined, options: BrowserFileOptions) {
  if (requested === undefined && !options.onImage) throw new Error("截图需要保存路径或支持图片返回的工具入口。");
  const save = requested === undefined ? undefined : prepareBrowserFile(requested, options, true);
  return async (value: unknown) => {
    options.signal?.throwIfAborted();
    const result = relayBinarySchema.extend({ url: z.string().optional(), title: z.string().optional() }).parse(value);
    const data = Buffer.from(result.data, "base64");
    if (result.mimeType !== "image/png" || !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("截图不是有效 PNG 数据。");
    if (data.length > 8 * 1024 * 1024) throw new Error("浏览器截图超过 8 MiB 限制，请缩小范围。");
    let image: Buffer | undefined;
    if (options.onImage) {
      const { default: sharp } = await import("sharp");
      image = await sharp(data, { limitInputPixels: 32_000_000 }).resize({ width: 1280, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
      if (image.length > 1024 * 1024) throw new Error("截图预览超过 1 MiB 限制，请分段观察。");
    }
    options.signal?.throwIfAborted();
    const saved = await save?.(value);
    const imageReturned = image ? options.onImage?.({ type: "image", mimeType: "image/jpeg", data: image.toString("base64") }) === true : false;
    return { path: saved?.path, bytes: data.length, mimeType: result.mimeType, url: result.url, title: result.title, imageReturned };
  };
}

export function prepareBrowserClipboardRead(value: unknown, includeImage: boolean, onImage?: ToolExecutionContext["onImage"]) {
  const result = browserClipboardReadResultSchema.parse(value);
  let imageReturned = false;
  if (includeImage && result.imageData !== undefined) {
    const data = Buffer.from(result.imageData, "base64");
    if (data.length > maxBrowserClipboardImageBytes) throw new Error("剪贴板图片超过 1 MiB 限制。");
    if (!data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) throw new Error("剪贴板图片不是有效 JPEG 数据。");
    imageReturned = onImage?.({ type: "image", mimeType: "image/jpeg", data: result.imageData }) === true;
  }
  return {
    text: result.text,
    truncated: result.truncated,
    ...(result.hasImage === undefined ? {} : { hasImage: result.hasImage }),
    ...(includeImage && result.imageStatus !== undefined ? { imageStatus: result.imageStatus } : {}),
    ...(includeImage ? { imageReturned } : {})
  };
}

export async function transferBrowserFile(method: keyof typeof transferSchemas, input: unknown, options: BrowserFileOptions): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (method === "upload") {
    const { paths, ...args } = transferSchemas.upload.parse(input);
    const files = await readBrowserUploadFiles(paths, options);
    options.signal?.throwIfAborted(); options.onDispatched?.();
    return requestBrowserRelay("upload", { ...args, files }, options);
  }
  const { path: requested, ...args } = transferSchemas[method].parse(input);
  const save = method === "screenshot" ? prepareBrowserScreenshot(requested, options) : prepareBrowserFile(requested!, options);
  options.onDispatched?.();
  return await save(await requestBrowserRelay(method, args, options));
}
