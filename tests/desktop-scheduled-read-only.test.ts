/** 日期侧栏只能读取持久化任务，不能替未启动的项目迁移 Runtime 数据库。 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { DesktopTemporalMemoryService, readScheduledTemporalSources } from "../src/desktop/temporalMemoryService.js";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runtimeHostPaths } from "../src/runtime/RuntimeHost.js";
import { agentDir } from "../src/session/store.js";
import { SessionRecorder } from "../src/session/recorder.js";

test("日期任务查询不创建数据库、不启动 Host，旧 schema 必须显式启动后迁移", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-scheduled-read-only-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  const projects = new DesktopProjectService(state, storage, configStore);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  try {
    await state.load();
    await storage.initialize();
    const project = await projects.createEmptyProject(path.join(root, "workspace"));
    const databasePath = path.join(agentDir(project.path), "runtime.sqlite");
    configStore.load = async () => { throw new Error("日期查询不得加载 Provider 或创建 Runtime"); };
    assert.deepEqual(await manager.scheduledAutomations(project.id), []);
    await assert.rejects(access(databasePath), { code: "ENOENT" });

    const writer = await RuntimeEventAuthority.open(project.path, { backfillLegacySessions: false });
    let record;
    try {
      const store = await AutomationStore.open(project.path, writer);
      try {
        record = store.create({ name: "已保存的提醒", triggerType: "interval", schedule: { intervalMs: 60_000 }, executionTemplate: { prompt: "提醒" } });
      } finally { store.close(); }
      // v12 只新增会话目标表和索引；还原真实 v11 schema，保留已有任务事实。
      writer.databaseHandle().exec(`
        DROP TABLE session_goal_usage;
        DROP TABLE session_goals;
        DROP INDEX agent_runs_continuation_source_idx;
        PRAGMA user_version = 11;
      `);
    } finally { writer.close(); }
    const before = await readFile(databasePath);
    await assert.rejects(manager.scheduledAutomations(project.id), /requires an explicit runtime startup/u);
    assert.deepEqual(await readFile(databasePath), before, "日期浏览不得迁移旧数据库");
    const legacy = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(legacy.prepare("PRAGMA user_version").get()?.user_version, 11);
      assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'session_goals'").get(), undefined);
    } finally { legacy.close(); }

    // 一个旧 schema 和一个损坏库不能阻断健康项目的提醒或原始消息线索。
    const healthy = await projects.createEmptyProject(path.join(root, "healthy"));
    const corrupt = await projects.createEmptyProject(path.join(root, "corrupt"));
    const empty = await projects.createEmptyProject(path.join(root, "empty"));
    const missing = await projects.createEmptyProject(path.join(root, "missing"));
    await state.upsertProject({ ...missing, missing: true });
    const corruptPath = path.join(agentDir(corrupt.path), "runtime.sqlite");
    await writeFile(corruptPath, "not a SQLite database");
    const corruptBefore = await readFile(corruptPath);
    const healthyWriter = await RuntimeEventAuthority.open(healthy.path, { backfillLegacySessions: false });
    let reminder;
    try {
      const store = await AutomationStore.open(healthy.path, healthyWriter);
      try {
        reminder = store.create({ name: "健康项目提醒", triggerType: "once", schedule: { at: "2099-01-01T09:00:00Z" }, executionTemplate: { prompt: "提醒" } });
      } finally { store.close(); }
    } finally { healthyWriter.close(); }
    const healthyBefore = await readFile(healthyWriter.databasePath);
    const recorder = new SessionRecorder(healthy.path, "healthy-history");
    recorder.record({ type: "user_message", content: "2099-01-01开会" });
    await recorder.close();
    const allProjects = [healthy, project, corrupt, empty, missing];
    const scheduled = await readScheduledTemporalSources({}, allProjects, async (id) => await manager.scheduledAutomations(id));
    assert.deepEqual(scheduled.sources, [
      { projectId: healthy.id, automations: [reminder] },
      { projectId: empty.id, automations: [] },
      { projectId: missing.id, automations: [] }
    ]);
    assert.deepEqual(scheduled.warnings, [
      { projectId: project.id, projectName: project.name },
      { projectId: corrupt.id, projectName: corrupt.name }
    ]);
    assert.equal(JSON.stringify(scheduled.warnings).includes(root), false, "不返回底层异常中的路径");
    const temporal = new DesktopTemporalMemoryService(process.env[BINY_AGENT_DIR_ENV]);
    try {
      const page = await temporal.query({ startDate: "2099-01-01", endDate: "2099-01-02", timeZone: "UTC" }, allProjects, scheduled.sources);
      assert.deepEqual(page.scheduled.map((row) => row.automationId), [reminder.automationId]);
      assert.ok(page.clues.some((clue) => clue.projectId === healthy.id && clue.quote.includes("开会")));
    } finally { await temporal.close(); }
    assert.deepEqual(await readFile(databasePath), before);
    assert.deepEqual(await readFile(corruptPath), corruptBefore);
    assert.deepEqual(await readFile(healthyWriter.databasePath), healthyBefore);
    for (const untouched of [empty, missing]) {
      await assert.rejects(access(path.join(agentDir(untouched.path), "runtime.sqlite")), { code: "ENOENT" });
    }
    for (const query of [{ includeScheduled: false }, { offset: 50 }]) {
      assert.deepEqual(await readScheduledTemporalSources(query, allProjects, async () => {
        assert.fail("关闭定时任务或翻页时不得读取任何项目的 Runtime 数据库");
      }), { sources: [], warnings: [] });
    }

    // 显式运行路径仍可迁移；之后重复浏览保持任务与数据库原样。
    const upgraded = await RuntimeEventAuthority.open(project.path, { backfillLegacySessions: false });
    upgraded.close();
    const current = await readFile(databasePath);
    for (let index = 0; index < 2; index += 1) {
      assert.deepEqual(await manager.scheduledAutomations(project.id), [record]);
      assert.deepEqual(await readFile(databasePath), current);
    }
    assert.equal(manager.hasRunningTasks(), false);
    await assert.rejects(access(runtimeHostPaths(project.path).registrationPath), { code: "ENOENT" });
    await assert.rejects(access(runtimeHostPaths(project.path).lockPath), { code: "ENOENT" });
  } finally {
    await manager.closeAll();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
