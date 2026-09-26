/** 成功回合的异步记忆任务须使用该回合的策略快照。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-turn-policy-"));
const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
let agent: AgentSession | undefined;
let releaseEmbedding: (() => void) | undefined;
try {
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig);
  config.context.memory.enabled = true;
  config.context.memory.generateMemories = true;
  config.context.memory.excludeExternalContext = false;
  const model: AgentModel = {
    provider: "memory-turn-policy-test",
    modelId: "memory-turn-policy-test",
    async stream() {
      return (async function* () {
        yield { type: "start" as const };
        yield { type: "text-delta" as const, text: "ok" };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  agent = new AgentSession({
    workspaceRoot, config, model, recorder: new SessionRecorder(workspaceRoot, "policy-snapshot"),
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" })
  });
  await agent.initialize();
  assert.equal((await agent.getPersonalizationState()).resolved.contributeMemories, true);
  let enteredEmbedding!: () => void;
  const embeddingEntered = new Promise<void>((resolve) => { enteredEmbedding = resolve; });
  const embeddingGate = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
  agent.getEmbeddingRuntime = async () => {
    enteredEmbedding();
    await embeddingGate;
    return {} as Awaited<ReturnType<AgentSession["getEmbeddingRuntime"]>>;
  };
  const observedPolicies: boolean[] = [];
  agent.getLocalMemory().summarizeAndStoreMemories = async (_messages, options) => {
    observedPolicies.push(options.excludeExternalContext);
    return { created: [], deleted: [] };
  };

  // Given: 回合 A 的自动记忆任务等待 embedding；When: 回合 B 刷新聊天策略；
  // Then: A 的提取仍使用 A 完成时的外部上下文门禁。
  const first = await agent.runTask("Remember the first completed turn and its original policy.");
  assert.equal(first.status, "completed", JSON.stringify(first));
  let deadline!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      embeddingEntered,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("memory task did not reach embedding")), 10_000);
      })
    ]);
  } finally {
    clearTimeout(deadline);
  }
  config.context.memory.excludeExternalContext = true;
  config.context.memory.generateMemories = false;
  await agent.runTask("A later turn changes the active policy.");
  releaseEmbedding();
  await agent.close();
  agent = undefined;
  assert.deepEqual(observedPolicies, [false]);
} finally {
  releaseEmbedding?.();
  await agent?.close();
  if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
  await rm(root, { recursive: true, force: true });
}
