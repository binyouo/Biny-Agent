/** REST 日报保留已保存但未分析的会话提示，不能把待分析记录显示为空白的一天。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";

test("REST text and JSON reports preserve pending-analysis warnings on fresh and persisted reports", { timeout: 15_000 }, async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-report-pending-notice-"));
  const outputDirectory = path.join(agentDir, "activity");
  const store = new ActivityStore();
  let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
  try {
    await store.open(outputDirectory, agentDir);
    const started = new Date(2026, 7, 26, 9);
    const sessionId = store.startSession(started.toISOString());
    store.recordEvent({ sessionId, occurredAt: started.toISOString(), eventType: "app_focus", application: "Fixture Editor" });
    store.endSession(sessionId, new Date(2026, 7, 26, 9, 10).toISOString());
    endpoint = await startActivityHttpEndpoint({
      agentDir,
      loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory }),
      getModel: () => { throw new Error("Skeleton or cached reports must not resolve a model"); }
    });
    const url = `http://${endpoint.host}:${endpoint.port}/api/activity-recorder/report/2026-08-26`;
    const headers = { Authorization: `Bearer ${endpoint.token}` };
    const readReport = async (query: string): Promise<string> => {
      const response = await fetch(`${url}${query}`, { headers });
      assert.equal(response.status, 200);
      if (!query.includes("format=json")) return await response.text();
      const report = await response.json() as { markdown: string; stats: { sessionCount: number; analyzedCount: number } };
      assert.equal(report.stats.sessionCount, 1);
      assert.equal(report.stats.analyzedCount, 0);
      return report.markdown;
    };

    const freshText = await readReport("?skeletonOnly=1");
    assert.match(freshText, /还有 1 个已结束会话尚未分析，上面的日记只覆盖已分析的部分。/u,
      "A saved session awaiting analysis needs an explicit coverage warning in the public text response");
    const stored = store.getSummary("daily", "2026-08-26")!;
    assert.equal(stored.stats.reportState?.pendingModel, 1);
    assert.equal(store.getSessionDetail(sessionId)?.analysis, undefined, "Reading a report must not analyze the session");
    await store.close();
    await store.open(outputDirectory, agentDir);
    assert.equal(await readReport(""), freshText, "The persisted-cache response must keep the warning");
    assert.equal(await readReport("?format=json"), freshText, "JSON markdown must preserve the same coverage warning");
    assert.equal(await readReport("?skeletonOnly=1&format=json"), freshText, "Fresh JSON must preserve the warning too");
    assert.equal((await readReport("?format=json")).match(/上面的日记只覆盖已分析的部分/g)?.length, 1,
      "Repeated reads must not append duplicate warnings to the cached report");
    const emptyResponse = await fetch(url.replace("2026-08-26", "2026-08-27") + "?skeletonOnly=1", { headers });
    assert.equal(emptyResponse.status, 200);
    assert.equal(await emptyResponse.text(), "# 2026-08-27 打工日记\n\n今天没有可分析的活动记录。",
      "A day with no recorded sessions must not gain a pending-analysis warning");
  } finally {
    await endpoint?.close();
    await store.close();
    await rm(agentDir, { recursive: true, force: true });
  }
});
