import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { configChangeRequiresRuntimeRestart, configDocumentRevision, restartRelevantConfig } from "../src/config/versioned.js";

test("服务商图标更换、移除不重启 Runtime，真实连接变更仍重启", () => {
  const before = structuredClone(defaultConfig) as AgentConfig;
  const alias = Object.keys(before.providers)[0]!;
  before.providers[alias]!.icon = "openai";
  const after = structuredClone(before);
  after.providers[alias]!.icon = "anthropic";
  assert.notEqual(configDocumentRevision(before), configDocumentRevision(after), "展示变更仍受版本冲突保护");
  assert.equal(configChangeRequiresRuntimeRestart(before, after), false, "图标变化不能重建所有驻留会话");
  delete after.providers[alias]!.icon;
  assert.equal(configChangeRequiresRuntimeRestart(before, after), false, "移除图标同样只改变展示");
  assert.equal(before.providers[alias]!.icon, "openai", "比较不修改原始配置");
  after.providers[alias]!.baseUrl = "https://example.invalid/other";
  assert.equal(configChangeRequiresRuntimeRestart(before, after), true, "同一供应商的真实请求端点变化仍须生效");
});

function withChange(mutate: (config: AgentConfig) => void): [AgentConfig, AgentConfig] {
  const before = structuredClone(defaultConfig) as AgentConfig;
  const after = structuredClone(defaultConfig) as AgentConfig;
  mutate(after);
  return [before, after];
}

test("记忆策略变更仍要求刷新驻留 Runtime", () => {
  // 别想当然：AgentSession 确实是每轮现读 activeConfig，但桌面端只有**当前项目**
  // 的 Runtime 会被推送新配置（DesktopAgentManager.updateGlobalPersonalization），
  // 其它驻留项目拿不到。所以 memory 变更必须留在"需要重建"这一侧，
  // 否则别的项目会静默保留旧的记忆策略。
  const cases: Array<[string, (config: AgentConfig) => void]> = [
    ["useMemories", (config) => { config.context.memory.useMemories = !config.context.memory.useMemories; }],
    ["generateMemories", (config) => { config.context.memory.generateMemories = !config.context.memory.generateMemories; }],
    ["sleepEnabled", (config) => { config.context.memory.sleepEnabled = !config.context.memory.sleepEnabled; }]
  ];
  for (const [name, mutate] of cases) {
    const [before, after] = withChange(mutate);
    assert.notEqual(configDocumentRevision(after), configDocumentRevision(before), `${name} 应当改变 revision`);
    assert.equal(configChangeRequiresRuntimeRestart(before, after), true, `${name} 应当要求刷新 Runtime`);
  }
});

test("main 侧即时读取的交互偏好不要求重启 Runtime", () => {
  const [before, after] = withChange((config) => {
    config.appshots = { ...config.appshots, hotkey: "ctrl+alt+z" };
  });
  assert.notEqual(configDocumentRevision(after), configDocumentRevision(before), "appshots 应当改变 revision");
  assert.equal(configChangeRequiresRuntimeRestart(before, after), false);
});

test("会改变进程行为的字段触发 Runtime 重启", () => {
  const cases: Array<[string, (config: AgentConfig) => void]> = [
    ["provider baseUrl", (config) => { config.providers.deepseek.baseUrl = "https://changed.example"; }],
    ["workspace ignore", (config) => { config.workspace = { ignore: [...config.workspace.ignore, "added"] }; }]
  ];
  for (const [name, mutate] of cases) {
    const [before, after] = withChange(mutate);
    assert.equal(configChangeRequiresRuntimeRestart(before, after), true, `${name} 应当要求重启 Runtime`);
  }
});

test("换默认模型触发 Runtime 重启", () => {
  const aliases = Object.keys(defaultConfig.models);
  const other = aliases.find((alias) => alias !== defaultConfig.defaultModel);
  assert.ok(other, "需要至少两个模型别名才能测这条");
  const [before, after] = withChange((config) => { config.defaultModel = other!; });
  assert.equal(configChangeRequiresRuntimeRestart(before, after), true);
});

test("无变化时不要求重启", () => {
  const config = structuredClone(defaultConfig) as AgentConfig;
  assert.equal(configChangeRequiresRuntimeRestart(config, structuredClone(config) as AgentConfig), false);
});

test("restartRelevantConfig 保留需要重启的字段、剔除即时偏好", () => {
  const projected = restartRelevantConfig(defaultConfig as AgentConfig) as Record<string, unknown>;
  assert.ok("providers" in projected, "providers 属于需要重启的字段");
  assert.ok("extensions" in projected, "extensions 属于需要重启的字段");
  assert.ok("context" in projected, "context 必须参与重启比较（其它驻留项目拿不到推送）");
  assert.equal("appshots" in projected, false, "appshots 由 main 即时读取，不应参与重启比较");
});
