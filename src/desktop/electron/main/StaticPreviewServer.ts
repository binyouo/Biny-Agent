/** 为包含 HTML 的本地项目提供仅监听环回地址的静态预览；按真实路径隔离项目目录。 */
import { createReadStream, promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
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

export class StaticPreviewServer {
  private readonly running = new Map<string, RunningPreview>();
  private readonly pending = new Map<string, Promise<{ url: string }>>();
  private disposed = false;

  status(projectId: string): { url: string } | undefined {
    const current = this.running.get(projectId);
    return current ? { url: current.url } : undefined;
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
        if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) { response.writeHead(403).end(); return; }
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
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.running.keys()].map(async (projectId) => await this.stop(projectId)));
  }
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
