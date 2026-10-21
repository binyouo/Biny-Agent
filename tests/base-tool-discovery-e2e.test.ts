import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
/** 精简常驻定义后，真实 Session 仍能无辅助模型地发现工具、搜索文件、管理进程。 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { UserInputRequests } from "../src/runtime/userInput.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createAskUserQuestionTool } from "../src/tools/askUserQuestion.js";
import { createToolRegistry } from "../src/tools/registry.js";

for (const withPreselection of [true, false]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-base-tools-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const processes = new ManagedProcessService({ workspaceRoot: root });
  const registry = createToolRegistry({ workspaceRoot: root, ignore: [] }, undefined, processes);
  registry.registerBuiltinTool(createAskUserQuestionTool(new UserInputRequests()));
  // 直接嵌入 AgentSession 且缺少选择器时也必须走大目录的保守回退。
  for (let index = 0; index < 45; index++) registry.registerBuiltinTool({ ...registry.get("Read"), name: `optional_read_${index}` });
  const core = ["Read", "Write", "Edit", "Bash", "ToolSearch"];
  const helpers = ["Glob", "Grep", "ProcessStatus", "KillShell", "AskUserQuestion"];
  let step = 0;
  let processId: string | undefined;
  const resultFor = async (tool: string) => {
    const event = (await readSessionEvents(recorder.filePath)).find((event) => event.type === "tool_result" && event.tool === tool);
    assert.ok(event?.type === "tool_result", `persisted ${tool} result`);
    return event.result;
  };
  const model: AgentModel = testModel({ provider: "test", modelId: "minimal-tool-flow", supportsTools: true,
    async stream(context) {
      const visible = context.tools.map((tool) => tool.name);
      let call: { name: string; arguments: Record<string, unknown> } | undefined;
      switch (step++) {
        case 0:
          assert.deepEqual(new Set(visible), new Set(core), `minimal first request (preselection=${withPreselection})`);
          call = { name: "Bash", arguments: { command: `'${process.execPath.replaceAll("'", "'\\''")}' background.cjs`, background: true,
            readiness: { type: "log", pattern: "READY", timeoutMs: 5_000 } } };
          break;
        case 1: {
          const result = await resultFor("Bash") as { process: { processId: string; state: string } };
          assert.ok(result.process, `background Bash must start: ${JSON.stringify(result)}`);
          assert.equal(result.process.state, "running");
          processId = result.process.processId;
          assert.ok(!visible.includes("KillShell"), "starting a process does not eagerly expose unrelated helper schemas");
          call = { name: "ToolSearch", arguments: { query: helpers.join(" "), maxResults: helpers.length } };
          break;
        }
        case 2:
          for (const name of helpers) assert.ok(visible.includes(name), `exact discovery activates ${name} without an auxiliary model`);
          call = { name: "ProcessStatus", arguments: { processId } };
          break;
        case 3:
          assert.match(JSON.stringify(await resultFor("ProcessStatus")), /READY/u);
          call = { name: "KillShell", arguments: { processId } };
          break;
        case 4:
          assert.equal((await processes.status(processId!)).state, "stopped");
          call = { name: "Glob", arguments: { pattern: "*.txt" } };
          break;
        case 5:
          assert.deepEqual((await resultFor("Glob") as { files: string[] }).files, ["note.txt"]);
          call = { name: "Grep", arguments: { query: "fixture-note", glob: "*.txt" } };
          break;
        case 6:
          assert.match(JSON.stringify(await resultFor("Grep")), /fixture-note/u);
          break;
        default: assert.fail("unexpected model continuation");
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (call) {
          yield { type: "tool-call", id: `step-${step}`, ...call };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: "Done." };
          yield { type: "finish", reason: "stop" };
        }
      })();
    }
  });
  const config = configSchema.parse({ ...defaultConfig,
    agent: { ...defaultConfig.agent, toolExecutionMode: "direct" },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false, denyPaths: [] },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, model, toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    selectCapabilities: withPreselection ? (input) => preselectCapabilities({ ...input, tools: registry.list(), skills: [] }) : undefined
  });
  try {
    await writeFile(path.join(root, "background.cjs"), "console.log('READY'); setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));\n");
    await writeFile(path.join(root, "note.txt"), "fixture-note\n");
    await agent.initialize();
    // 真实子进程需要调度及日志就绪，使用 readiness 和整个回合的硬截止时间。
    const outcome = await agent.runTask("Inspect the workspace and manage a temporary service", {
      emotionAnalysis: false, capabilitySelection: { tools: "auto", skills: "none" }, abortSignal: AbortSignal.timeout(20_000)
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(step, 7);
    const events = await readSessionEvents(recorder.filePath);
    assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => event.tool),
      ["Bash", "ToolSearch", "ProcessStatus", "KillShell", "Glob", "Grep"]);
    assert.equal(events.filter((event) => event.type === "tool_result").length, 6);
  } finally {
    await agent.close();
    await processes.close();
    await rm(root, { recursive: true, force: true });
  }
}
console.log("base tool discovery e2e tests passed");
