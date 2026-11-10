/** 日报经真实 SQLite/REST 读取完整应用时长，并在分析来源变化后重建缓存。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyzeActivitySession } from "../src/activity/analyzer.js";
import { startActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { testModel } from "./helpers/model.js";

const date = "2026-08-26";
const at = (minutes: number) => new Date(2026, 7, 26, 9, minutes).toISOString();

async function fixture(run: (store: ActivityStore, report: () => Promise<{
  markdown: string; generatedAt: number; stats: { topApps: Array<{ app: string; minutes: number }>; clusterCount: number };
}>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-report-source-"));
  const store = new ActivityStore();
  let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
  try {
    const settings = { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "snapshots") };
    await store.open(settings.outputDirectory, root);
    endpoint = await startActivityHttpEndpoint({ agentDir: root, loadSettings: async () => settings });
    const report = async () => {
      const response = await fetch(`http://${endpoint!.host}:${endpoint!.port}/api/activity-recorder/report/${date}?format=json`, {
        headers: { Authorization: `Bearer ${endpoint!.token}` }
      });
      assert.equal(response.status, 200);
      return await response.json();
    };
    await run(store, report);
  } finally {
    await endpoint?.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seed(store: ActivityStore, minute = 0): string {
  const id = store.startSession(at(minute));
  store.recordEvent({ sessionId: id, occurredAt: at(minute), eventType: "app_focus", application: "Editor" });
  store.endSession(id, at(minute + 10));
  return id;
}

function analysis(id: string, title: string): ActivitySessionAnalysis {
  return { sessionId: id, title, summary: title, analyzedAt: at(60), analyzerModel: "test", topics: [],
    prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
    worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
    confidence: 1, sourceEventCount: 1, inputHash: title };
}

test("application switch after event 200 still divides report time between both apps", async () => {
  await fixture(async (store, report) => {
    const id = seed(store);
    for (let index = 1; index < 200; index += 1) {
      store.recordEvent({ sessionId: id, occurredAt: new Date(Date.parse(at(0)) + index * 1_000).toISOString(),
        eventType: "input_batch", application: "Editor", inputEventCount: 1 });
    }
    store.recordEvent({ sessionId: id, occurredAt: at(5), eventType: "app_focus", application: "Browser" });
    assert.deepEqual((await report()).stats.topApps.toSorted((a, b) => a.app.localeCompare(b.app)),
      [{ app: "Browser", minutes: 5 }, { app: "Editor", minutes: 5 }]);
  });
});

test("late analysis, reanalysis and deletion refresh a historical report without force", async () => {
  await fixture(async (store, report) => {
    const id = seed(store);
    assert.match((await report()).markdown, /尚未分析/u);
    store.recordAnalysis(analysis(id, "完成接口核对"));
    await report();
    const saved = store.getSummary("daily", date)!;
    store.upsertSummary({ ...saved, stats: { ...saved.stats, reportGeneratedAt: 1 } });
    const analyzed = await report();
    assert.equal(analyzed.generatedAt, 1, "来源未变化的历史报告不按时钟过期");
    assert.match(analyzed.markdown, /完成接口核对/u);
    assert.doesNotMatch(analyzed.markdown, /尚未分析/u);
    assert.deepEqual(await report(), analyzed, "来源不变时复用持久报告");
    const elsewhere = store.startSession(new Date(2026, 7, 25, 9).toISOString());
    store.endSession(elsewhere, new Date(2026, 7, 25, 10).toISOString());
    store.recordAnalysis(analysis(elsewhere, "另一日活动"));
    assert.deepEqual(await report(), analyzed, "其他日期的写入不使这一天失效");
    store.recordAnalysis(analysis(id, "修正后的核对结论"));
    assert.match((await report()).markdown, /修正后的核对结论/u);
    await store.deleteSession(id);
    assert.doesNotMatch((await report()).markdown, /修正后的核对结论/u);
  });
});

test("legacy person labels deduplicate with later handle-only records", async () => {
  await fixture(async (store, report) => {
    store.recordAnalysis({ ...analysis(seed(store), "首次讨论"), people: ["@alice (Alice)"] });
    store.recordAnalysis({ ...analysis(seed(store, 20), "继续讨论"), people: ["@ALICE"] });
    const journal = await report();
    assert.equal(journal.stats.clusterCount, 1);
    assert.equal(journal.markdown.match(/Alice \(@alice\)/gu)?.length, 1);
    assert.doesNotMatch(journal.markdown, /@ALICE/u);
  });
});

test("a persisted report without a source fingerprint is rebuilt once", async () => {
  await fixture(async (store, report) => {
    store.recordAnalysis(analysis(seed(store), "已保存的工作成果"));
    await report();
    const previous = store.getSummary("daily", date)!;
    delete previous.stats.reportState!.sourceHash;
    store.upsertSummary({ ...previous, stats: { ...previous.stats,
      report: "# 旧版缓存\n\n过时的内容。", reportGeneratedAt: 1 } });
    const refreshed = await report();
    assert.match(refreshed.markdown, /已保存的工作成果/u);
    assert.doesNotMatch(refreshed.markdown, /过时的内容/u);
    assert.ok(refreshed.generatedAt > 1);
    assert.deepEqual(await report(), refreshed);
  });
});

test("people retain structured names and cluster by case-insensitive handle", async () => {
  await fixture(async (store, report) => {
    const first = seed(store);
    const second = seed(store, 20);
    const model = testModel({ provider: "test", modelId: "people-fixture", stream: async () => (async function* () {
      yield { type: "text-delta", text: JSON.stringify({ worth: true, title: "讨论接口", summary: "讨论接口",
        people: [{ handle: "@alice", name: "Alice" }] }) };
      yield { type: "finish", reason: "stop" };
    })() });
    const result = await analyzeActivitySession({ store, model }, first);
    assert.equal(result.status, "analyzed", JSON.stringify(result));
    assert.deepEqual(store.getAnalysis(first)?.entityDetails?.people, [{ handle: "@alice", name: "Alice" }]);
    store.recordAnalysis({ ...analysis(second, "继续讨论接口"), people: ["@ALICE"] });
    const journal = await report();
    assert.equal(journal.stats.clusterCount, 1, "同一人的姓名变化不拆散主题");
    assert.match(journal.markdown, /- \*\*人\*\*: Alice \(@alice\)/u);
    assert.doesNotMatch(journal.markdown, /@ALICE/u);
  });
});
