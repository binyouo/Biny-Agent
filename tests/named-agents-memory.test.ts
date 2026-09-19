import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { runMemoryCommand } from "../src/agent/context/memoryCommands.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import {
  buildSubagentDefinitionsPrompt,
  findSubagentDefinition,
  loadSubagentDefinitions
} from "../src/extensions/agents.js";
import { createMemoryTools } from "../src/extensions/memory.js";
import { runSubagentTask, type SubagentOptions } from "../src/extensions/subagent.js";
import { createModelSettings } from "../src/llm/modelFactory.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { SubagentTaskIncompleteError, SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";
import type { AgentModel } from "../src/agent/core/types.js";
import type { MemoryEntryInput } from "../src/agent/context/memoryTypes.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-named-agents-"));
  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-named-agents-global-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  try {
    await testSubagentDefinitionLoading(workspaceRoot);
    await testSubagentDefinitionBoundaries(workspaceRoot);
    await testSubagentTaskManagerAgentThreading();
    await testSubagentBudgetExhaustionRejectsWithPartialFindings();
    await testMemoryTopicLifecycle();
    await testMemoryTools();
    await testMaintenanceScansDurableEntries();
    await testGlobalInstructionFile();
  } finally {
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testSubagentDefinitionLoading(workspaceRoot: string): Promise<void> {
  const projectDir = path.join(workspaceRoot, ".biny", "agents");
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "scout.md"), [
    "---",
    "name: scout",
    "description: Read-only reconnaissance over the repository.",
    "tools: Read, Grep, Read, write_file, multi_edit, apply_patch",
    "model: deepseek-v4-flash",
    "---",
    "Locate relevant files and report exact paths with line ranges."
  ].join("\n"), "utf8");
  // 文件名兜底命名 + 无 tools/model。
  await writeFile(path.join(projectDir, "Reviewer Agent.md"), [
    "---",
    "description: Reviews diffs for regressions.",
    "---",
    "Review the change set and report concrete risks."
  ].join("\n"), "utf8");
  // 缺 description 的定义应被跳过。
  await writeFile(path.join(projectDir, "invalid.md"), "---\nname: broken\n---\nBody only.", "utf8");

  const globalRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-agents-"));
  try {
    // 全局同名 scout 应被项目级覆盖；独有的 planner 应保留。
    await writeFile(path.join(globalRoot, "scout.md"), "---\ndescription: global scout\n---\nGlobal scout body.", "utf8");
    await writeFile(path.join(globalRoot, "planner.md"), "---\ndescription: Plans implementation steps.\n---\nProduce a step-by-step plan.", "utf8");

    const definitions = await loadSubagentDefinitions({
      workspaceRoot,
      projectPaths: [".biny/agents"],
      globalRoot
    });
    assert.deepEqual(definitions.map((definition) => definition.name).sort(), ["planner", "reviewer-agent", "scout"]);

    const scout = findSubagentDefinition(definitions, "Scout");
    assert.ok(scout);
    assert.equal(scout.scope, "project");
    assert.equal(scout.model, "deepseek-v4-flash");
    assert.deepEqual(scout.tools, ["Read", "Grep", "write_file", "multi_edit", "apply_patch"]);
    assert.match(scout.prompt, /exact paths with line ranges/);
    assert.equal(scout.path, path.join(".biny", "agents", "scout.md"));

    const planner = findSubagentDefinition(definitions, "planner");
    assert.equal(planner?.scope, "global");
    assert.equal(planner?.tools, undefined);

    const prompt = buildSubagentDefinitionsPrompt(definitions);
    assert.match(prompt, /Named subagents/);
    assert.match(prompt, /scout \(project, model deepseek-v4-flash, tools Read\/Grep\/write_file\/multi_edit\/apply_patch\)/);
    assert.match(prompt, /Task/);
    assert.equal(buildSubagentDefinitionsPrompt([]), "");
  } finally {
    await rm(globalRoot, { recursive: true, force: true });
  }
}

async function testSubagentDefinitionBoundaries(workspaceRoot: string): Promise<void> {
  const outside = await mkdtemp(path.join(os.tmpdir(), "biny-agents-outside-"));
  try {
    await writeFile(path.join(outside, "evil.md"), "---\ndescription: escaped\n---\nEscaped body.", "utf8");
    // 指向 workspace 外的软链文件应被跳过，不成为定义。
    const projectDir = path.join(workspaceRoot, ".biny", "agents");
    await symlink(path.join(outside, "evil.md"), path.join(projectDir, "evil.md"));
    const definitions = await loadSubagentDefinitions({
      workspaceRoot,
      projectPaths: [".biny/agents"],
      globalRoot: path.join(outside, "missing-global")
    });
    assert.ok(!definitions.some((definition) => definition.name === "evil"));

    // 配置目录本身是软链时必须硬失败。
    await symlink(outside, path.join(workspaceRoot, "linked-agents"));
    await assert.rejects(
      loadSubagentDefinitions({ workspaceRoot, projectPaths: ["linked-agents"], globalRoot: path.join(outside, "missing-global") }),
      /symbolic link/
    );
    // 越界路径同样拒绝。
    await assert.rejects(
      loadSubagentDefinitions({ workspaceRoot, projectPaths: ["../escape"], globalRoot: path.join(outside, "missing-global") }),
      /inside workspace/
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}

async function testSubagentTaskManagerAgentThreading(): Promise<void> {
  const seenAgents: Array<string | undefined> = [];
  const manager = new SubagentTaskManager({
    maxConcurrentSubagents: 1,
    timeoutMs: 5_000,
    execute: async (_task, context) => {
      seenAgents.push(context.agent);
      return "done";
    }
  });
  try {
    const withAgent = await manager.run("inspect the repo", { agent: "scout" });
    assert.equal(withAgent, "done");
    const withoutAgent = await manager.run("inspect the repo again");
    assert.equal(withoutAgent, "done");
    assert.deepEqual(seenAgents, ["scout", undefined]);
    const snapshots = manager.listSnapshots();
    assert.equal(snapshots.find((snapshot) => snapshot.agent === "scout")?.status, "completed");
  } finally {
    await manager.close();
  }
}

/** 模型每步都继续请求工具，验证步数预算截停时返回带标注的部分结论而不是抛错。 */
async function testSubagentBudgetExhaustionRejectsWithPartialFindings(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-subagent-partial-"));
  const originalFetch = globalThis.fetch;
  try {
    await ensureAgentDirs(workspaceRoot);
    let requestCount = 0;
    // 子代理走 Vercel streaming loop；每步都继续请求工具。
    globalThis.fetch = (async (): Promise<Response> => {
      requestCount += 1;
      return streamingCompletionResponse({
        id: `cmpl-${String(requestCount)}`,
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: `Inspect round ${String(requestCount)}.`,
            tool_calls: [{ id: `list-${String(requestCount)}`, type: "function", function: { name: "Glob", arguments: "{}" } }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });
    }) as typeof fetch;

    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "test-model",
      providers: { active: { type: "openai", apiKey: "test-key", baseUrl: "https://api.openai.com/v1" } },
      models: { "test-model": { provider: "active", model: "test-model" } },
      thinking: { enabled: false, effort: "high" },
      permission: defaultConfig.permission,
      workspace: defaultConfig.workspace,
      context: {
        ...defaultConfig.context,
        memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
      }
    });
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(listFilesTool());
    const options: SubagentOptions = {
      workspaceRoot,
      config,
      getModelSettings: () => createModelSettings(config),
      getAccessMode: () => "read-only",
      toolRegistry: registry
    };

    // 文案不再暗中缩小配置预算；预算停止必须保留部分交付但不能报告成功。
    await assert.rejects(runSubagentTask(options, "review the current repository state"), (error) => {
      assert.ok(error instanceof SubagentTaskIncompleteError);
      assert.equal(error.stopReason, "step_limit");
      assert.match(error.output, /Inspect round 1\./);
      return true;
    });
    assert.equal(requestCount, config.extensions.subagent.maxSteps);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function listFilesTool(): Tool {
  return {
    name: "Glob",
    description: "List workspace files.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    capability: "filesystem.list",
    risk: "read",
    resolveExecution() {
      return { approvalRule: "Glob", async execute() { return { files: ["src/index.ts"] }; } };
    }
  } as Tool;
}

function streamingCompletionResponse(payload: Record<string, unknown>): Response {
  const choice = (payload.choices as Array<{ index: number; message: { content: string; tool_calls: unknown[] }; finish_reason: string }>)[0];
  const chunks = [
    { choices: [{ index: choice.index, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: choice.index, delta: { content: choice.message.content }, finish_reason: null }] },
    { choices: [{ index: choice.index, delta: { tool_calls: choice.message.tool_calls }, finish_reason: null }] },
    { choices: [{ index: choice.index, delta: {}, finish_reason: choice.finish_reason }] }
  ];
  return new Response([
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`),
    "data: [DONE]"
  ].join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

function unusedModel(): AgentModel {
  return {
    provider: "test",
    modelId: "unused",
    async stream() {
      return (async function* () { /* explicit memory operations do not call the model */ })();
    }
  };
}

/** 扁平化后记忆只有 content 正文。 */
function projectEntry(content: string): MemoryEntryInput {
  return { content };
}

/** /memory 新语法：list / show <id> / add <note> / forget <id-or-text> / search / archived / restore。 */
async function testMemoryTopicLifecycle(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-cmd-"));
  try {
    const memory = new LocalMemory(workspaceRoot, unusedModel);

    const disabled = await runMemoryCommand(undefined, []);
    assert.match(disabled, /unavailable/);

    const empty = await runMemoryCommand(memory, ["list"]);
    assert.match(empty, /empty/);
    assert.deepEqual((await memory.listMemoryEntries()).entries, []);

    const added = await runMemoryCommand(memory, ["add", "Always run pnpm typecheck before committing changes."]);
    assert.match(added, /Saved memory /);

    const tooShort = await runMemoryCommand(memory, ["add", "too short"]);
    assert.match(tooShort, /Skipped/);

    const listed = await runMemoryCommand(memory, ["list"]);
    assert.match(listed, /typecheck/);

    const shown = await runMemoryCommand(memory, ["show", "typecheck"]);
    assert.match(shown, /pnpm typecheck/);

    const searchCalls: Array<{ query: string; paths: string[]; limit: number | undefined }> = [];
    const searchMemory = async (query: string, paths: string[], options: Parameters<LocalMemory["search"]>[2]) => {
      searchCalls.push({ query, paths, limit: options.limit });
      return await memory.search(query, paths, options);
    };
    const searched = await runMemoryCommand(memory, ["search", "typecheck"], searchMemory);
    assert.match(searched, /pnpm typecheck/);
    assert.deepEqual(searchCalls, [{ query: "typecheck", paths: [], limit: 8 }]);

    const forgotten = await runMemoryCommand(memory, ["forget", "typecheck"]);
    assert.match(forgotten, /Deleted 1 memory entry/);
    assert.deepEqual((await memory.listMemoryEntries()).entries, []);

    const missing = await runMemoryCommand(memory, ["forget", "typecheck"]);
    assert.match(missing, /No memory entry/);

    // 归档列表与恢复按 archive row id 定位。
    const reAdded = await runMemoryCommand(memory, ["add", "Review the diff with a second pass before pushing commits."]);
    assert.match(reAdded, /Saved memory /);
    const active = (await memory.listMemoryEntries()).entries[0];
    assert.ok(active);
    const archived = await memory.archiveEntry(active.id, true, { expectedRevision: (await memory.getOverview()).storeRevision });
    assert.equal(archived.archived, true);
    assert.ok(archived.entry);
    const archivedList = await runMemoryCommand(memory, ["archived"]);
    assert.match(archivedList, /Archived memory entries/);
    const restored = await runMemoryCommand(memory, ["restore", archived.entry.id]);
    assert.match(restored, /Restored 1 memory entry/);
    assert.equal((await memory.listMemoryEntries()).entries.length, 1);
    // 恢复出来的条目清理掉，保持记忆库为空，不污染后续用例的共享全局库。
    const restoredEntry = (await memory.listMemoryEntries()).entries[0];
    assert.ok(restoredEntry);
    const cleaned = await runMemoryCommand(memory, ["forget", restoredEntry.id]);
    assert.match(cleaned, /Deleted 1 memory entry/);
    assert.deepEqual((await memory.listMemoryEntries()).entries, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testMemoryTools(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-tools-"));
  try {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const [saveTool, recallTool] = createMemoryTools(() => memory);
    assert.equal(saveTool?.name, "save_memory");
    assert.equal(recallTool?.name, "recall_memory");
    assert.equal(saveTool.risk, "write");
    assert.equal(recallTool.risk, "read");

    const saveExecution = await saveTool.resolveExecution({
      content: "Releases are cut from main after pnpm test and pnpm typecheck pass.",
      tags: ["release", "main"],
      importance: 3
    });
    assert.ok(!("isError" in saveExecution));
    const saved = await saveExecution.execute({ toolCallId: "save-1" }) as { saved: boolean; id?: string; path?: string };
    assert.equal(saved.saved, true);
    assert.match(saved.path ?? "", /^memory:\/\/[a-z0-9-]+$/u);

    // 无效参数走 isError 分支而不是抛异常。
    const invalid = await saveTool.resolveExecution({ content: "short" });
    assert.ok("isError" in invalid);

    const recallExecution = await recallTool.resolveExecution({ query: "release main" });
    assert.ok(!("isError" in recallExecution));
    const recalled = await recallExecution.execute({ toolCallId: "recall-1" }) as { matches: Array<{ entry: { content: string } }> };
    assert.match(recalled.matches[0]?.entry.content ?? "", /Releases are cut from main/);

    const limitedExecution = await recallTool.resolveExecution({ query: "typecheck", limit: 5 });
    assert.ok(!("isError" in limitedExecution));
    const limited = await limitedExecution.execute({ toolCallId: "recall-2" }) as { matches: unknown[] };
    assert.equal(limited.matches.length, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testMaintenanceScansDurableEntries(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-maintenance-"));
  const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-memory-maintenance-agent-"));
  const previousAgentRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = agentRoot;
  try {
    const memory = new LocalMemory(workspaceRoot, unusedModel);
    const summary = "The same durable maintenance workflow is shared by every memory writer.";
    const first = await memory.writeEntry(projectEntry(summary), { expectedRevision: 0, now: new Date("2026-08-01T00:00:00.000Z") });
    const second = await memory.writeEntry(projectEntry(
      "A different durable note that will be edited into the same maintenance workflow text."
    ), { expectedRevision: first.revision, now: new Date("2026-08-01T00:30:00.000Z") });
    assert.ok(first.entry && second.entry);
    // updateEntry 不做写入期去重：用它构造一对同文行，供 Sleep exact 层无条件合并。
    const edited = await memory.updateEntry(second.entry.id, { content: summary }, { expectedRevision: second.revision, now: new Date("2026-08-01T01:00:00.000Z") });
    assert.equal(edited.written, true);

    let rebuilds = 0;
    const result = await memory.runMemoryMaintenance({ now: new Date("2026-08-01T07:00:00.000Z"), useLlm: false }, {
      requestRebuild: () => { rebuilds += 1; }
    });
    assert.equal(result.failed, 0);
    assert.equal(result.written, 0);
    assert.equal(rebuilds, 1);
    const entries = (await memory.listMemoryEntries()).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, second.entry.id, "较新的同文条目成为 survivor");
    const archived = (await memory.listArchivedEntries()).entries;
    assert.equal(archived.length, 1);
    assert.equal(archived[0]?.archivedReason, "exact_dup");
    const status = await memory.loadMaintenanceStatus();
    assert.equal(status.lastRun?.exact, 1);
  } finally {
    if (previousAgentRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(agentRoot, { recursive: true, force: true });
  }
}

async function testGlobalInstructionFile(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-global-instructions-"));
  const globalDir = await mkdtemp(path.join(os.tmpdir(), "biny-global-home-"));
  try {
    await writeFile(path.join(workspaceRoot, "AGENTS.md"), "Project instructions.", "utf8");
    const globalFile = path.join(globalDir, "AGENTS.md");
    await writeFile(globalFile, "Global instructions baseline.", "utf8");

    const workspace = new WorkspaceContext(workspaceRoot, [], 32 * 1024, globalFile);
    await workspace.initialize();
    const status = workspace.status();
    // 全局指令在项目指令之前加载；status 会把 home 下的路径规范化成 ~/ 形式，
    // 而沙箱里 TMPDIR 恰好落在 home 下，期望值得跟着规范化。
    const expectedGlobal = globalFile.startsWith(os.homedir())
      ? path.join("~", path.relative(os.homedir(), globalFile))
      : globalFile;
    assert.equal(status.loadedInstructions[0], expectedGlobal);
    assert.equal(status.loadedInstructions[1], "AGENTS.md");

    // 软链全局文件应被忽略。
    const linkedWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-global-linked-"));
    try {
      const linkPath = path.join(linkedWorkspace, "AGENTS.link.md");
      await symlink(globalFile, linkPath);
      const linked = new WorkspaceContext(linkedWorkspace, [], 32 * 1024, linkPath);
      await linked.initialize();
      assert.deepEqual(linked.status().loadedInstructions, []);
    } finally {
      await rm(linkedWorkspace, { recursive: true, force: true });
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  }
}

await main();
