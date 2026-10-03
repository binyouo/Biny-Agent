/** 原任务工具选择与本轮发现结果在终态断点续跑时保留，不继承更早任务的发现范围。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";

async function testSelectionRecovery(mode: "none" | "manual" | "discovered", steering = false): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `biny-tool-selection-${mode}${steering ? "-steering" : ""}-`));
  await ensureAgentDirs(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "input.txt"), "stable input");
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createReadFileTool({ workspaceRoot, ignore: [] }));
  for (const name of ["previous_task_tool", "current_task_tool"]) registry.registerBuiltinTool({
    name, description: `Read ${name}.`, risk: "read", parameters: { type: "object", properties: {} }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: name, accesses: ToolAccesses.none(), async execute() { return { ok: true }; } })
  });
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
  let phase: "history" | "target" | "resumed" = "history";
  let historySteps = 0;
  let resumedSteps = 0;
  let requestStarted!: () => void;
  const targetRequest = new Promise<void>((resolve) => { requestStarted = resolve; });
  let releaseRequest!: () => void;
  const targetGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const model: AgentModel = {
    provider: "fixture", modelId: "tool-selection-recovery", supportsTools: true,
    async stream(context) {
      let response: ModelStreamEvent[];
      if (phase === "history" && historySteps++ === 0) {
        response = [
          { type: "tool-call", id: "history-search", name: "ToolSearch", arguments: { query: "previous_task_tool" } },
          { type: "finish", reason: "tool-calls" }
        ];
      } else if (phase === "target") {
        if (steering) {
          requestStarted();
          await targetGate;
        }
        if (mode === "none") {
          assert.deepEqual(context.tools, []);
          response = [{ type: "text-delta", text: "Partial response." }, { type: "finish", reason: steering ? "stop" : "length" }];
        } else {
          const names = context.tools.map((tool) => tool.name);
          assert.ok(!names.includes("previous_task_tool"), "a new selected task starts without the previous task's discovered tool");
          response = [
            mode === "manual"
              ? { type: "tool-call", id: "target-read", name: "Read", arguments: { path: "input.txt" } }
              : { type: "tool-call", id: "target-search", name: "ToolSearch", arguments: { query: "current_task_tool" } },
            { type: "finish", reason: "tool-calls" }
          ];
        }
      } else {
        if (phase === "resumed") {
          resumedSteps++;
          const expected = mode === "none" ? [] : mode === "manual" ? ["Read", "exec"] : ["ToolSearch", "current_task_tool", "exec"];
          assert.deepEqual(context.tools.map((tool) => tool.name).sort(), expected.sort(), "terminal continuation must preserve original selection and only current-task discovery");
          assert.ok(context.messages.at(-1)?.role === "user", "terminal continuation retains its synthetic user instruction without treating it as new selection authority");
        }
        response = [{ type: "text-delta", text: "Complete." }, { type: "finish", reason: "stop" }];
      }
      return (async function* () { yield* response; })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    chat: { ...defaultConfig.chat, defaultToolSelection: "none" },
    agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" },
    permission: { ...defaultConfig.permission, mode: "full-access" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const sessionId = recorder.sessionId;
  let agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: registry, recorder, permissionManager: new PermissionManager(config.permission) });
  try {
    await agent.initialize();
    const historical = await agent.runTask("Find a tool for the previous task", {
      emotionAnalysis: false, capabilitySelection: { tools: ["ToolSearch"], skills: "none" }, maxSteps: 3
    });
    assert.equal(historical.status, "completed", historical.error);
    phase = "target";
    const targetRun = agent.runTask("Continue this selected task", {
      emotionAnalysis: false,
      capabilitySelection: { tools: mode === "none" ? "none" : mode === "manual" ? ["Read"] : ["ToolSearch"], skills: "none" },
      maxSteps: 1
    });
    if (steering) {
      try {
        await bounded(targetRequest, "target model request");
        await agent.queueSteering("target-steering", "Retain the selected tools and continue carefully");
      } finally {
        releaseRequest();
      }
    }
    const interrupted = await bounded(targetRun, "selected task interruption");
    assert.equal(interrupted.status, "incomplete", interrupted.error);
    assert.equal(interrupted.resumable, true);
    assert.equal(interrupted.stopReason, mode === "none" && !steering ? "model_length" : "hard_step_limit");
    assert.ok((await agent.interruptedTurn())?.terminal, "selection recovery must cover terminal checkpoints");
    if (steering) {
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const original = events.find((event) => event.type === "user_message" && event.content === "Continue this selected task");
      const receipt = events.find((event) => event.type === "user_message" && event.messageId === "target-steering" && event.auditOnly);
      const canonical = events.find((event) => event.type === "user_message" && event.messageId === "target-steering" && !event.auditOnly);
      assert.ok(original?.runtime?.turnId, "the selected task has a durable turn identity");
      assert.ok(receipt?.type === "user_message" && receipt.metadata?.queuedDelivery === "steer", "steering receipt records its delivery source");
      assert.ok(canonical?.type === "user_message", "steering must be delivered as a canonical message before interruption");
      assert.equal(canonical.metadata?.capabilitySelection, undefined, "canonical steering has no new selection authority");
      assert.equal(canonical.metadata?.queuedDelivery, undefined, "delivery evidence stays on the separate durable receipt");
      assert.equal(receipt.runtime?.turnId, original.runtime.turnId);
      assert.equal(canonical.runtime?.turnId, original.runtime.turnId, "steering belongs to the original task turn");
    }
    await agent.close();
    const resumedConfig = configSchema.parse({ ...config, chat: { ...config.chat, defaultToolSelection: "auto" } });
    agent = new AgentSession({
      workspaceRoot, config: resumedConfig, model, toolRegistry: registry,
      recorder: new SessionRecorder(workspaceRoot), permissionManager: new PermissionManager(resumedConfig.permission)
    });
    await agent.initialize();
    await agent.resume(sessionId);
    phase = "resumed";
    let resumed;
    for await (const event of agent.continueInterruptedTurn({ emotionAnalysis: false, maxSteps: 3 })) {
      if (event.type === "done") resumed = event.outcome;
    }
    assert.equal(resumed?.status, "completed", resumed?.error);
    assert.equal(resumedSteps, 1, "recovery proceeds from saved facts without replaying old discovery or completed tools");
  } finally {
    releaseRequest();
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await testSelectionRecovery("none");
await testSelectionRecovery("manual");
await testSelectionRecovery("discovered");
await testSelectionRecovery("none", true);
await testSelectionRecovery("manual", true);
await testSelectionRecovery("discovered", true);
console.log("tool selection recovery tests passed");

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
