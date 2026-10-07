import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { createSessionFile, sessionFilePath } from "../src/session/store.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC", "base64");
const localPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC", "base64");

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-imported-media-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let manager: DesktopAgentManager | undefined = undefined;
  t.after(async () => {
    await manager?.closeAll();
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const requests: Array<{ stream?: boolean; messages: Array<{ role: string; content: unknown }> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://attachment-fixture.invalid/v1/chat/completions");
    const body = await request.json();
    requests.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Attachment received" }, finish_reason: "stop" }] });
    return new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Attachment received" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  await configStore.save(configSchema.parse({
    ...structuredClone(defaultConfig),
    defaultModel: "attachment-fixture",
    providers: { fixture: { type: "openai-compatible", baseUrl: "https://attachment-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "attachment-fixture": { provider: "fixture", model: "attachment-fixture", capabilities: { vision: true, audio: true, tools: true, streaming: true } } },
    activity: { ...defaultConfig.activity, enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "none", defaultSkillSelection: "none" },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context,
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  }));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const sourceAttachment = await projects.saveAttachment(project, "picture.png", "image/png", png);
  const original = await projects.saveAttachment(project, "local.png", "image/png", localPng);
  const document = await projects.saveAttachment(project, "notes.txt", "text/plain", Buffer.from("Synthetic notes"));
  await createSessionFile(project.path, "source", Buffer.from(JSON.stringify({ type: "user_message", content: "Original picture", attachments: [sourceAttachment] }) + "\n"));
  const exported = await projects.buildSessionExport(project, "source", "biny");
  const source = path.join(root, "source.json");
  await writeFile(source, exported.content);
  const imported = await projects.importSessionFromFile(project, source);
  const importedEvents = await readSessionEvents(sessionFilePath(project.path, imported.sessionId));
  const attachment = importedEvents.find(event => event.type === "user_message")?.attachments?.[0];
  assert.ok(attachment);
  assert.match(attachment.path, /^@attachments\/import-[a-f0-9]{32}\/[^/]+$/u);
  const local = await createInteractiveAgentHost(project.path, { configStore, attachmentRoot: projects.attachmentsRoot(project) });
  manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  // 仅测试装配跳过 socket 传输；Desktop、Runtime、Agent 和持久化仍使用真实实现。
  (manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set(project.id, { ...local, unsubscribe: () => undefined });
  return { root, project, projects, manager, runtime: local.runtime, requests, original, document,
    attachment: { ...attachment, size: attachment.size ?? png.length }, sessionId: local.runtime.getSnapshot().info.sessionId };
}

test("Desktop 发送和编辑导入图片时保留原生模型输入和持久引用", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const attachments = [f.original, f.attachment, f.document];
  let requestStart = 0;
  const verify = async (input: string) => {
    await f.runtime.waitForIdle();
    const events = await readSessionEvents(sessionFilePath(f.project.path, f.sessionId));
    const user = events.filter(event => event.type === "user_message" && event.content.includes(input)).at(-1);
    assert.ok(user?.type === "user_message", "submission must reach the real session recorder");
    assert.ok(events.filter(event => event.type === "turn_status").at(-1)?.status === "completed", "the synthetic provider completes the submitted turn");
    assert.deepEqual(user.attachments, [f.original, f.attachment], "Desktop must retain both normal and imported media references");
    assert.ok(user.content.includes(f.document.path), "non-media attachments remain available as file references");
    const imageParts = f.requests.slice(requestStart).flatMap(request => request.messages)
      .filter(message => message.role === "user")
      .flatMap(message => Array.isArray(message.content) ? message.content as Array<{ type: string }> : [])
      .filter(part => part.type === "image_url");
    assert.deepEqual(imageParts, [
      { type: "image_url", image_url: { url: `data:image/png;base64,${localPng.toString("base64")}` } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }
    ]);
    assert.doesNotMatch(await readFile(sessionFilePath(f.project.path, f.sessionId), "utf8"), /iVBORw0KGgoAAAANS/u);
    requestStart = f.requests.length;
    return user;
  };
  await f.manager.sendPrompt(f.project.id, f.sessionId, "Inspect imported picture", attachments);
  await verify("Inspect imported picture");
  await f.manager.editPrompt(f.project.id, f.sessionId, 0, "Inspect edited picture", attachments);
  await verify("Inspect edited picture");
});

for (const [failure, label] of [["missing", "文件缺失"], ["symlink", "被符号链接替换"]] as const) {
  test(`Desktop 拒绝${label}的导入图片并说明重加附件，不提交缺图消息`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const file = f.projects.workspaceFile(f.project, f.attachment.path);
    await unlink(file);
    if (failure === "symlink") {
      const external = path.join(f.root, "outside.png");
      await writeFile(external, png);
      await symlink(external, file);
    }
    const sessionFile = sessionFilePath(f.project.path, f.sessionId);
    const before = await readSessionEvents(sessionFile);
    await assert.rejects(f.manager.sendPrompt(f.project.id, f.sessionId, "Reject unreadable media", [f.original, f.attachment, f.document]),
      /附件文件不可读取：picture\.png。请重新添加附件后重试。/u);
    assert.deepEqual(await readSessionEvents(sessionFile), before);
    assert.equal(f.requests.length, 0, "unreadable media must be rejected before model requests");
  });
}
