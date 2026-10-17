import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";
import type { Tool } from "../src/tools/types.js";

interface ExecutableTool {
  execute(toolCallId: string, input: Record<string, unknown>): Promise<unknown>;
}

async function testConcurrentToolResultBudget(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-result-concurrent-"));
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(workspaceRoot);
    const config = structuredClone(defaultConfig) as AgentConfig;
    config.context.maxTurnToolResultBytes = 1_024;
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    registry.register(largeResultTool());
    recorder = new SessionRecorder(workspaceRoot, "concurrent-archive-test");
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot,
      config,
      recorder,
      toolRegistry: registry
    }, new PermissionManager(config.permission), () => undefined);
    const tool = nativeTool(coordinator, "large_result");

    const results = await Promise.all([
      tool.execute("parallel-first", {}),
      tool.execute("parallel-second", {})
    ]);
    const archivedCount = results.filter((result) => {
      if (typeof result !== "object" || result === null) return false;
      return (result as { archived?: unknown }).archived === true;
    }).length;
    assert.equal(archivedCount, 1, "parallel results must reserve the shared turn budget independently");
    assert.equal(results.filter((result) => {
      if (typeof result !== "object" || result === null) return false;
      return (result as { result?: unknown }).result === "x".repeat(768);
    }).length, 1);
  } finally {
    await recorder?.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-result-archive-"));
  try {
    await ensureAgentDirs(workspaceRoot);
    const config = structuredClone(defaultConfig) as AgentConfig;
    config.context.maxTurnToolResultBytes = 1_024;
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    registry.register(largeResultTool());
    registry.register(createReadFileTool({ workspaceRoot, ignore: config.workspace.ignore }));
    const recorder = new SessionRecorder(workspaceRoot, "archive-test");
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot,
      config,
      recorder,
      toolRegistry: registry
    }, new PermissionManager(config.permission), () => undefined);
    const tool = nativeTool(coordinator, "large_result");

    const first = await tool.execute("first", {});
    const second = await tool.execute("second", {}) as Record<string, unknown>;
    assert.equal(typeof first, "object");
    assert.equal(second.archived, true);
    assert.equal(Number(second.resultBytes) > 768, true);
    assert.equal(typeof second.preview, "string");
    assert.equal(typeof second.archivePath, "string");

    const archivePath = path.join(agentDir(workspaceRoot), "tool-results", path.basename(String(second.archivePath)));
    const archive = JSON.parse(await readFile(archivePath, "utf8")) as { output?: string };
    const originalResult = JSON.parse(archive.output ?? "{}") as { result?: string };
    assert.equal(originalResult.result, "x".repeat(768));

    // 普通工作区解析仍拒绝运行目录；Read 只为受校验的归档引用提供受限入口。
    assert.throws(() => resolveWorkspacePath(workspaceRoot, String(second.archivePath), config.workspace.ignore));
    const reader = nativeTool(coordinator, "Read");
    const reread = await reader.execute("reread", { path: second.archivePath }) as Record<string, unknown>;
    assert.equal(reread.tool, "large_result");
    assert.equal(String(reread.content).includes("x".repeat(768)), true);
    assert.equal(reread.hasMore, false);

    // 归档引用之外的路径一律拒绝，工具参数不能借它读到任意文件。
    for (const escape of ["../../etc/passwd", ".biny/sessions/archive-test.jsonl", ".biny/tool-results/../sessions/x.jsonl"]) {
      const denied = await coordinator.createAgentTools().find((tool) => tool.name === "Read")!.execute(`escape-${escape}`, { path: escape });
      assert.equal(denied.isError, true, `${escape} should be refused`);
      assert.equal((denied.details as Record<string, unknown>).content, undefined);
    }

    // 预算是模型侧的上限：超额后每条结果都塌缩成引用，preview 不会每步再塞一份。
    let inlineBytes = 0;
    for (let index = 0; index < 12; index += 1) {
      const later = await tool.execute(`overflow-${String(index)}`, {});
      inlineBytes += Buffer.byteLength(JSON.stringify(later), "utf8");
    }
    assert.equal(inlineBytes < 12 * 768, true, `later results should collapse to references, saw ${String(inlineBytes)} bytes`);
    await recorder.close();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** 持久化层外置：回合预算内（模型拿全文）但超过行内落盘上限的结果，JSONL 里只留归档引用。 */
async function testPersistLevelOutlining(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-result-persist-"));
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(workspaceRoot);
    const config = structuredClone(defaultConfig) as AgentConfig;
    // 回合预算放大到不会触发模型侧归档，隔离出持久化层的行为。
    config.context.maxTurnToolResultBytes = 16 * 1024 * 1024;
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    registry.register(hugeResultTool());
    recorder = new SessionRecorder(workspaceRoot, "persist-outline-test");
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot,
      config,
      recorder,
      toolRegistry: registry
    }, new PermissionManager(config.permission), () => undefined);
    const tool = nativeTool(coordinator, "huge_result");

    // 模型侧结果保持全文（预算内），不因落盘外置而缩水。
    const modelFacing = await tool.execute("persist-1", {}) as Record<string, unknown>;
    assert.equal(JSON.stringify(modelFacing).includes("y".repeat(64 * 1024)), true, "model-facing result must stay full");

    const persistedResults = (await readFile(recorder.filePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; result?: Record<string, unknown> })
      .filter((event) => event.type === "tool_result");
    assert.equal(persistedResults.length, 1, "exactly one tool_result event should be persisted");
    const persisted = persistedResults[0]!;
    assert.equal(persisted.result?.archived, true, "oversized result must be archived out of the JSONL");
    assert.equal(typeof persisted.result?.archivePath, "string");
    assert.equal(typeof persisted.result?.preview, "string");
    // JSONL 里不允许再出现全文：整份文件必须远小于 64KB 的原始结果。
    const fileBytes = Buffer.byteLength(await readFile(recorder.filePath, "utf8"), "utf8");
    assert.equal(fileBytes < 32 * 1024, true, `session file must stay lean, got ${String(fileBytes)} bytes`);

    // 归档文件保留全文，Read 可取回。
    const archive = JSON.parse(await readFile(path.join(agentDir(workspaceRoot), "tool-results", path.basename(String(persisted.result!.archivePath))), "utf8")) as { output?: string };
    assert.equal(JSON.parse(archive.output ?? "{}").result, "y".repeat(64 * 1024));
    await recorder.close();
  } finally {
    await recorder?.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** 专用投影必须先于回合预算，且不能改变 session/UI 中看到的完整结果。 */
async function testProjectionBeforeTurnBudget(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-result-projection-budget-"));
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(workspaceRoot);
    const config = structuredClone(defaultConfig) as AgentConfig;
    config.context.maxTurnToolResultBytes = 1_024;
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    registry.register(projectedWriteTool());
    const events: AgentSessionEvent[] = [];
    recorder = new SessionRecorder(workspaceRoot, "projection-budget-test");
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot,
      config,
      recorder,
      toolRegistry: registry
    }, new PermissionManager(config.permission), (event) => events.push(event));
    const tool = nativeTool(coordinator, "write");

    const modelFacing = await tool.execute("projection-write", { path: "src/example.ts", content: "new" }) as Record<string, unknown>;
    assert.equal(modelFacing.archived, true);
    assert.equal(typeof modelFacing.archivePath, "string");
    assert.equal(typeof modelFacing.addedLines, "number");
    assert.equal(modelFacing.diffPreview, undefined);

    const completed = events.find((event) => event.type === "tool.completed");
    assert.equal(completed?.type === "tool.completed" ? typeof completed.result.change.diff : "undefined", "string");
    const persisted = (await readFile(recorder.filePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; result?: Record<string, unknown> })
      .find((event) => event.type === "tool_result");
    assert.equal(typeof persisted?.result?.archivePath, "string");
    const archive = JSON.parse(await readFile(path.join(agentDir(workspaceRoot), "tool-results", path.basename(String(persisted?.result?.archivePath))), "utf8")) as { output?: string };
    assert.equal(JSON.parse(archive.output ?? "{}").change.diff, `@@\n-${"old\n".repeat(12_000)}\n+new`);
    await recorder.close();
  } finally {
    await recorder?.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function projectedWriteTool(): Tool<{ path: string; content: string }, Record<string, unknown>> {
  return {
    name: "write",
    description: "Return a large write result for projection tests.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false
    },
    schema: z.object({ path: z.string(), content: z.string() }),
    risk: "read",
    resolveExecution(args) {
      return {
        approvalRule: "projected_write",
        async execute() {
          return {
            change: { operation: "update", path: args.path, committed: true,
              bytes: Buffer.byteLength(args.content, "utf8"), diff: `@@\n-${"old\n".repeat(12_000)}\n+new` },
            changeSummary: `Overwrite ${args.path}`
          };
        }
      };
    }
  };
}

function hugeResultTool(): Tool<Record<string, never>, string> {
  return {
    name: "huge_result",
    description: "Return a result that exceeds the inline persistence limit.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "read",
    resolveExecution() {
      return {
        approvalRule: "huge_result",
        async execute() {
          return "y".repeat(64 * 1024);
        }
      };
    }
  };
}

function largeResultTool(): Tool<Record<string, never>, string> {
  return {
    name: "large_result",
    description: "Return a deliberately large read-only result.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "read",
    resolveExecution() {
      return {
        approvalRule: "large_result",
        async execute() {
          return "x".repeat(768);
        }
      };
    }
  };
}

function nativeTool(coordinator: ToolExecutionCoordinator, name: string): ExecutableTool {
  const tool = coordinator.createAgentTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return {
    execute: async (toolCallId, input) => {
      const result = await tool.execute(toolCallId, input);
      return result.details ?? result;
    }
  };
}

await testConcurrentToolResultBudget();
await testPersistLevelOutlining();
await testProjectionBeforeTurnBudget();
await main();
