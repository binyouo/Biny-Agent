/** HTTP 显式分析在提交会话结果后响应；投影及其资源由服务关闭流程收齐。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startActivityHttpServer } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-projection-"));
const store = new ActivityStore();
const release = Promise.withResolvers<void>();
let endpoint: Awaited<ReturnType<typeof startActivityHttpServer>> | undefined;
try {
  await store.open(root, root);
  const id = store.startSession("2026-09-10T09:00:00.000Z");
  store.recordEvent({ sessionId: id, occurredAt: "2026-09-10T09:01:00.000Z", eventType: "focus_changed", application: "Editor" });
  store.endSession(id, "2026-09-10T10:00:00.000Z");
  const model: AgentModel = {
    provider: "test", modelId: "activity-http-projection", runtime: "provider", dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: JSON.stringify({
        worth: true, title: "工作会话", summary: "维护工作记录", project: "project",
        memoryCandidates: [{ type: "project", content: "项目采用稳定的发布流程。", why: "持续约束" }]
      }) };
      yield { type: "finish", reason: "stop" };
    })()
  };
  const started = Promise.withResolvers<void>();
  let completed = false;
  endpoint = await startActivityHttpServer({
    agentDir: root,
    loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
    getModel: () => model,
    writeMemories: async () => { started.resolve(); await release.promise; completed = true; }
  });
  const responsePromise = fetch(`http://${endpoint.host}:${endpoint.port}/api/activity-recorder/sessions/${id}/analyze`, {
    method: "POST", headers: { authorization: `Bearer ${endpoint.token}` }
  });
  await started.promise;
  let closing: Promise<void> | undefined;
  try {
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("分析响应等待了记忆投影")), 1_000))
    ]);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { analysisStatus: string }).analysisStatus, "analyzed");
    assert.equal(completed, false);
    assert.ok(store.getAnalysis(id));
    closing = endpoint.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, false, "服务关闭须等待仍在写入的投影");
  } finally {
    release.resolve();
  }
  await closing;
  endpoint = undefined;
  assert.equal(completed, true);
} finally {
  release.resolve();
  await endpoint?.close();
  await store.close();
  await rm(root, { recursive: true, force: true });
}

await testShutdownWaitsForInFlightAnalysis();

async function testShutdownWaitsForInFlightAnalysis(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-shutdown-"));
  const store = new ActivityStore();
  const releaseModel = Promise.withResolvers<void>();
  let endpoint: Awaited<ReturnType<typeof startActivityHttpServer>> | undefined;
  let closing: Promise<void> | undefined;
  let request: Promise<unknown> | undefined;
  try {
    await store.open(root, root);
    const id = store.startSession("2026-09-10T09:00:00.000Z");
    store.recordEvent({ sessionId: id, occurredAt: "2026-09-10T09:01:00.000Z", eventType: "focus_changed", application: "Editor" });
    store.endSession(id, "2026-09-10T10:00:00.000Z");
    const modelStarted = Promise.withResolvers<void>();
    const model: AgentModel = {
      provider: "test", modelId: "activity-shutdown-test", runtime: "provider", dataResidency: "local",
      stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify({ worth: true, summary: "工作活动" }) };
        yield { type: "finish", reason: "stop" };
      })()
    };
    endpoint = await startActivityHttpServer({
      agentDir: root,
      loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
      getModel: async () => { modelStarted.resolve(); await releaseModel.promise; return model; }
    });
    request = fetch(`http://${endpoint.host}:${endpoint.port}/api/activity-recorder/sessions/${id}/analyze`, {
      method: "POST", headers: { authorization: `Bearer ${endpoint.token}` }
    }).catch(() => undefined);
    await modelStarted.promise;
    closing = endpoint.close();
    endpoint = undefined;
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, false, "关闭须等待已进入模型的请求处理结束");
    releaseModel.resolve();
    await closing;
    await request;
    assert.equal(store.getAnalysis(id), undefined, "关闭后的模型输出不得补写分析");
  } finally {
    releaseModel.resolve();
    await closing;
    await endpoint?.close();
    await request;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
