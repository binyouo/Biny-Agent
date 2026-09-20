import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { createActivityMemoryPipeline } from "../src/activity/memoryPipeline.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import type { AgentModel } from "../src/agent/core/types.js";
import type { ActivitySessionAnalysis } from "../src/activity/store.js";
import { ActivityStore } from "../src/activity/store.js";
import { analyzeActivitySession, analyzePendingActivitySessions } from "../src/activity/analyzer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-memory-pipeline-"));
const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");

const model: AgentModel = {
  provider: "test",
  modelId: "activity-test",
  stream: async () => (async function* () {
    yield { type: "finish" as const, reason: "stop" as const };
  })()
};

try {
  await testDeferredCandidatesRecover();
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    getCrystalConfig: () => ({
      passiveEnabled: false,
      semanticScanEnabled: false,
      contour: { count: 1, turns: 1, spread: 1 },
      nucleus: { count: 2, turns: 2, spread: 1 },
      dormantDays: 14
    })
  });
  try {
    await pipeline.writeMemories([{
      type: "project",
      content: "Project Delta uses a staged release checklist before every deployment.",
      why: "Repeated release decision"
    }], {
      sessionId: "activity-session-1",
      analyzedAt: "2026-09-07T10:00:00.000Z",
      project: "Project Delta",
      model
    });

    const memory = new MemoryStorage(root);
    try {
      const entries = await memory.listEntries();
      assert.equal(entries.entries.length, 1);
      assert.equal(entries.entries[0]?.activitySessionId, "activity-session-1");
    } finally {
      memory.close();
    }

    const analysis: ActivitySessionAnalysis = {
      sessionId: "activity-session-1",
      analyzedAt: "2026-09-07T10:00:00.000Z",
      analyzerModel: model.modelId,
      analysisStatus: "analyzed",
      project: "Project Delta",
      title: "Release work",
      description: "Release work",
      summary: "Project Delta uses a staged release checklist before every deployment.",
      topics: ["Project Delta"],
      prs: [],
      issues: [],
      people: [],
      versions: [],
      decisions: [],
      entities: ["Project Delta"],
      highlights: ["Project Delta"],
      worthMemory: true,
      worthKnowledge: true,
      isMeeting: false,
      storageTier: "standard",
      confidence: 0.9,
      sourceEventCount: 2,
      inputHash: "hash-1"
    };
    const session = {
      id: "activity-session-1",
      startedAt: "2026-09-07T10:00:00.000Z",
      endedAt: "2026-09-07T10:10:00.000Z",
      eventCount: 2,
      durationMs: 600_000,
      snapshotCount: 1
    };
    assert.equal(await pipeline.onAnalyzed(analysis, session), undefined);
    await pipeline.onAnalyzed(analysis, session);
    assert.equal(await pipeline.onAnalyzed({ ...analysis, sessionId: "activity-session-2", inputHash: "hash-2" }, {
      ...session,
      id: "activity-session-2",
      startedAt: "2026-09-08T10:00:00.000Z",
      endedAt: "2026-09-08T10:10:00.000Z"
    }), undefined);
  } finally {
    pipeline.close();
  }

  const crystals = new CrystalStorage();
  await crystals.initialize();
  try {
    const activity = new ActivityStore();
    await activity.open(path.join(root, "activity"));
    try {
      const id = activity.startSession(new Date().toISOString());
      activity.recordEvent({ sessionId: id, occurredAt: new Date().toISOString(), eventType: "app_focus", application: "Test" });
      await activity.clear();
      assert.equal(activity.snapshot().sessions, 0);
    } finally {
      await activity.close();
    }
    const memory = new MemoryStorage(root);
    try {
      assert.equal((await memory.listEntries()).entries.length, 1, "清空 Activity 不跨库删除长期记忆");
    } finally {
      memory.close();
    }
    const term = crystals.listTerms().find((candidate) => candidate.term === "project delta");
    assert.equal(term?.count, 2);
    assert.equal(term?.status, "nucleus");
    assert.ok(term?.crystalId);
    assert.equal(crystals.listMaterials(term!.crystalId!).length, 2);
    assert.equal(crystals.listCrystals().length, 1);
  } finally {
    crystals.close();
  }
} finally {
  if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

async function testDeferredCandidatesRecover(): Promise<void> {
  let available = false;
  let modelCalls = 0;
  const candidate = { type: "project", content: "项目保留独立的发布前验收清单，每次正式发布前必须完成回归检查。", why: "重复且稳定的流程" };
  const toolModel: AgentModel = {
    provider: "test", modelId: "projection-test", runtime: "builtin-llama.cpp", dataResidency: "local",
    stream: async () => (async function* () {
      modelCalls += 1;
      yield { type: "text-delta" as const, text: JSON.stringify({ worth: true, summary: "维护发布清单", memoryCandidates: [candidate] }) };
      yield { type: "finish" as const, reason: "stop" as const };
    })()
  };
  const pipeline = await createActivityMemoryPipeline({ workspaceRoot: root, requireSemantic: true, findSimilarEntries: async () => available ? [] : undefined });
  const store = new ActivityStore();
  const settings = { ...defaultActivitySettings, outputDirectory: path.join(root, "recovery") };
  try {
    await store.open(settings.outputDirectory);
    const id = store.startSession("2026-09-07T10:00:00.000Z");
    store.recordEvent({ sessionId: id, occurredAt: "2026-09-07T10:01:00.000Z", eventType: "app_focus", application: "Editor" });
    store.endSession(id, "2026-09-07T10:10:00.000Z");
    const deps = { store, model: toolModel, writeMemories: pipeline.writeMemories, onAnalyzed: pipeline.onAnalyzed };
    await analyzeActivitySession(deps, id);
    assert.equal(store.getPendingAnalysisProjection(store.getAnalysis(id)!).memoryCandidates.length, 1,
      "必需语义路径不可用，不能误标为记忆已写入");
    available = true;
    await analyzePendingActivitySessions(deps);
    await analyzePendingActivitySessions(deps);
    assert.equal(modelCalls, 1, "恢复不再调用活动分析模型");
    assert.deepEqual(store.listAnalysesPendingProjection(), []);
    const memory = new MemoryStorage(root);
    try {
      const entries = await memory.listEntries();
      const written = entries.entries.filter((entry) => entry.activitySessionId === id);
      assert.equal(written.length, 1);
      assert.equal(written[0]?.content, candidate.content);
      await memory.deleteEntry(written[0]!.id);
    } finally { memory.close(); }
  } finally {
    pipeline.close();
    await store.close();
  }
}

console.log("activity memory pipeline tests passed");
