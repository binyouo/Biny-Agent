import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryActivitySuggestionCache, generateActivitySuggestions } from "../src/activity/suggestions.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

await testActivitySuggestionsAreGroundedAndCached();
await testActivitySuggestionsUseExternalModel();
await testTooFewSuggestionsAreRejected();

async function testActivitySuggestionsAreGroundedAndCached(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "window_title",
      application: "Editor",
      windowTitle: "Activity suggestions"
    });
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
    store.recordAnalysis({
      sessionId,
      analyzedAt: "2026-08-31T10:00:00.000Z",
      analyzerModel: "analyzer",
      project: "biny",
      title: "修复 Activity 检索",
      description: "完成中文检索与日报对齐。",
      summary: "完成 Activity 中文检索与日报对齐",
      topics: ["jieba", "日报"],
      prs: [],
      issues: [],
      people: [],
      versions: [],
      decisions: ["使用本地 FTS 分词"],
      entities: ["activity_fts"],
      highlights: ["接入中文分词"],
      worthMemory: false,
      worthKnowledge: false,
      isMeeting: false,
      storageTier: "standard",
      confidence: 1,
      sourceEventCount: 3,
      inputHash: "suggestions-test"
    });
    let calls = 0;
    let prompt = "";
    const model: AgentModel = {
      provider: "test",
      modelId: "suggestion-model",
      runtime: "builtin-llama.cpp",
      dataResidency: "local",
      stream: async (context) => {
        calls += 1;
        prompt = JSON.stringify(context.messages[0]?.content ?? "");
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: JSON.stringify(["我想检查 biny 的 Activity 中文检索", "帮我回顾日报里的关键决定", "继续完善 jieba FTS", "帮我核对本地 FTS 的实现"] ) };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const cache = createInMemoryActivitySuggestionCache();
    const deps = {
      store,
      model,
      now: new Date("2026-09-01T12:00:00.000Z"),
      cache
    };
    const first = await generateActivitySuggestions(deps);
    assert.equal(first.suggestions.length, 4);
    assert.equal(first.cached, false);
    assert.equal(calls, 1);
    assert.match(prompt, /biny/u);
    assert.match(prompt, /jieba/u);
    const second = await generateActivitySuggestions(deps);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    store.recordAnalysis({ ...store.getAnalysis(sessionId)!, summary: "同一输入的新分析", topics: ["NEW_SUGGESTION_SOURCE_731"] });
    const updated = await generateActivitySuggestions(deps);
    assert.equal(updated.cached, false);
    assert.equal(calls, 2, "同一输入重新分析后不能继续使用旧建议");
    assert.match(prompt, /NEW_SUGGESTION_SOURCE_731/u);
    const forced = await generateActivitySuggestions({ ...deps, force: true });
    assert.equal(forced.cached, false);
    assert.equal(calls, 3);
    const controller = new AbortController();
    const stream = model.stream.bind(model);
    model.stream = async (...args) => {
      controller.abort();
      return stream(...args);
    };
    let writes = 0;
    await assert.rejects(generateActivitySuggestions({
      ...deps, signal: controller.signal,
      cache: { get: () => undefined, set: () => { writes += 1; } }
    }), { name: "AbortError" });
    assert.equal(writes, 0, "取消后的建议不能进入缓存");
  });
}

async function testActivitySuggestionsUseExternalModel(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
    store.recordAnalysis({
      sessionId,
      analyzedAt: "2026-08-31T10:00:00.000Z",
      analyzerModel: "analyzer",
      summary: "有内容",
      topics: [],
      prs: [],
      issues: [],
      people: [],
      versions: [],
      decisions: [],
      entities: [],
      highlights: [],
      worthMemory: false,
      worthKnowledge: false,
      isMeeting: false,
      storageTier: "standard",
      confidence: 1,
      sourceEventCount: 3,
      inputHash: "external-suggestions-test"
    });
    let calls = 0;
    const model: AgentModel = {
      provider: "external",
      modelId: "cloud",
      runtime: "provider",
      stream: async () => {
        calls += 1;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: '["继续处理项目", "回顾近期决定", "检查当前进展", "整理下一步"]' };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const result = await generateActivitySuggestions({
      store,
      model,
      now: new Date("2026-09-01T12:00:00.000Z")
    });
    assert.deepEqual(result.suggestions, ["继续处理项目", "回顾近期决定", "检查当前进展", "整理下一步"]);
    assert.equal(result.reason, undefined);
    assert.equal(calls, 1);
  });
}

async function testTooFewSuggestionsAreRejected(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession("2026-09-23T09:00:00.000Z");
    store.endSession(sessionId, "2026-09-23T10:00:00.000Z");
    store.recordAnalysis({
      sessionId,
      analyzedAt: "2026-09-23T10:00:00.000Z",
      analyzerModel: "test",
      summary: "完成检索设计",
      topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
      worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
      confidence: 1, sourceEventCount: 3, inputHash: "count-test"
    });
    const model: AgentModel = {
      provider: "test", modelId: "count-test", runtime: "builtin-llama.cpp", dataResidency: "local",
      stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: '["看看检索设计", "继续完善检索", "回顾完成内容"]' };
        yield { type: "finish", reason: "stop" };
      })()
    };
    const result = await generateActivitySuggestions({ store, model, now: new Date("2026-09-24T09:00:00.000Z") });
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.reason, "generation_failed");
  });
}

async function withStore(run: (store: ActivityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-suggestions-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
