/** 后台分析状态来自持久库；失败重试不能删除活动事实或重放成功分析。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "../src/activity/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";

test("旧失败不在最近会话窗口时仍显示失败数量、模型和脱敏原因；现有快照只展示采集状态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-analysis-recovery-"));
  const store = new ActivityStore();
  const configStore = createFileConfigStore(root, { globalDir: root });
  const service = new ActivityRecorderService({ agentDir: root, configStore });
  try {
    await configStore.save({ ...defaultConfig, activity: { ...defaultConfig.activity, enabled: false, outputDirectory: root } });
    await store.open(root, root);
    const failed = store.startSession("2026-10-10T06:00:00.000Z");
    store.endSession(failed, "2026-10-10T06:10:00.000Z");
    store.recordAnalysisStatus(failed, "failed", { model: "old-model", error: "Insufficient Balance; api_key=sk-1234567890abcdefghijk", analyzedAt: "2026-10-10T06:11:00.000Z" });
    for (let index = 0; index < 12; index += 1) {
      const id = store.startSession(new Date(Date.parse("2026-10-10T07:00:00.000Z") + index * 60_000).toISOString());
      store.endSession(id, new Date(Date.parse("2026-10-10T07:00:30.000Z") + index * 60_000).toISOString());
    }
    await service.initialize();
    const snapshot = service.snapshot();
    assert.ok(!snapshot.recentSessions.some((session) => session.id === failed));
    assert.equal(snapshot.analysis?.failed, 1);
    assert.equal(snapshot.analysis?.pending, 12);
    assert.equal(snapshot.analysis?.latestFailure?.model, "old-model");
    assert.match(snapshot.analysis?.latestFailure?.error ?? "", /Insufficient Balance/u);
    assert.doesNotMatch(JSON.stringify(snapshot.analysis), /sk-1234567890abcdefghijk/u);
    assert.equal(snapshot.state, "paused", "分析失败不能覆盖采集状态");
  } finally {
    await service.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("切换到可用工具模型后仅将已结束的失败记录入队，重复操作不重复入队；原有显式分析测试未覆盖批量恢复", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-analysis-requeue-"));
  const store = new ActivityStore();
  const configStore = createFileConfigStore(root, { globalDir: root });
  const service = new ActivityRecorderService({ agentDir: root, configStore });
  try {
    const config: AgentConfig = { ...defaultConfig, defaultModel: "restored",
      activity: { ...defaultConfig.activity, enabled: false, outputDirectory: root },
      providers: { local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", requiresApiKey: true, apiKeyEnv: "BINY_TEST_ACTIVITY_MISSING_KEY" } },
      models: { restored: { provider: "local", model: "restored-model", contextWindow: 128_000 } } };
    await configStore.save(config);
    await store.open(root, root);
    const failed = store.startSession("2026-10-10T06:00:00.000Z");
    store.recordEvent({ sessionId: failed, occurredAt: "2026-10-10T06:01:00.000Z", eventType: "app_focus", application: "Editor" });
    store.endSession(failed, "2026-10-10T06:10:00.000Z");
    store.recordAnalysisStatus(failed, "failed", { model: "old-model", error: "Insufficient Balance" });
    const skipped = store.startSession("2026-10-10T07:00:00.000Z");
    store.endSession(skipped, "2026-10-10T07:10:00.000Z");
    store.recordAnalysisStatus(skipped, "skipped");
    await service.initialize();
    const active = store.startSession("2026-10-10T08:00:00.000Z");
    store.recordAnalysisStatus(active, "failed");
    await assert.rejects(service.retryFailedAnalysis(), /工具模型/u);
    assert.equal(store.getHttpSessionDetail(failed)?.session.analysisStatus, "failed");
    await configStore.save({ ...config, toolModel: "restored", providers: {
      local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", requiresApiKey: false }
    }, models: { restored: { provider: "local", model: "restored-model", contextWindow: 128_000 } } });
    const result = await service.retryFailedAnalysis();
    assert.equal(result.queued, 1);
    assert.equal(result.snapshot.analysis?.failed, 0);
    assert.equal(result.snapshot.analysis?.pending, 1);
    assert.equal(store.getHttpSessionDetail(failed)?.session.analysisStatus, "pending");
    assert.equal(store.getHttpSessionDetail(failed)?.session.analysisError, null);
    assert.equal(store.getHttpSessionDetail(failed)?.events.length, 1, "重试不能删除活动证据");
    assert.equal(store.getHttpSessionDetail(skipped)?.session.analysisStatus, "skipped");
    assert.equal(store.getHttpSessionDetail(active)?.session.analysisStatus, "failed");
    assert.equal((await service.retryFailedAnalysis()).queued, 0);
    await store.close();
    await store.open(root, root);
    assert.equal(store.listSessionsPendingAnalysis().length, 1, "入队结果须在重启后保留");
  } finally {
    await service.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
