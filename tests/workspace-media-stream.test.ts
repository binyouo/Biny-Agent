/** 真实项目路径、preload/IPC 与本地 HTTP 媒体读取；系统窗口边界使用 fake。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, open, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { createFileConfigStore } from "../src/config/store.js";
import { StaticPreviewServer } from "../src/desktop/electron/main/StaticPreviewServer.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopApi } from "../src/desktop/protocol.js";

type MediaUrl = { url: string; mimeType: string };
type MediaServer = StaticPreviewServer;

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-media-preview-"));
  const workspace = path.join(dir, "workspace"); await mkdir(workspace);
  const storage = new DesktopUserDataStore(path.join(dir, "desktop")); await storage.initialize();
  const state = new DesktopStateStore(path.join(dir, "state.json")); await state.load();
  const projects = new DesktopProjectService(state, storage, createFileConfigStore(dir, { globalDir: dir }));
  const project = await projects.createProject(workspace);
  return { dir, workspace, projects, project, state, preview: new StaticPreviewServer() as MediaServer };
}

const request = async (url: string | URL, init?: RequestInit) => await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });

test("媒体 URL 只读取已注册项目文件，正确提供 HEAD、单 Range 与取消", { timeout: 15000 }, async () => {
  const { dir, workspace, projects, project, preview } = await fixture();
  try {
    await writeFile(path.join(workspace, "clip.mp4"), "0123456789");
    assert.equal(typeof preview.getWorkspaceMediaUrl, "function", "媒体必须有主进程静态 URL 公开入口");
    const resolve = () => projects.workspaceFile(project, "clip.mp4");
    const [media, concurrent] = await Promise.all([preview.getWorkspaceMediaUrl!(project.id, "clip.mp4", resolve), preview.getWorkspaceMediaUrl!(project.id, "clip.mp4", resolve)]);
    assert.deepEqual(concurrent, media, "同一文件并行注册也必须共享有效 URL");
    assert.equal(media.mimeType, "video/mp4"); assert.equal(new URL(media.url).hostname, "127.0.0.1");
    assert.match(new URL(media.url).pathname, /^\/media\/[a-f0-9]{64}$/u);
    assert.equal(media.url.includes(project.id) || media.url.includes("clip.mp4"), false);
    assert.deepEqual(await preview.getWorkspaceMediaUrl!(project.id, "clip.mp4", resolve), media, "重复注册同文件复用 URL");
    const full = await request(media.url);
    assert.equal(full.status, 200); assert.equal(await full.text(), "0123456789");
    assert.equal(full.headers.get("content-length"), "10"); assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-type"), "video/mp4"); assert.equal(full.headers.get("x-content-type-options"), "nosniff");
    assert.equal(full.headers.get("access-control-allow-origin"), "*");
    const head = await request(media.url, { method: "HEAD", headers: { Range: "bytes=2-5" } });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
    for (const [range, content, header] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-50", "89", "bytes 8-9/10"]]) {
      const part = await request(media.url, { headers: { Range: range! } });
      assert.equal(part.status, 206); assert.equal(await part.text(), content); assert.equal(part.headers.get("content-range"), header);
    }
    for (const range of ["bytes=4-3", "bytes=99-", "bytes=-0", "bytes=0-1,3-4", "items=0-2"]) {
      const invalid = await request(media.url, { headers: { Range: range } });
      assert.equal(invalid.status, 416); assert.equal(invalid.headers.get("content-range"), "bytes */10");
    }
    assert.equal((await request(new URL("/clip.mp4", media.url))).status, 404);
    assert.equal((await request(new URL("/media/not-a-token", media.url))).status, 404);
    assert.equal((await request(media.url, { method: "POST" })).status, 405);
    await writeFile(path.join(workspace, "notes.txt"), "plain");
    await assert.rejects(preview.getWorkspaceMediaUrl!(project.id, "notes.txt", () => projects.workspaceFile(project, "notes.txt")), /媒体|音频|视频/u);
    const outside = path.join(dir, "outside.mp4"); await writeFile(outside, "private");
    await unlink(path.join(workspace, "clip.mp4")); await symlink(outside, path.join(workspace, "clip.mp4"));
    assert.equal((await request(media.url)).status, 403, "注册之后替换成外部软链接仍不能读取");
    const audio = await projects.saveAttachment(project, "voice.mp3", "audio/mpeg", Buffer.from("audio-bytes"));
    const attached = await preview.getWorkspaceMediaUrl!(project.id, audio.path, () => projects.workspaceFile(project, audio.path));
    assert.equal(attached.mimeType, "audio/mpeg"); assert.equal(await (await request(attached.url)).text(), "audio-bytes");
    const handle = await open(path.join(workspace, "large.webm"), "w");
    try { await handle.truncate(64 * 1024 * 1024); } finally { await handle.close(); }
    const large = await preview.getWorkspaceMediaUrl!(project.id, "large.webm", () => projects.workspaceFile(project, "large.webm"));
    const tail = await request(large.url, { headers: { Range: "bytes=-32" } });
    assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 32, "大媒体仅传输请求范围");
    const streaming = await request(large.url); const reader = streaming.body!.getReader();
    assert.equal((await reader.read()).done, false); await reader.cancel();
    assert.equal((await request(large.url, { headers: { Range: "bytes=0-3" } })).status, 206, "取消流后服务仍可读取");
    const interrupted = await request(large.url);
    await preview.stop(project.id);
    await assert.rejects(interrupted.arrayBuffer(), /terminated|abort|closed/u, "停止项目中断正在传输的响应");
    await assert.rejects(request(large.url), /fetch|connect|abort/u);
  } finally { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});

test("图片附件也经过真实路径边界，外部软链接 PNG 不返回 data URL", async () => {
  const { dir, projects, project, preview } = await fixture();
  try {
    const attachment = await projects.saveAttachment(project, "inside.png", "image/png", Buffer.from("inside"));
    assert.equal(await projects.readInlineImage(project, attachment.path), "data:image/png;base64,aW5zaWRl");
    const outside = path.join(dir, "outside.png"); await writeFile(outside, "private image");
    await symlink(outside, path.join(projects.attachmentsRoot(project), "escape.png"));
    assert.equal(await projects.readInlineImage(project, "@attachments/escape.png"), undefined, "附件名安全不能替代软链接边界");
  } finally { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});

test("媒体 token 注册有界，不同项目停止互不影响", { timeout: 15000 }, async () => {
  const { dir, workspace, projects, project, preview } = await fixture();
  try {
    assert.equal(typeof preview.getWorkspaceMediaUrl, "function");
    await writeFile(path.join(workspace, "audio.mp3"), "voice");
    const first = await preview.getWorkspaceMediaUrl!(project.id, "audio.mp3", () => projects.workspaceFile(project, "audio.mp3"));
    const other = await preview.getWorkspaceMediaUrl!("other", "audio.mp3", () => projects.workspaceFile(project, "audio.mp3"));
    await preview.stop(project.id);
    assert.equal((await request(first.url)).status, 404); assert.equal(await (await request(other.url)).text(), "voice");
    let last: MediaUrl | undefined;
    for (let index = 0; index < 128; index++) {
      const name = `file-${index}.mp3`; await writeFile(path.join(workspace, name), "voice");
      last = await preview.getWorkspaceMediaUrl!("other", name, () => projects.workspaceFile(project, name));
    }
    assert.equal((await request(other.url)).status, 404, "超过注册上限移除最旧 token");
    assert.equal(await (await request(last!.url)).text(), "voice");
    await preview.disposeAll(); await assert.rejects(request(last!.url), /fetch|connect|abort/u);
  } finally { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});

test("零字节媒体与取消注册遵守范围和生命周期边界", async () => {
  const { dir, workspace, projects, project, preview } = await fixture();
  try {
    await writeFile(path.join(workspace, "empty.wav"), "");
    const opening = preview.getWorkspaceMediaUrl!(project.id, "empty.wav", () => projects.workspaceFile(project, "empty.wav"));
    const cancelled = assert.rejects(opening, /关闭/u); await preview.stop(project.id); await cancelled;
    const media = await preview.getWorkspaceMediaUrl!(project.id, "empty.wav", () => projects.workspaceFile(project, "empty.wav"));
    const empty = await request(media.url); assert.equal(empty.status, 200); assert.equal(empty.headers.get("content-length"), "0"); assert.equal((await empty.arrayBuffer()).byteLength, 0);
    const invalid = await request(media.url, { headers: { Range: "bytes=0-" } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get("content-range"), "bytes */0");
    await writeFile(path.join(workspace, "voice.wma"), "audio");
    assert.equal((await preview.getWorkspaceMediaUrl!(project.id, "voice.wma", () => projects.workspaceFile(project, "voice.wma"))).mimeType, "audio/x-ms-wma");
    await preview.disposeAll();
    await assert.rejects(preview.getWorkspaceMediaUrl!(project.id, "empty.wav", () => projects.workspaceFile(project, "empty.wav")), /关闭/u);
  } finally { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});

test("媒体 preload 到 IPC 只允许主窗口并重新检查当前项目路径", { timeout: 15000 }, async () => {
  const { dir, workspace, projects, project, state, preview } = await fixture();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const exposed: Record<string, unknown> = {};
  const host = { webContents: { mainFrame: {} } }; let sender = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
  Object.assign(globalThis, { __mediaIpcElectron: {
    contextBridge: { exposeInMainWorld(key: string, value: unknown) { exposed[key] = value; } },
    ipcMain: { on() {}, removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler); } },
    ipcRenderer: { on() {}, invoke: async (channel: string, ...args: unknown[]) => { const handler = handlers.get(channel); assert.ok(handler, channel); return await handler(sender, ...args); } }
  } });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/u.test(url) ? { format: "module", shortCircuit: true, source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu,contextBridge,ipcRenderer,webUtils}=globalThis.__mediaIpcElectron;" } : next(url, context); } });
  try {
    await writeFile(path.join(workspace, "play.mp4"), "media");
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({ projects, staticPreview: preview, getWindow: () => host, settings: {} } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    await import("../src/desktop/electron/preload/index.js");
    const api = exposed.biny as DesktopApi;
    assert.equal(typeof api.getWorkspaceMediaUrl, "function", "preload 必须暴露媒体 URL 桥");
    const media = await api.getWorkspaceMediaUrl!(project.id, "play.mp4");
    assert.equal(await (await request(media.url)).text(), "media");
    await assert.rejects(api.getWorkspaceMediaUrl!(project.id, ""), /String|small|length|至少/u);
    await assert.rejects(api.getWorkspaceMediaUrl!("unknown-project", "play.mp4"), /Unknown project/u);
    await assert.rejects(api.getWorkspaceMediaUrl!(project.id, "../outside.mp4"), /escapes workspace/u);
    await state.removeProject(project.id);
    assert.equal((await request(media.url)).status, 403, "HTTP 读取时还必须重新检查项目仍存在");
    sender = { sender: host.webContents, senderFrame: {} };
    await assert.rejects(api.getWorkspaceMediaUrl!(project.id, "play.mp4"), /只接受主窗口请求/u);
    sender = { sender: { mainFrame: {} }, senderFrame: {} };
    await assert.rejects(api.getWorkspaceMediaUrl!(project.id, "play.mp4"), /只接受主窗口请求/u);
  } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, "__mediaIpcElectron"); await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});
