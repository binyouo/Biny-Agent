/** 模型删除通过真实设置事务落盘；不启动界面、Host 或外部模型请求。 */
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveProjectSettings } from "../src/config/projectSettings.js";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { DesktopSettingsSaveInput } from "../src/desktop/protocol.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import { modelRuntimeInfo } from "../src/llm/ModelManager.js";
import { InMemoryModelsStore } from "../src/llm/ModelsStore.js";

const baseModels: AgentConfig["models"] = {
  previous: { provider: "local", model: "previous-model", thinkingLevelMap: { high: "high" } },
  remaining: { provider: "local", model: "remaining-model", thinkingLevelMap: { low: "low" } }
};

for (const explicit of [true, false]) {
  test(`删除默认模型时投影旧高档，${explicit ? "显式低档选择" : "自动选择剩余模型"}可以保存`, async () => {
    await withSettings({}, async (f) => {
      const result = await f.save({ upserts: [], removeAliases: ["previous"],
        defaultModel: explicit ? { alias: "remaining", thinking: "low" } : undefined });
      assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
      const saved = await f.reload();
      assert.equal(saved.models.previous, undefined);
      assert.equal(saved.defaultModel, "remaining");
      assert.deepEqual(saved.thinking, { enabled: true, effort: "low" });
      const snapshot = await f.settings.snapshot(f.projectId);
      assert.equal(snapshot.models.defaultModel, "remaining");
      assert.equal(snapshot.models.thinking, "low");
      assert.equal(snapshot.pendingRecovery, undefined);
      await assert.rejects(access(f.journal), { code: "ENOENT" });
    });
  });
}

test("移除服务商下多个模型时，每次默认模型替换都保持有效且最终显式选择不被投影覆盖", async () => {
  await withSettings({
    providers: {
      local: { type: "openai-compatible", baseUrl: "https://model-removal.invalid/v1", requiresApiKey: false },
      retained: { type: "openai-compatible", baseUrl: "https://model-removal.invalid/other/v1", requiresApiKey: false }
    },
    models: {
      previous: baseModels.previous!,
      middle: { provider: "local", model: "middle-model", thinkingLevelMap: { max: "max" } },
      remaining: { ...baseModels.remaining!, provider: "retained" },
      selected: { provider: "retained", model: "selected-model", thinkingLevelMap: { off: "none", medium: "medium" } }
    },
    toolModel: "previous"
  }, async (f) => {
    const result = await f.save({ upserts: [], removeAliases: [], removeProviderAliases: ["local"],
      defaultModel: { alias: "selected", thinking: "off" } });
    assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
    const saved = await f.reload();
    assert.deepEqual(Object.keys(saved.models), ["remaining", "selected"]);
    assert.equal(saved.providers.local, undefined);
    assert.equal(saved.toolModel, undefined);
    assert.equal(saved.defaultModel, "selected");
    assert.equal(saved.thinking.enabled, false);
    assert.equal((await f.settings.snapshot(f.projectId)).models.thinking, "off");
  });
});

for (const removeAliases of [["previous", "middle"], ["middle", "previous"]]) {
  test(`批量删除 ${removeAliases.join(" → ")} 只按最终保留的模型继承思考选择`, async () => {
    await withSettings({ models: {
      previous: baseModels.previous!,
      middle: { provider: "local", model: "plain-middle" },
      remaining: { provider: "local", model: "remaining-model", thinkingLevelMap: { off: "none", high: "high" } }
    } }, async (f) => {
      const result = await f.save({ upserts: [], removeAliases });
      assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
      const saved = await f.reload();
      assert.equal(saved.defaultModel, "remaining");
      assert.deepEqual(saved.thinking, { enabled: true, effort: "high" });
    });
  });
}

for (const explicit of [true, false]) {
  test(`模型选项覆盖与别名元数据不同不会阻止${explicit ? "显式关闭思考" : "继承有效配置"}`, async () => {
    await withSettings({
      providers: { local: { type: "openai-compatible", baseUrl: "https://model-removal.invalid/v1", requiresApiKey: false,
        modelProfiles: { "remaining-model": { thinkingLevelMap: { off: "none", low: "low" } } } } },
      models: { previous: baseModels.previous!,
        remaining: { provider: "local", model: "remaining-model", thinkingLevelMap: { off: "none", high: "high" } } }
    }, async (f) => {
      const result = await f.save({ upserts: [], removeAliases: ["previous"],
        defaultModel: explicit ? { alias: "remaining", thinking: "off" } : undefined });
      assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
      const saved = await f.reload();
      assert.equal(saved.defaultModel, "remaining");
      assert.equal(saved.thinking.enabled, !explicit);
      assert.equal((await f.settings.snapshot(f.projectId)).models.thinking, explicit ? "off" : "high");
      assert.equal(modelRuntimeInfo(saved).thinking, explicit ? "off" : "low");
    });
  });
}

for (const reversed of [false, true]) {
  for (const declaration of ["map", "reasoning"] as const) {
    test(`继承档位按规范顺序投影，不受 ${declaration} 的${reversed ? "反向" : "正向"}声明顺序影响`, async () => {
      const efforts = reversed ? ["max", "low"] as const : ["low", "max"] as const;
      await withSettings({ models: { previous: baseModels.previous!,
        remaining: { provider: "local", model: "remaining-model",
          thinkingLevelMap: declaration === "map" ? Object.fromEntries(efforts.map((effort) => [effort, effort])) : undefined,
          reasoning: declaration === "reasoning" ? { efforts: [...efforts], defaultEffort: "low" } : undefined
        }
      } }, async (f) => {
        const result = await f.save({ upserts: [], removeAliases: ["previous"] });
        assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
        assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "max" });
      });
    });
  }
}

test("reasoning 声明的低档模型保留配置接受的档位名称", async () => {
  await withSettings({ models: { previous: baseModels.previous!,
    remaining: { provider: "local", model: "remaining-model", reasoning: {
      efforts: ["low"], defaultEffort: "low", mapping: { low: "enabled" }
    } }
  } }, async (f) => {
    const result = await f.save({ upserts: [], removeAliases: ["previous"] });
    assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
    assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "low" });
  });
});

test("删除默认模型后剩余模型明确关闭推理时，保存的思考状态同步关闭", async () => {
  await withSettings({ models: {
    previous: baseModels.previous!,
    remaining: { provider: "local", model: "plain-model", compatibility: { supportsReasoning: false } }
  } }, async (f) => {
    const result = await f.save({ upserts: [], removeAliases: ["previous"] });
    assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
    assert.equal((await f.reload()).thinking.enabled, false);
    assert.equal((await f.settings.snapshot(f.projectId)).models.thinking, "off");
  });
});

test("删除非默认模型不会改变现有默认模型的思考选择", async () => {
  await withSettings({}, async (f) => {
    const result = await f.save({ upserts: [], removeAliases: ["remaining"] });
    assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
    const saved = await f.reload();
    assert.equal(saved.defaultModel, "previous");
    assert.deepEqual(saved.thinking, { enabled: true, effort: "high" });
  });
});

for (const scenario of ["invalid-effort", "last-model", "project-default"] as const) {
  test(`拒绝${scenario}删除不会写入候选模型或修改原配置`, async () => {
    await withSettings({}, async (f) => {
      if (scenario === "project-default") await saveProjectSettings(f.workspace, { defaultModel: "previous" });
      const before = await f.reload();
      const result = await f.save({ upserts: [],
        removeAliases: scenario === "last-model" ? ["previous", "remaining"] : ["previous"],
        defaultModel: scenario === "invalid-effort" ? { alias: "remaining", thinking: "high" } : undefined });
      assert.equal(result.status, "rolled_back", "message" in result ? result.message : undefined);
      assert.equal(result.draftRetained, true);
      assert.match(result.message ?? "", scenario === "invalid-effort" ? /does not support high effort/u
        : scenario === "last-model" ? /至少需要保留/u : /settings\.json/u);
      assert.deepEqual(await f.reload(), before);
      assert.equal((await f.settings.snapshot(f.projectId)).pendingRecovery, undefined);
      await assert.rejects(access(f.journal), { code: "ENOENT" });
    });
  });
}

async function withSettings(overrides: Partial<AgentConfig>, run: (fixture: {
  workspace: string;
  projectId: string;
  settings: DesktopSettingsTransaction;
  journal: string;
  save(models: NonNullable<DesktopSettingsSaveInput["models"]>): ReturnType<DesktopSettingsTransaction["save"]>;
  reload(): Promise<AgentConfig>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-model-removal-"));
  const previousGlobal = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  const workspace = path.join(root, "workspace");
  let agents: DesktopAgentManager | undefined;
  try {
    await mkdir(workspace);
    const credentials = {
      persistent: false,
      get: async () => undefined,
      set: async () => { throw new Error("Unexpected credential write"); },
      delete: async () => { throw new Error("Unexpected credential deletion"); }
    };
    const configRoot = path.join(root, "config");
    const configStore = new DesktopConfigStore(configRoot, credentials);
    await configStore.save(configSchema.parse({
      ...defaultConfig,
      defaultModel: "previous",
      providers: { local: { type: "openai-compatible", baseUrl: "https://model-removal.invalid/v1", requiresApiKey: false } },
      models: baseModels,
      thinking: { enabled: true, effort: "high" },
      ...overrides
    }), workspace);
    const storage = new DesktopUserDataStore(path.join(root, "desktop"));
    await storage.initialize();
    const state = new DesktopStateStore(path.join(root, "state.json"));
    await state.load();
    const projects = new DesktopProjectService(state, storage, configStore);
    const project = await projects.createProject(workspace);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined, undefined, new InMemoryModelsStore(), async () => {
      throw new Error("Unexpected external model request");
    });
    const settings = new DesktopSettingsTransaction(state, agents);
    await run({
      workspace, projectId: project.id, settings, journal: state.settingsTransactionJournalPath(),
      save: async (models) => {
        const before = await settings.snapshot(project.id);
        return await settings.save(project.id, settingsSaveInputSchema.parse({
          expectedConfigRevision: before.configRevision, expectedPreferenceRevision: before.preferenceRevision, models
        }));
      },
      reload: async () => await new DesktopConfigStore(configRoot, credentials).load(workspace)
    });
  } finally {
    await agents?.closeAll();
    if (previousGlobal === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousGlobal;
    await rm(root, { recursive: true, force: true });
  }
}
