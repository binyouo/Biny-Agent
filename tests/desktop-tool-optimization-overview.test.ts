import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { buildToolOptimizationOverview } from "../src/session/toolOptimizationOverview.js";
import type { ToolOptimizationEntry } from "../src/session/toolOptimization.js";

test("overview preserves cumulative and negative savings while bounding daily, command and recent details", () => {
  const now = new Date(2026, 9, 21, 12);
  const entries: ToolOptimizationEntry[] = [
    { time: new Date(2000, 0, 1).toISOString(), optimization: {
      id: "ptc", kind: "ptc", estimator: "utf8/3", beforeTokens: 800, afterTokens: 100, savedTokens: 700, toolCalls: 3
    } },
    { time: new Date(2000, 0, 1).toISOString(), optimization: {
      id: "negative", kind: "rtk", estimator: "rtk", beforeTokens: 100, afterTokens: 120, savedTokens: -20, toolCalls: 1, command: "old", durationMs: 40
    } },
    ...Array.from({ length: 25 }, (_, i): ToolOptimizationEntry => ({
      time: new Date(2026, 9, 21, 0, i).toISOString(),
      optimization: { id: `rtk-${i}`, kind: "rtk", estimator: "rtk", beforeTokens: 100, afterTokens: 50,
        savedTokens: 50, toolCalls: 1, command: `command-${i}`, durationMs: 10 },
      origin: { projectId: "project", sessionId: "session", toolCallId: `call-${i}` }
    }))
  ];
  const result = buildToolOptimizationOverview([...entries, entries[0]!], now);
  assert.deepEqual(result.ptc, { runs: 1, beforeTokens: 800, afterTokens: 100, savedTokens: 700, ptcTokens: 700, rtkTokens: 0 });
  assert.deepEqual(result.rtk, { runs: 26, beforeTokens: 2600, afterTokens: 1370, savedTokens: 1230, ptcTokens: 0, rtkTokens: 1230 });
  assert.equal(result.toolCalls, 3);
  assert.equal(result.durationCount, 26);
  assert.equal(result.totalDurationMs, 290);
  assert.equal(result.average, 1230 / 26);
  assert.equal(result.daily.length, 30);
  assert.equal(result.daily[0]?.date, "2026-09-22");
  assert.equal(result.daily[0]?.runs, 0);
  assert.equal(result.daily.at(-1)?.savedTokens, 1250);
  assert.equal(result.commands.length, 10);
  assert.equal(result.recent.length, 20);
  assert.equal(result.recent[0]?.optimization.id, "rtk-24");
  assert.equal(result.recent.at(-1)?.optimization.id, "rtk-5");
  assert.deepEqual(result.recent[0]?.origin, { projectId: "project", sessionId: "session", toolCallId: "call-24" });
  const negative = buildToolOptimizationOverview([entries[1]!], new Date(2000, 0, 1, 12));
  assert.equal(negative.daily.at(-1)?.savedTokens, -20);
  assert.equal(negative.commands[0]?.savedTokens, -20);
  assert.equal(negative.recent[0]?.optimization.savedTokens, -20);
});

test("real cumulative queries skip catalog metadata and scoped queries do not open unrelated sessions", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-statistics-query-"));
  const previousRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const recorders: SessionRecorder[] = [];
  try {
    const state = new DesktopStateStore(path.join(root, "state.json")); await state.load();
    const storage = new DesktopUserDataStore(path.join(root, "desktop")); await storage.initialize();
    const config = createFileConfigStore(root, { globalDir: path.join(root, "config"), credentialStore: {
      persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
    } });
    const projects = new DesktopProjectService(state, storage, config);
    const firstPath = path.join(root, "first"); const secondPath = path.join(root, "second");
    await fs.mkdir(firstPath); await fs.mkdir(secondPath);
    const first = await projects.createProject(firstPath); const second = await projects.createProject(secondPath);
    for (const [project, id, savedTokens] of [[first, "target", 700], [first, "unrelated", 50], [second, "other-project", -20]] as const) {
      const recorder = new SessionRecorder(await projects.dataRoot(project), id); recorders.push(recorder);
      recorder.record({ type: "user_message", time: "2000-01-01T00:00:00.000Z", content: "statistics fixture" });
      recorder.record({ type: "tool_result", time: "2000-01-01T00:00:00.000Z", tool: "run_script", toolCallId: id,
        result: {}, optimization: { id, kind: "ptc", estimator: "utf8/3", beforeTokens: 800,
          afterTokens: 800 - savedTokens, savedTokens, toolCalls: 2 } });
      await recorder.close();
    }
    const opened: string[] = [];
    const original = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0])); return await original(...args);
    });
    const scoped = await projects.toolOptimizationStats("all", first.id, "target");
    assert.equal(scoped.entries[0]?.optimization.savedTokens, 700);
    assert.equal(opened.some(file => /(?:unrelated|other-project)\.jsonl$/u.test(file)), false);
    assert.equal(opened.some(file => file.includes(`${path.sep}.catalog${path.sep}`)), false);
    opened.length = 0;
    const all = await projects.toolOptimizationOverview("all");
    assert.equal(all.ptc.runs, 3); assert.equal(all.ptc.savedTokens, 730);
    assert.equal(all.incompleteSessions, 0);
    assert.equal("entries" in all, false, "Renderer receives the overview, not the whole receipt history");
    assert.equal(opened.some(file => file.includes(`${path.sep}.catalog${path.sep}`)), false);
    assert.equal(opened.filter(file => /target\.jsonl$/u.test(file)).length, 1, "summary and statistics must not each open the same log");
    const dated = await projects.toolOptimizationOverview(30, first.id, "target");
    assert.equal(dated.ptc.runs, 0, "date filtering still applies to an explicitly selected session");
    await fs.unlink(recorders[1]!.filePath);
    assert.equal((await projects.toolOptimizationOverview("all")).ptc.savedTokens, 680, "refresh observes deleted history");
    await fs.writeFile(recorders[0]!.filePath, "{bad json}\n");
    const partial = await projects.toolOptimizationOverview("all");
    assert.equal(partial.incompleteSessions, 1);
    assert.equal(partial.ptc.savedTokens, -20);
  } finally {
    for (const recorder of recorders) await recorder.close();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
