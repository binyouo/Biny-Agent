import assert from "node:assert/strict";
import { createServer } from "node:http";
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
import { defaultConfig } from "../src/config/schema.js";
import { createCliActivityMemoryPipeline } from "../src/cli/commands/activity.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

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
  await testDefaultRequiresSemantic();
  await testCliSemanticGateAndIndex();
  await testCliProviderEmbeddingSelection();
  await testDeferredCandidatesRecover();
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    findSimilarEntries: async () => [],
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
    await activity.open(path.join(root, "activity"), root);
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
  await testCandidateFailureDoesNotDropLaterMemories();
  await testDeferredCandidateDoesNotBlockLaterCandidate();
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
    await store.open(settings.outputDirectory, root);
    const id = store.startSession("2026-09-07T10:00:00.000Z");
    store.recordEvent({ sessionId: id, occurredAt: "2026-09-07T10:01:00.000Z", eventType: "app_focus", application: "Editor" });
    store.endSession(id, "2026-09-07T10:10:00.000Z");
    const deps = { store, model: toolModel, writeMemories: pipeline.writeMemories, onAnalyzed: pipeline.onAnalyzed };
    await analyzeActivitySession(deps, id);
    available = true;
    await analyzePendingActivitySessions(deps);
    await analyzePendingActivitySessions(deps);
    assert.equal(modelCalls, 1, "恢复不再调用活动分析模型");
    const memory = new MemoryStorage(root);
    try {
      const entries = await memory.listEntries();
      const written = entries.entries.filter((entry) => entry.activitySessionId === id);
      assert.equal(written.length, 0, "分析结束后的写入失败不会自动补偿");
    } finally { memory.close(); }
  } finally {
    pipeline.close();
    await store.close();
  }
}

console.log("activity memory pipeline tests passed");

async function testCandidateFailureDoesNotDropLaterMemories(): Promise<void> {
  const sessionId = "activity-partial-candidate-write";
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    skipUnknownWorkspace: true,
    findSimilarEntries: async () => []
  });
  try {
    await pipeline.writeMemories([
      { type: "project", content: "The first candidate records a release rule.", why: "Stable rule" },
      { type: "user", content: "The second candidate records an independent review rule.", why: "Stable rule" }
    ], { sessionId, analyzedAt: "2026-09-07T10:00:00.000Z", model });
    const memory = new MemoryStorage(root);
    try {
      const entries = (await memory.listEntries()).entries.filter((entry) => entry.activitySessionId === sessionId);
      assert.ok(entries.some((entry) => entry.content.includes("second candidate")),
        "首条候选的派生索引失败后，后续独立候选仍写入 SQLite");
    } finally { memory.close(); }
  } finally { pipeline.close(); }
}

async function testDefaultRequiresSemantic(): Promise<void> {
  const pipeline = await createActivityMemoryPipeline({workspaceRoot:root});
  try {
    await assert.rejects(pipeline.writeMemories([{
      type:"user",content:"A semantic gate must precede this automatic Activity fact.",why:"source parity"
    }], {sessionId:"semantic-unavailable",analyzedAt:"2026-09-07T10:00:00.000Z",model}), /语义检索暂不可用/u);
    const memory = new MemoryStorage(root);
    try {
      assert.equal((await memory.listEntries()).entries.some(entry=>entry.activitySessionId==="semantic-unavailable"),false);
    } finally {memory.close();}
  } finally {pipeline.close();}
}

async function testDeferredCandidateDoesNotBlockLaterCandidate(): Promise<void> {
  let searches = 0;
  const sessionId = "activity-per-candidate-semantic-recovery";
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    requireSemantic: true,
    findSimilarEntries: async () => ++searches === 1 ? undefined : []
  });
  try {
    await assert.rejects(pipeline.writeMemories([
      { type: "user", content: "The first candidate is deferred by unavailable semantic search.", why: "Stable fact" },
      { type: "user", content: "The second candidate has an independent stable review rule.", why: "Stable fact" }
    ], { sessionId, analyzedAt: "2026-09-07T10:00:00.000Z", model }), /语义检索暂不可用/u);
    assert.equal(searches, 2, "一条候选检索暂不可用不阻断后续候选独立尝试");
    const memory = new MemoryStorage(root);
    try {
      const written = (await memory.listEntries()).entries.filter((entry) => entry.activitySessionId === sessionId);
      assert.deepEqual(written.map((entry) => entry.content), ["The second candidate has an independent stable review rule."]);
    } finally { memory.close(); }
  } finally { pipeline.close(); }
}

async function testCliSemanticGateAndIndex(): Promise<void> {
  const cliRoot = await mkdtemp(path.join(os.tmpdir(), "biny-activity-cli-memory-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(cliRoot, "agent");
  const candidate = {type:"user" as const,content:"Activity CLI semantic source fact",why:"source parity"};
  const context = {sessionId:"cli-activity-session",analyzedAt:"2026-09-07T10:00:00.000Z",model};
  const localConfig = {...defaultConfig,context:{...defaultConfig.context,memory:{...defaultConfig.context.memory,
    embeddingModel:{kind:"local" as const,model:"multilingual-e5-small" as const}}}};
  const descriptor = {ref:{kind:"local" as const,model:"multilingual-e5-small" as const},fingerprint:"test-activity-cli-e5",
    displayName:"test",dimensions:2,recommendedThreshold:0.8,source:"local" as const};
  const runtime:EmbeddingModelRuntime = {descriptor,fingerprint:descriptor.fingerprint,embed:async({texts})=>({
    embeddings:texts.map(()=>new Float32Array([1,0])),dimensions:2,fingerprint:descriptor.fingerprint,model:descriptor.ref
  })};
  try {
    for (const [config, getRuntime] of [[defaultConfig,async()=>runtime],[localConfig,async()=>undefined]] as const) {
      const pipeline = await createCliActivityMemoryPipeline(cliRoot, config, getRuntime);
      try {
        await assert.rejects(pipeline.writeMemories([candidate],context),/语义检索暂不可用/u);
      } finally {await pipeline.close();}
    }
    const available = await createCliActivityMemoryPipeline(cliRoot,localConfig,async()=>runtime);
    try {
      await available.writeMemories([candidate],context);
      const memory = new MemoryStorage(cliRoot);
      try {
        const entries = (await memory.listEntries()).entries;
        assert.equal(entries.length,1,"CLI 本地语义运行时可用且索引为空时允许首条事实写入");
        const index = MemoryVectorIndex.openReadOnly(path.join(cliRoot,"agent"));
        assert.ok(index);
        try {
          assert.equal(index.search(new Float32Array([1,0]),{modelFingerprint:descriptor.fingerprint,limit:5,minimumSimilarity:0.3})[0]?.entryId,
            entries[0]!.id,"CLI 写入后同一向量服务可检索事实");
        } finally {index.close();}
      } finally {memory.close();}
    } finally {await available.close();}
  } finally {
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(cliRoot,{recursive:true,force:true});
  }
}

async function testCliProviderEmbeddingSelection(): Promise<void> {
  const cliRoot = await mkdtemp(path.join(os.tmpdir(), "biny-activity-cli-provider-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(cliRoot, "agent");
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { input: string[] };
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const providerConfig = {
      ...defaultConfig,
      providers: { embed: {
        type: "openai-compatible" as const,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requiresApiKey: false,
        embeddingModels: [{ id: "text-embedding-3-small", displayName: "Test embedding", dimensions: 2 }]
      } }
    };
    const descriptor = new ProviderRegistry(providerConfig).listEmbeddingModels()[0]!;
    assert.equal(descriptor.available, true);
    for (const [selection, suffix] of [
      [{ kind: "auto" as const }, "auto"],
      [{ kind: "provider" as const, provider: "embed", model: "text-embedding-3-small" }, "explicit"]
    ] as const) {
      const config = { ...providerConfig, context: { ...providerConfig.context,
        memory: { ...providerConfig.context.memory, embeddingModel: selection } } };
      const pipeline = await createCliActivityMemoryPipeline(cliRoot, config);
      try {
        await pipeline.writeMemories([{ type: "user", content: `CLI Provider Activity fact ${suffix}`, why: "source parity" }],
          { sessionId: `cli-provider-${suffix}`, analyzedAt: "2026-09-07T10:00:00.000Z", model });
      } finally { await pipeline.close(); }
    }
    assert.ok(requests >= 2, "auto 和显式选择都使用真实 Provider embedding wire");
    const memory = new MemoryStorage(cliRoot);
    try {
      const entries = (await memory.listEntries()).entries;
      assert.equal(entries.length, 2);
      const index = MemoryVectorIndex.openReadOnly(path.join(cliRoot, "agent"));
      assert.ok(index);
      try {
        assert.equal(index.status().active?.modelFingerprint, descriptor.fingerprint);
        assert.equal(index.search(new Float32Array([1, 0]), { modelFingerprint: descriptor.fingerprint,
          limit: 5, minimumSimilarity: 0.3 }).length, 2);
      } finally { index.close(); }
    } finally { memory.close(); }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(cliRoot, { recursive: true, force: true });
  }
}
