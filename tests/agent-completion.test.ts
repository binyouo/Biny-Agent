/** 普通运行自然收尾，不通过额外模型请求或完成声明证明任务达成。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function testNaturalCompletion(scenario: "answer" | "write" | "recovery" | "limit" | "length"): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-natural-completion-"));
  await ensureAgentDirs(workspaceRoot);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot, ignore: [] }));
  registry.registerBuiltinTool({
    name: "check", description: "Check the selected command", risk: "read",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    schema: z.object({ command: z.string() }),
    resolveExecution: (args) => ({ approvalRule: "check", execute: async () => {
      if (args.command === "wrong") throw new Error("command not found");
      return { ok: true };
    } })
  });
  let requests = 0;
  const model: AgentModel = {
    provider: "test", modelId: "natural-completion", supportsTools: true,
    async stream(context) {
      requests += 1;
      assert.ok(context.tools.length > 0, "ordinary runs must not invoke a tool-free completion judge");
      assert.equal(context.tools.some((tool) => tool.name === "attempt_completion"), false);
      assert.ok(requests <= 3, "natural completion must not inject continuation prompts");
      if (requests > 1 && !(scenario === "length" && requests === 2)) {
        assert.equal(context.messages.at(-1)?.role, "toolResult");
      }
      if (scenario === "length" && requests === 2) assert.equal(context.messages.at(-1)?.role, "user");
      const response: ModelStreamEvent[] = [];
      if ((scenario === "write" || scenario === "limit") && requests === 1) {
        response.push({ type: "tool-call", id: "write", name: "Write", arguments: { path: "result.txt", content: "written" } });
      } else if (scenario === "length" && requests <= 2) {
        response.push({ type: "tool-call", id: `length-write-${String(requests)}`, name: "Write", arguments: { path: "result.txt", content: "written" } });
      } else if (scenario === "recovery" && requests <= 2) {
        response.push({ type: "tool-call", id: `check-${requests}`, name: "check", arguments: { command: requests === 1 ? "wrong" : "correct" } });
      } else if (scenario === "notification") {
        response.push({ type: "text-delta", text: "已完成，结果已检查。\n\n<biny_notification>修复了登录崩溃，测试通过。</biny_notification>" });
      } else {
        response.push({ type: "text-delta", text: "已完成，结果已检查。" });
      }
      response.push({
        type: "finish",
        reason: scenario === "length" && requests === 1
          ? "length"
          : response[0]?.type === "tool-call" ? "tool-calls" : "stop"
      });
      return (async function* () { yield* response; })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    agent: { ...defaultConfig.agent, hardStepLimit: scenario === "limit" ? 1 : scenario === "write" ? 2 : 4 },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: registry, permissionManager: new PermissionManager(config.permission), recorder });
  try {
    await agent.initialize();
    const outcome = await agent.runTask("Perform the requested work and report the result", { confirmPermission: async () => ({ approved: true, scope: "once" }) });
    assert.equal(requests, scenario === "recovery" ? 3 : scenario === "write" ? 2 : 1);
    assert.equal(outcome.status, scenario === "limit" || scenario === "length" ? "incomplete" : "completed");
    if (scenario === "notification") {
      assert.equal(outcome.notification, "修复了登录崩溃，测试通过。");
      assert.equal(outcome.output.includes("<biny_notification>"), false, "通知块不能进入对外输出");
    }
    if (scenario !== "notification" && scenario !== "answer") assert.equal(outcome.notification, undefined);
    if (scenario === "limit" || scenario === "length") {
      assert.equal(outcome.stopReason, scenario === "limit" ? "hard_step_limit" : "model_length");
      assert.equal(outcome.resumable, true);
    }
    if (scenario === "write" || scenario === "limit") assert.equal(await readFile(path.join(workspaceRoot, "result.txt"), "utf8"), "written");
    if (scenario === "length") {
      await assert.rejects(readFile(path.join(workspaceRoot, "result.txt"), "utf8"), { code: "ENOENT" });
      let resumedOutcome;
      for await (const event of agent.continueInterruptedTurn({
        confirmPermission: async () => ({ approved: true, scope: "once" })
      })) {
        if (event.type === "done") resumedOutcome = event.outcome;
      }
      assert.equal(resumedOutcome?.status, "completed", JSON.stringify(resumedOutcome));
      assert.equal(requests, 3);
      assert.equal(await readFile(path.join(workspaceRoot, "result.txt"), "utf8"), "written");
    }
    await recorder.flush();
    const stored = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; content?: string });
    for (const type of ["user_message", "assistant_message"]) assert.ok(stored.some((event) => event.type === type));
    assert.equal(
      stored.some((event) => event.type === "assistant_message" && event.content?.includes("<biny_notification>")),
      false,
      "通知块不能进入 session 落盘"
    );
    if (scenario === "write" || scenario === "recovery" || scenario === "limit" || scenario === "length") {
      for (const type of ["tool_call", "tool_result"]) assert.ok(stored.some((event) => event.type === type));
    }
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

for (const scenario of ["answer", "write", "recovery", "limit", "length", "notification"] as const) await testNaturalCompletion(scenario);
console.log("agent natural completion tests passed");
