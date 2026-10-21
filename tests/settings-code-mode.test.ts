import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import { InMemoryModelsStore } from "../src/llm/ModelsStore.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("Code Mode settings commit through real transactions to disk and the next model request; stale saves cannot undo the mode", { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-settings-code-mode-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const configRoot = path.join(root, "agent");
  process.env.BINY_AGENT_DIR = configRoot;
  let manager: DesktopAgentManager | undefined;
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await mkdir(path.join(workspace, ".git"));
    const config = structuredClone(defaultConfig);
    config.context.memory.enabled = false;
    config.context.identity.enabled = false;
    config.checkpoints.enabled = false;
    config.chat.skillExtraction.enabled = false;
    await saveConfigFile(configRoot, config);
    const originalAgent = (await loadConfigFile(configRoot)).agent;
    const credentials = new Map<string, string>();
    const store = new DesktopConfigStore(configRoot, { persistent: true,
      get: async (key) => credentials.get(key), set: async (key, value) => { credentials.set(key, value); },
      delete: async (key) => { credentials.delete(key); }
    });
    const state = new DesktopStateStore(path.join(root, "desktop.json"));
    await state.load();
    const projects = new DesktopProjectService(state, new DesktopUserDataStore(path.join(root, "desktop")), store);
    const project = await projects.createProject(workspace);
    manager = new DesktopAgentManager(state, projects, store, () => {}, async () => {}, new InMemoryModelsStore(),
      async () => { throw new Error("Unexpected network request"); });
    const transaction = new DesktopSettingsTransaction(state, manager);
    assert.equal((await transaction.snapshot(project.id)).toolExecutionMode, "code_mode");
    for (const mode of ["direct", "code_mode"] as const) {
      const before = await transaction.snapshot(project.id);
      const rtkEnabled = mode === "code_mode";
      const input = { rtkEnabled, expectedPreferenceRevision: before.preferenceRevision, expectedConfigRevision: before.configRevision, toolExecutionMode: mode };
      assert.throws(() => settingsSaveInputSchema.parse({ ...input, toolExecutionMode: "automatic" }));
      const saved = await transaction.save(project.id, settingsSaveInputSchema.parse(input));
      assert.equal(saved.status, "committed", JSON.stringify(saved));
      assert.deepEqual(saved.appliedFields, ["rtkEnabled", "toolExecutionMode"]);
      assert.equal(saved.snapshot.rtkEnabled, rtkEnabled);
      assert.equal(saved.snapshot.toolExecutionMode, mode);
      const stored = await loadConfigFile(configRoot);
      assert.deepEqual(stored.agent, { ...originalAgent, rtkEnabled, toolExecutionMode: mode });
      assert.equal((await transaction.snapshot(project.id)).toolExecutionMode, mode);
      const stale = await transaction.save(project.id, { ...input, toolExecutionMode: before.toolExecutionMode });
      assert.equal(stale.status, "rolled_back");
      assert.equal((await loadConfigFile(configRoot)).agent.toolExecutionMode, mode);
      let modelCalls = 0;
      const model: AgentModel = testModel({ provider: "fixture", modelId: "settings-code-mode", supportsTools: true,
        async stream(context) {
          modelCalls++;
          assert.equal(context.tools.some((tool) => tool.name === "run_script"), mode === "code_mode");
          assert.ok(context.tools.some((tool) => tool.name === "Write"));
          return (async function* () { yield { type: "text-delta" as const, text: "mode inspected" }; yield { type: "finish" as const, reason: "stop" as const }; })();
        }
      });
      const recorder = new SessionRecorder(workspace, `settings-${mode}`);
      const agent = new AgentSession({ workspaceRoot: workspace, config: await store.load(workspace), model, recorder,
        permissionManager: new PermissionManager(stored.permission), toolRegistry: createToolRegistry({ workspaceRoot: workspace, ignore: [] }) });
      try {
        await agent.initialize();
        const outcome = await agent.runTask("Inspect tool availability", { capabilitySelection: { tools: ["Write"], skills: "none" }, emotionAnalysis: false });
        assert.equal(outcome.status, "completed", outcome.error);
        assert.equal(modelCalls, 1);
      } finally { await agent.close(); await recorder.close(); }
    }
    const statsRecorder = new SessionRecorder(workspace, "optimization-stats");
    const optimization = { id: "stable-operation", kind: "ptc" as const, estimator: "utf8/3" as const, beforeTokens: 900, afterTokens: 100, savedTokens: 800, toolCalls: 2 };
    try {
      statsRecorder.record({ type: "user_message", content: "fixture" });
      statsRecorder.record({ type: "tool_call", tool: "run_script", toolCallId: "a", args: { code: "return 1" } });
      statsRecorder.record({ type: "tool_result", tool: "run_script", toolCallId: "a", result: { value: 1 }, optimization });
      statsRecorder.record({ type: "tool_result", tool: "run_script", toolCallId: "a", result: { value: 1 }, optimization });
      await statsRecorder.flush();
      const stats = await projects.toolOptimizationStats(7, project.id, "optimization-stats");
      assert.equal(stats.entries.length, 1, "stored duplicate receipts must not increase statistics");
      assert.equal(stats.entries[0]?.optimization.savedTokens, 800);
      assert.equal(stats.incompleteSessions, 0);
      assert.deepEqual(stats.entries[0]?.origin, { projectId: project.id, sessionId: "optimization-stats", toolCallId: "a" });
      const detail = await projects.toolOptimizationDetail(project.id, "optimization-stats", "a");
      assert.ok(detail.events.some(event => event.type === "tool_call" && (event.args as { code?: string } | undefined)?.code === "return 1"));
      assert.ok(detail.events.every(event => event.type !== "user_message"));
      assert.equal(buildSessionTimeline(detail.events, []).flatMap(turn => turn.tools).find(tool => tool.id === "a")?.tool, "run_script");
      await assert.rejects(projects.toolOptimizationDetail(project.id, "optimization-stats", "missing"));
      statsRecorder.record({ type: "tool_call", time: "2000-01-01T00:00:00.000Z", tool: "Bash", toolCallId: "old", args: { command: 'git log --oneline -5' } });
      statsRecorder.record({ type: "tool_result", time: "2000-01-01T00:00:01.000Z", tool: "Bash", toolCallId: "old", result: {}, optimization: { ...optimization, id: "old-operation", kind: "rtk", command: "git log" } });
      await statsRecorder.flush();
      assert.equal((await projects.toolOptimizationStats(30, project.id, "optimization-stats")).entries.length, 1);
      const cumulative = await projects.toolOptimizationStats("all", project.id, "optimization-stats");
      assert.equal(cumulative.entries.length, 2);
      assert.equal(cumulative.entries.find(entry => entry.optimization.id === "old-operation")?.optimization.originalCommand, "git log --oneline -5");
    } finally { await statsRecorder.close(); }
  } finally {
    await manager?.closeAll();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
