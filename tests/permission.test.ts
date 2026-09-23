import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { loadConfig, saveConfig } from "../src/config/loader.js";
import { createFileConfigStore, type AgentConfigStore } from "../src/config/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { subagentAccessMode } from "../src/runtime/subagentAccess.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const baseRequest: PermissionRequestContext = {
  toolName: "Write",
  actionType: "write",
  riskLevel: "medium",
  targetPath: "src/example.ts",
  sessionId: "test-session",
  projectRoot: "/workspace"
};

async function main(): Promise<void> {
  testEvaluationOrder();
  testScopedGrants();
  testMoveChangeEvaluatesBothPaths();
  testPathRulesMatchAnyDepth();
  testSubagentAccessInheritsMode();
  testDefaultPermissionMode();
  await testPermissionModeWriteKeepsOtherSettings();
  await testModelSwitchKeepsPermissionMode();
  await testCredentialRefreshKeepsConcurrentPermissionMode();
  await testConcurrentModelAndPermissionUpdates();
}

function testEvaluationOrder(): void {
  const manager = new PermissionManager({
    mode: "full-access",
    allowTools: ["Write"],
    denyPaths: ["private/"],
    criticalAlwaysAsk: true
  });

  assert.deepEqual(
    manager.evaluate({ ...baseRequest, targetPath: "private/keys.txt" }),
    { decision: "deny", reason: "Target path is denied by project policy: private/" }
  );

  manager.setMode("read-only");
  assert.deepEqual(
    manager.evaluate(baseRequest),
    { decision: "deny", reason: "Permission mode is read only." }
  );

  manager.setMode("full-access");
  const critical = manager.evaluate({ ...baseRequest, riskLevel: "critical", targetPath: ".zshrc" });
  assert.equal(critical.decision, "allow");
  const destructive = analyzePermissionRequest({ toolName: "Bash", args: { command: "rm -rf recipe-state && ls -la" }, sessionId: "test-session", projectRoot: "/workspace" });
  assert.equal(destructive.riskLevel, "critical");
  assert.equal(manager.evaluate(destructive).decision, "allow");
  for (const mode of ["ask", "auto"] as const) {
    manager.setMode(mode);
    assert.equal(manager.evaluate(destructive).decision, "ask");
    assert.equal(manager.evaluate({ ...baseRequest, riskLevel: "critical" }).decision, "ask", "关键操作仍优先于允许列表");
  }
  manager.setMode("read-only");
  assert.equal(manager.evaluate(destructive).decision, "deny");
  manager.setMode("full-access");
  assert.equal(manager.evaluate(destructive).decision, "allow");

  const readOnly = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [] });
  assert.equal(readOnly.evaluate({ ...baseRequest, toolName: "Read", actionType: "read", riskLevel: "low" }).decision, "allow");
  assert.equal(readOnly.evaluate(baseRequest).decision, "ask");
}

function testScopedGrants(): void {
  const manager = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [] });
  const exactCommand = {
    ...baseRequest,
    toolName: "Bash",
    actionType: "shell" as const,
    command: "pnpm typecheck",
    approvalRule: "Bash:hash-one"
  };
  manager.applyResult(exactCommand, { approved: true, scope: "command" });
  assert.equal(manager.evaluate(exactCommand).decision, "allow");
  assert.equal(manager.evaluate({ ...exactCommand, approvalRule: "Bash:hash-two", command: "pnpm test" }).decision, "ask");

  manager.applyResult(baseRequest, { approved: true, scope: "path" });
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "src/nested/example.ts" }).decision, "ask");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "src/example.ts" }).decision, "allow");

  manager.applyResult(baseRequest, { approved: true, scope: "tool" });
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "another/file.ts" }).decision, "allow");
  manager.resetSession();
  assert.equal(manager.evaluate(baseRequest).decision, "ask");

  // Always Allow 动作由权限层落成当前请求的最小稳定范围；不传 scope 也不能退化成一次性批准。
  const actionManager = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [] });
  actionManager.applyResult(baseRequest, { approved: true, action: "allow_always", scope: undefined });
  assert.equal(actionManager.evaluate(baseRequest).decision, "allow");
  assert.equal(actionManager.evaluate({ ...baseRequest, targetPath: "src/other.ts" }).decision, "ask");

  const basenameManager = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [] });
  const rootConfig = { ...baseRequest, targetPath: "config.json" };
  basenameManager.applyResult(rootConfig, { approved: true, action: "allow_always", scope: undefined });
  assert.equal(basenameManager.evaluate(rootConfig).decision, "allow");
  assert.equal(
    basenameManager.evaluate({ ...rootConfig, targetPath: "packages/api/config.json" }).decision,
    "ask",
    "具体文件授权不能沿用配置规则的 basename 匹配语义"
  );
}

function testMoveChangeEvaluatesBothPaths(): void {
  const manager = new PermissionManager({ mode: "full-access", allowTools: [], denyPaths: ["release/"] });
  const input = { toolName: "Edit", args: {}, sessionId: "test-session", projectRoot: "/workspace" };

  // denyPaths 必须同时看 from 和 to:只看 from 会让「移动到受保护路径」绕过项目策略。
  const bypass = analyzePermissionRequest({ ...input, fileChange: { operation: "move", path: "ok.txt", destinationPath: "release/config.yaml" } });
  assert.deepEqual(manager.evaluate(bypass), {
    decision: "deny",
    reason: "Target path is denied by project policy: release/"
  });

  // 风险取 from/to 两者较高者。
  const toSensitive = analyzePermissionRequest({ ...input, fileChange: { operation: "move", path: "ok.txt", destinationPath: ".env" } });
  assert.equal(toSensitive.riskLevel, "high");
  assert.equal(toSensitive.reason, "modifies a sensitive file");
  assert.equal(toSensitive.targetPath, "ok.txt");
  assert.equal(toSensitive.secondaryTargetPath, ".env");

  const fromSensitive = analyzePermissionRequest({ ...input, fileChange: { operation: "move", path: ".env", destinationPath: "ok.txt" } });
  assert.equal(fromSensitive.riskLevel, "high");
  assert.equal(fromSensitive.reason, "modifies a sensitive file");

  const toShellProfile = analyzePermissionRequest({ ...input, fileChange: { operation: "move", path: "ok.txt", destinationPath: ".zshrc" } });
  assert.equal(toShellProfile.riskLevel, "critical");

  const benign = analyzePermissionRequest({ ...input, fileChange: { operation: "move", path: "a.txt", destinationPath: "b.txt" } });
  assert.equal(benign.riskLevel, "medium");
  assert.equal(benign.targetPath, "a.txt");
  assert.equal(benign.secondaryTargetPath, "b.txt");
}

function testPathRulesMatchAnyDepth(): void {
  const manager = new PermissionManager({ mode: "ask", allowTools: [], denyPaths: [".env", "secrets/"] });
  // 无斜杠规则按 basename 匹配任意层级。
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "packages/api/.env" }).decision, "deny");
  // 顶层行为不变。
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: ".env" }).decision, "deny");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: ".env.local" }).decision, "deny");
  // 带尾斜杠的目录规则匹配任意层级同名目录。
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "packages/api/secrets/key.pem" }).decision, "deny");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "packages/api/secrets" }).decision, "deny");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "secrets/key.pem" }).decision, "deny");
  // 不命中时不误伤:basename 不同或目录名只是前缀都不算。
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "src/config/env.ts" }).decision, "ask");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "packages/api/secretsmith/key.pem" }).decision, "ask");
  assert.equal(manager.evaluate({ ...baseRequest, targetPath: "src/.env.example" }).decision, "deny");

  const defaults = new PermissionManager({ mode: "full-access" });
  assert.equal(defaults.evaluate({ ...baseRequest, targetPath: "packages/api/node_modules/pkg/index.js" }).decision, "allow");
  const exact = new PermissionManager({ mode: "full-access", denyPaths: ["nested/secret.txt"] });
  assert.equal(exact.evaluate({ ...baseRequest, targetPath: "nested" }).decision, "deny", "renaming an ancestor must not bypass an explicit path rule");
  assert.equal(exact.evaluate({ ...baseRequest, actionType: "read", targetPath: "nested" }).decision, "allow");
  assert.equal(exact.evaluate({ ...baseRequest, targetPath: "/workspace/nested/secret.txt" }).decision, "deny");
  assert.equal(exact.evaluate({ ...baseRequest, targetPath: "nested/ordinary.txt" }).decision, "allow");
}

function testSubagentAccessInheritsMode(): void {
  const manager = new PermissionManager({ mode: "ask" });
  assert.equal(subagentAccessMode(manager), "read-only");
  manager.setMode("auto");
  assert.equal(subagentAccessMode(manager), "read-only");
  manager.setMode("full-access");
  assert.equal(subagentAccessMode(manager), "workspace");
}

function testDefaultPermissionMode(): void {
  assert.equal(defaultConfig.permission.mode, "full-access");
  assert.equal(new PermissionManager().getStatus().mode, "full-access");

  const legacy = structuredClone(defaultConfig) as Record<string, unknown>;
  delete legacy.permission;
  assert.equal(configSchema.parse(legacy).permission.mode, "full-access");
}

/**
 * 改权限模式不能把配置文件里别处的改动写回旧值。
 *
 * 运行时内存里的 config 是创建时的快照；桌面端多个项目共用同一份配置，别的运行时切完模型后
 * 这份快照就落后了。整份写回会让「改一次权限模式，模型被切回去」。
 */
async function testPermissionModeWriteKeepsOtherSettings(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-permission-config-"));
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-permission-global-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const onDisk = configSchema.parse({
      ...defaultConfig,
      defaultModel: "disk-model",
      providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
      models: {
        "disk-model": { provider: "active", model: "disk" },
        "stale-model": { provider: "active", model: "stale" }
      },
      thinking: { enabled: false, effort: "high" },
      permission: { ...defaultConfig.permission, mode: "ask" }
    });
    await saveConfig(workspaceRoot, onDisk, { globalDir: globalRoot });
    const configStore = createFileConfigStore(workspaceRoot, { globalDir: globalRoot });

    const staleSnapshot = configSchema.parse({ ...onDisk, defaultModel: "stale-model" });
    const agent = new AgentSession({
      workspaceRoot,
      config: staleSnapshot,
      configStore,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(staleSnapshot.permission),
      recorder: new SessionRecorder(workspaceRoot)
    });
    await agent.setPermissionMode("auto");
    await agent.close();

    const persisted = await loadConfig(workspaceRoot, { globalDir: globalRoot });
    assert.equal(persisted.permission.mode, "auto");
    assert.equal(persisted.defaultModel, "disk-model");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testModelSwitchKeepsPermissionMode(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-model-permission-config-"));
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-model-permission-global-"));
  const apiKeyEnv = "BINY_TEST_MODEL_PERMISSION_API_KEY";
  const previousApiKey = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "test-key";
  try {
    await ensureAgentDirs(workspaceRoot);
    const onDisk = modelPermissionConfig(apiKeyEnv, "full-access");
    await saveConfig(workspaceRoot, onDisk, { globalDir: globalRoot });
    const configStore = createFileConfigStore(workspaceRoot, { globalDir: globalRoot });
    const staleSnapshot = configSchema.parse({
      ...onDisk,
      permission: { ...onDisk.permission, mode: "ask" }
    });
    const manager = new ModelManager(workspaceRoot, staleSnapshot, configStore);

    await manager.switchModel("second", "off");

    const persisted = await loadConfig(workspaceRoot, { globalDir: globalRoot });
    assert.equal(persisted.defaultModel, "second");
    assert.equal(persisted.permission.mode, "full-access");
  } finally {
    if (previousApiKey === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previousApiKey;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testConcurrentModelAndPermissionUpdates(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-concurrent-model-permission-"));
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-concurrent-model-permission-global-"));
  const apiKeyEnv = "BINY_TEST_CONCURRENT_MODEL_PERMISSION_API_KEY";
  const previousApiKey = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "test-key";
  let agent: AgentSession | undefined;
  try {
    await ensureAgentDirs(workspaceRoot);
    const onDisk = modelPermissionConfig(apiKeyEnv, "ask");
    await saveConfig(workspaceRoot, onDisk, { globalDir: globalRoot });
    const configStore = createFileConfigStore(workspaceRoot, { globalDir: globalRoot });
    const staleSnapshot = configSchema.parse({ ...onDisk });
    const manager = new ModelManager(workspaceRoot, configSchema.parse({ ...staleSnapshot }), configStore);
    agent = new AgentSession({
      workspaceRoot,
      config: configSchema.parse({ ...staleSnapshot }),
      configStore,
      toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(staleSnapshot.permission),
      recorder: new SessionRecorder(workspaceRoot)
    });

    await Promise.all([
      agent.setPermissionMode("full-access"),
      manager.switchModel("second", "off")
    ]);

    const persisted = await loadConfig(workspaceRoot, { globalDir: globalRoot });
    assert.equal(persisted.defaultModel, "second");
    assert.equal(persisted.permission.mode, "full-access");
  } finally {
    await agent?.close();
    if (previousApiKey === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previousApiKey;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
}

/** OAuth 刷新只能写回当前 provider，不能把内存快照里的旧权限模式一并覆盖。 */
async function testCredentialRefreshKeepsConcurrentPermissionMode(): Promise<void> {
  const onDisk = configSchema.parse({
    ...defaultConfig,
    defaultModel: "active-model",
    providers: {
      active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" }
    },
    models: {
      "active-model": { provider: "active", model: "active-model" }
    },
    permission: { ...defaultConfig.permission, mode: "full-access" }
  });
  let stored = structuredClone(onDisk);
  let revision = 0;
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(stored),
    save: async () => { throw new Error("OAuth refresh must use saveVersioned."); },
    loadVersioned: async () => ({ config: structuredClone(stored), revision: String(revision) }),
    saveVersioned: async (candidate, expectedRevision) => {
      assert.equal(expectedRevision, String(revision));
      stored = structuredClone(candidate);
      revision += 1;
      return { config: structuredClone(stored), revision: String(revision) };
    }
  };
  const staleSnapshot = configSchema.parse({
    ...onDisk,
    permission: { ...onDisk.permission, mode: "ask" }
  });
  const manager = new ModelManager("/tmp/biny-oauth-permission-refresh", staleSnapshot, configStore);
  const refreshed = { ...onDisk.providers.active!, timeoutMs: 12_345 };
  const runtime = manager as unknown as {
    runtime: { refreshActiveCredential(): Promise<typeof refreshed | undefined> };
  };
  runtime.runtime.refreshActiveCredential = async () => refreshed;

  await manager.preparePrompt();

  assert.equal(stored.permission.mode, "full-access");
  assert.equal(stored.providers.active?.timeoutMs, 12_345);
}

function modelPermissionConfig(apiKeyEnv: string, permissionMode: "ask" | "full-access") {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "first",
    providers: {
      active: {
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv
      }
    },
    models: {
      first: { provider: "active", model: "first", contextWindow: 128_000 },
      second: { provider: "active", model: "second", contextWindow: 128_000 }
    },
    permission: { ...defaultConfig.permission, mode: permissionMode }
  });
}

await main();
