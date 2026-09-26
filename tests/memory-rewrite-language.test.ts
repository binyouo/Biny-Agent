/** 自动记忆查询改写经过实际 Session 入口，并用确定性向量验证跨语言召回。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { BINY_AGENT_DIR_ENV, globalAgentDir } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-rewrite-language-"));
const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
const workspace = path.join(root, "workspace");
try {
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const config = structuredClone(defaultConfig);
  config.context.memory.enabled = true;
  config.context.memory.useMemories = true;
  config.context.memory.generateMemories = false;
  config.context.memory.queryRewrite = true;
  config.context.memory.maxRecalled = 1;
  let rewritePrompt = "";
  const modelRequests: string[] = [];
  const model: AgentModel = {
    provider: "fixture", modelId: "rewrite-language",
    stream: async (context) => {
      rewritePrompt = context.systemPrompt ?? "";
      modelRequests.push(JSON.stringify(context));
      const output = /always output in English/iu.test(rewritePrompt) ? "occupation job" : "我做什么工作";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: output };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const runtime: EmbeddingModelRuntime = {
    fingerprint: "rewrite-language-fp",
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "rewrite-language-fp",
      displayName: "fixture", dimensions: 2, source: "local", recommendedThreshold: 0.75
    },
    embed: async ({ texts }) => ({
      embeddings: texts.map((text) => text === "occupation job"
        ? new Float32Array([1, 0]) : new Float32Array([0, 1])),
      dimensions: 2, fingerprint: "rewrite-language-fp",
      model: { kind: "local", model: "multilingual-e5-small" }
    })
  };
  const agent = new AgentSession({ workspaceRoot: workspace, config, model,
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
    recorder: new SessionRecorder(workspace) });
  try {
    await agent.initialize();
    const written = await agent.getLocalMemory().writeEntry({ content: "The user's occupation is a software engineer." });
    assert.ok(written.entry);
    const scoped = await agent.getLocalMemory().writeEntry({
      content: "Private occupation job marker for another account.",
      userId: "other-account"
    });
    assert.ok(scoped.entry);
    const index = new MemoryVectorIndex(globalAgentDir());
    try {
      index.replaceAll(runtime.fingerprint, 2, [
        { entryId: written.entry.id, revision: written.entry.revision, embedding: new Float32Array([0.8, 0.6]) },
        { entryId: scoped.entry.id, revision: scoped.entry.revision, embedding: new Float32Array([1, 0]) }
      ]);
    } finally {
      index.close();
    }
    // 只替代外部 embedding 模型；Session、改写请求、事实库和 SQLite 向量搜索均走真实链路。
    const service = (agent as unknown as { memoryEmbeddingService: { embeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined> } }).memoryEmbeddingService;
    service.embeddingRuntime = async () => runtime;
    const recalled = await agent.searchMemory("我做什么工作", [], { limit: 2 });
    assert.match(rewritePrompt, /always output in English/iu);
    assert.equal(recalled.matches.some((match) => match.entry.id === written.entry!.id), true);
    await agent.runTask("What is my occupation job?");
    assert.equal(modelRequests.some((request) => request.includes("The user's occupation is a software engineer.")), true,
      "专属事实得分更高且只有一个召回名额时，自动召回仍须注入共享事实");
    assert.equal(modelRequests.some((request) => request.includes("Private occupation job marker for another account.")), false,
      "没有可信 actor 身份的自动召回不得注入其他用户的事实");
  } finally {
    await agent.close();
  }
} finally {
  if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
  await rm(root, { recursive: true, force: true });
}
