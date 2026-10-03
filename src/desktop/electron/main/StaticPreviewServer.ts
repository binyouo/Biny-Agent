/** 为包含 HTML 的本地项目提供仅监听环回地址的静态预览；按真实路径隔离项目目录。 */
import { randomBytes } from "node:crypto";
import { constants, createReadStream, promises as fs, type ReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".pdf": "application/pdf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8"
};

interface RunningPreview { server: Server; root: string; entry: string; url: string }
interface MediaRegistration { projectId: string; relativePath: string; mimeType: string; resolveFile(): string }
interface RunningMedia { server: Server; origin: string }

const mediaMimeTypes: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".wma": "audio/x-ms-wma"
};
const mediaUrlLimit = 128;

export class StaticPreviewServer {
  private readonly running = new Map<string, RunningPreview>();
  private readonly pending = new Map<string, Promise<{ url: string }>>();
  private disposed = false;
  private readonly media = new Map<string, MediaRegistration>();
  private readonly mediaRequests = new Set<{ projectId: string; cancelled: boolean }>();
  private readonly mediaStreams = new Map<ReadStream, { projectId: string; response: ServerResponse }>();
  private mediaServer?: RunningMedia;
  private mediaStarting?: Promise<RunningMedia>;

  status(projectId: string): { url: string } | undefined {
    const current = this.running.get(projectId);
    return current ? { url: current.url } : undefined;
  }

  /** 文件面板使用独立端口；同一项目的多个 HTML 共享服务，但每次都校验目标文件。 */
  async htmlPreviewUrl(projectId: string, root: string, entry: string): Promise<{ url: string }> {
    if (!/\.html?$/iu.test(entry) || entry.split(/[\\/]/u).some((part) => part.startsWith("."))) throw new Error("只能预览项目内的 HTML 文件。");
    const realRoot = await fs.realpath(root);
    const realEntry = await fs.realpath(path.join(realRoot, entry));
    if (!inside(realRoot, realEntry) || !(await fs.stat(realEntry)).isFile()) throw new Error("预览入口不在项目目录内。");
    const server = await this.start(`file:${projectId}`, realRoot, entry);
    const url = new URL(server.url);
    url.pathname = `/${entry.split("/").map(encodeURIComponent).join("/")}`;
    return { url: url.href };
  }

  /** URL 只暴露有限的随机凭据；请求时仍从当前项目重新解析路径。 */
  async getWorkspaceMediaUrl(projectId: string, relativePath: string, resolveFile: () => string): Promise<{ url: string; mimeType: string }> {
    if (this.disposed) throw new Error("媒体预览已关闭。");
    const request = { projectId, cancelled: false };
    this.mediaRequests.add(request);
    try {
      const filePath = resolveFile();
      const mimeType = mediaMimeTypes[path.extname(filePath).toLowerCase()];
      if (!mimeType) throw new Error("只能预览音频或视频媒体文件。");
      if (!(await fs.stat(filePath)).isFile()) throw new Error("媒体路径不是文件。");
      if (request.cancelled || this.disposed) throw new Error("媒体预览已关闭。");
      const previous = [...this.media].find(([, media]) => media.projectId === projectId && media.relativePath === relativePath);
      const token = previous?.[0] ?? randomBytes(32).toString("hex");
      const registration = { projectId, relativePath, mimeType, resolveFile };
      this.media.delete(token);
      this.media.set(token, registration);
      if (this.media.size > mediaUrlLimit) this.media.delete(this.media.keys().next().value!);
      try {
        const host = await this.ensureMediaServer();
        if (request.cancelled || this.disposed || this.media.get(token) !== registration) throw new Error("媒体预览已关闭。");
        return { url: `${host.origin}/media/${token}`, mimeType };
      } catch (error) {
        if (this.media.get(token) === registration) this.media.delete(token);
        throw error;
      }
    } finally { this.mediaRequests.delete(request); }
  }

  private async ensureMediaServer(): Promise<RunningMedia> {
    if (this.mediaServer) return this.mediaServer;
    if (this.mediaStarting) return await this.mediaStarting;
    const operation = this.listenMedia();
    this.mediaStarting = operation;
    try { return await operation; }
    finally { if (this.mediaStarting === operation) this.mediaStarting = undefined; }
  }

  private async listenMedia(): Promise<RunningMedia> {
    const server = createServer((request, response) => {
      void this.serveMedia(request, response).catch(error => {
        if (response.headersSent) { response.destroy(); return; }
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        response.writeHead(code === "ENOENT" ? 404 : 403, { "Content-Length": "0" }).end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string" || this.disposed) throw new Error("媒体预览已关闭。");
      const host = { server, origin: `http://127.0.0.1:${address.port}` };
      this.mediaServer = host;
      return host;
    } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  }

  private async serveMedia(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" }).end(); return; }
    const token = new URL(request.url ?? "/", "http://127.0.0.1").pathname.match(/^\/media\/([a-f0-9]{64})$/u)?.[1];
    const media = token ? this.media.get(token) : undefined;
    if (!media) { response.writeHead(404, { "Content-Length": "0" }).end(); return; }
    const filePath = media.resolveFile();
    if (mediaMimeTypes[path.extname(filePath).toLowerCase()] !== media.mimeType) throw new Error("媒体文件类型已改变。");
    const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let streaming = false;
    try {
      const stat = await handle.stat();
      const currentPath = media.resolveFile();
      const currentStat = await fs.stat(currentPath);
      if (!stat.isFile() || currentPath !== filePath || stat.dev !== currentStat.dev || stat.ino !== currentStat.ino) throw new Error("媒体文件路径已改变。");
      if (response.destroyed || request.aborted || !this.media.has(token!)) return;
      const range = request.method === "GET" && request.headers.range ? singleRange(request.headers.range, stat.size) : undefined;
      if (range === null) { response.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Content-Length": "0" }).end(); return; }
      response.setHeader("Content-Type", media.mimeType);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Length", String(range ? range.end - range.start + 1 : stat.size));
      if (range) response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
      response.writeHead(range ? 206 : 200);
      if (request.method === "HEAD" || !stat.size) { response.end(); return; }
      const stream = handle.createReadStream({ start: range?.start, end: range?.end, autoClose: true });
      streaming = true;
      this.mediaStreams.set(stream, { projectId: media.projectId, response });
      const cancel = () => stream.destroy();
      response.once("close", cancel);
      stream.once("error", () => response.destroy());
      stream.once("close", () => {
        this.mediaStreams.delete(stream); response.off("close", cancel);
        if (!response.writableEnded && !response.destroyed) response.destroy();
      });
      stream.pipe(response);
    } finally { if (!streaming) await handle.close(); }
  }

  async start(projectId: string, root: string, entry: string): Promise<{ url: string }> {
    if (this.disposed) throw new Error("预览服务已关闭。");
    const existing = this.running.get(projectId);
    if (existing) return { url: existing.url };
    const pending = this.pending.get(projectId);
    if (pending) return await pending;
    const operation = this.listen(projectId, root, entry);
    this.pending.set(projectId, operation);
    try { return await operation; }
    finally { if (this.pending.get(projectId) === operation) this.pending.delete(projectId); }
  }

  private async listen(projectId: string, root: string, entry: string): Promise<{ url: string }> {
    const realRoot = await fs.realpath(root);
    const realEntry = await fs.realpath(path.join(realRoot, entry));
    if (!inside(realRoot, realEntry) || !(await fs.stat(realEntry)).isFile()) throw new Error("预览入口不在项目目录内。");
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
        const rawPath = (request.url ?? "/").split("?")[0]!;
        let decoded: string;
        try { decoded = decodeURIComponent(rawPath); }
        catch { response.writeHead(400).end(); return; }
        if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").some((part) => part.startsWith("."))) { response.writeHead(403).end(); return; }
        const relative = decoded === "/" ? entry : decoded.replace(/^\/+/, "");
        const target = path.join(realRoot, relative);
        let resolved: string;
        try { resolved = await fs.realpath(target); }
        catch { response.writeHead(404).end(); return; }
        if (!inside(realRoot, resolved)) { response.writeHead(403).end(); return; }
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": mimeTypes[path.extname(resolved).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
        if (request.method === "HEAD") { response.end(); return; }
        createReadStream(resolved).on("error", () => response.destroy()).pipe(response);
      })().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.destroy(); });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法获取静态预览端口。");
      if (this.disposed) throw new Error("预览服务已关闭。");
      const url = `http://127.0.0.1:${address.port}/${entry.includes("/") ? entry.split("/").map(encodeURIComponent).join("/") : ""}`;
      this.running.set(projectId, { server, root: realRoot, entry, url });
      return { url };
    } catch (error) { server.close(); throw error; }
  }

  async stop(projectId: string): Promise<void> {
    for (const request of this.mediaRequests) if (request.projectId === projectId) request.cancelled = true;
    for (const [token, media] of this.media) if (media.projectId === projectId) this.media.delete(token);
    await Promise.all([...this.mediaStreams].filter(([, media]) => media.projectId === projectId).map(async ([stream, media]) => {
      const closed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", resolve));
      media.response.destroy(); stream.destroy(); await closed;
    }));
    if (this.mediaStarting) await this.mediaStarting.catch(() => undefined);
    if (!this.media.size && this.mediaServer) {
      const host = this.mediaServer; this.mediaServer = undefined;
      host.server.closeAllConnections();
      await new Promise<void>(resolve => host.server.close(() => resolve()));
    }
    const pending = this.pending.get(projectId);
    if (pending) await pending.catch(() => undefined);
    const current = this.running.get(projectId);
    if (!current) return;
    this.running.delete(projectId);
    current.server.closeAllConnections();
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    for (const request of this.mediaRequests) request.cancelled = true;
    const mediaProjects = [...new Set([...this.media.values(), ...this.mediaStreams.values(), ...this.mediaRequests].map(media => media.projectId))];
    if (!mediaProjects.length) mediaProjects.push("");
    await Promise.all(mediaProjects.map(projectId => this.stop(projectId)));
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.running.keys()].map(async (projectId) => await this.stop(projectId)));
  }
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function singleRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return null;
  const from = match[1] ? Number(match[1]) : undefined;
  const to = match[2] ? Number(match[2]) : undefined;
  if ((from !== undefined && !Number.isSafeInteger(from)) || (to !== undefined && !Number.isSafeInteger(to))) return null;
  if (from === undefined) return to && to > 0 ? { start: Math.max(0, size - to), end: size - 1 } : null;
  if (from >= size || (to !== undefined && to < from)) return null;
  return { start: from, end: Math.min(to ?? size - 1, size - 1) };
}
