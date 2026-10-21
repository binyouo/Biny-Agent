import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { UserInputRequests } from "../src/runtime/userInput.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { createAskUserQuestionTool } from "../src/tools/askUserQuestion.js";
import { createToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-control-discovery-"));
const config = configSchema.parse({ ...defaultConfig,
  agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" },
  permission: { ...defaultConfig.permission, mode: "full-access" },
  checkpoints: { ...defaultConfig.checkpoints, enabled: false },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, enabled: false } }
});
try {
  await ensureAgentDirs(root);
  await writeFile(path.join(root, "evidence.txt"), "a needle\n");
  for (const selection of ["auto", ["Read"], "none", []] as const) {
    const disabled = selection === "none" || Array.isArray(selection) && selection.length === 0;
    const registry = createToolRegistry({ workspaceRoot: root, ignore: config.workspace.ignore });
    const requests = new UserInputRequests();
    registry.registerBuiltinTool(createAskUserQuestionTool(requests));
    const recorder = new SessionRecorder(root);
    let step = 0;
    const model: AgentModel = testModel({ provider: "fixture", modelId: "control-discovery", supportsTools: true,
      async stream(context) {
        assert.ok(!context.tools.some((tool) => tool.name === "ToolSearch"));
        const current = step++;
        if (disabled) assert.deepEqual(context.tools, []);
        else if (current === 0) {
          assert.deepEqual(context.tools.map((tool) => tool.name).sort(), ["Read", "run_script"]);
          assert.doesNotMatch(context.tools.find((tool) => tool.name === "run_script")!.promptSnippet ?? "", /Grep:|AskUserQuestion:/u);
          return (async function* (): AsyncGenerator<ModelStreamEvent> {
            yield { type: "tool-call", id: "discover", name: "run_script", arguments: { description: "Exercise script tool flow", code: selection === "auto"
              ? "const hits=await searchTools('Grep AskUserQuestion'); const page=await tools.Grep({query:'needle'}); return {hits, paths:page.matches.map(row=>row.path)};"
              : "return await searchTools('Grep AskUserQuestion');" } };
            yield { type: "finish", reason: "tool-calls" };
          })();
        } else {
          assert.equal(context.tools.some((tool) => tool.name === "AskUserQuestion"), selection === "auto");
          assert.ok(!context.tools.some((tool) => tool.name === "Grep"), "script-callable built-ins need no ordinary schema activation");
        }
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: "Discovery inspected." };
          yield { type: "finish", reason: "stop" };
        })();
      }
    });
    const agent = new AgentSession({ workspaceRoot: root, config, recorder, model, toolRegistry: registry,
      permissionManager: new PermissionManager(config.permission), selectCapabilities: async () => ({ tools: ["Read"], skills: [] }) });
    try {
      await agent.initialize();
      const outcome = await agent.runTask("Inspect discoverable controls", { emotionAnalysis: false,
        capabilitySelection: { tools: typeof selection === "string" ? selection : [...selection], skills: "none" } });
      assert.equal(outcome.status, "completed", outcome.error);
      await recorder.flush();
      const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const result = events.find((event) => event.type === "tool_result" && event.toolCallId === "discover")?.result;
      if (selection === "auto") {
        assert.deepEqual(result.value.paths, ["evidence.txt"]);
        assert.equal(result.value.hits.find((hit: { name: string }) => hit.name === "AskUserQuestion").invocation, "direct");
        assert.equal(result.value.hits.find((hit: { name: string }) => hit.name === "Grep").invocation, undefined);
        assert.ok(events.some((event) => event.type === "tool_call" && event.tool === "ToolSearch" && event.auditOnly));
      } else if (!disabled) {
        assert.equal(result.ok, false);
        assert.match(result.error, /No tool model configured/u);
      }
      assert.deepEqual(requests.list(), [], "metadata discovery must not ask a question");
    } finally { await agent.close(); }
  }

  const resumeRegistry = createToolRegistry({ workspaceRoot: root, ignore: [] });
  resumeRegistry.registerBuiltinTool(createAskUserQuestionTool(new UserInputRequests()));
  let resumedSteps = 0;
  const resumeModel: AgentModel = testModel({ provider: "fixture", modelId: "control-resume", supportsTools: true,
    async stream(context) {
      assert.ok(!context.tools.some((tool) => tool.name === "ToolSearch"));
      const first = resumedSteps++ === 0;
      if (!first) assert.ok(context.tools.some((tool) => tool.name === "AskUserQuestion"), "completed script discovery restores the ordinary control schema");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (first) {
          yield { type: "tool-call", id: "resume-control-search", name: "run_script", arguments: { description: "Exercise script tool flow", code: "return await searchTools('AskUserQuestion');" } };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: "Discovery restored." };
          yield { type: "finish", reason: "stop" };
        }
      })();
    }
  });
  const createResumeAgent = () => new AgentSession({ workspaceRoot: root, config, model: resumeModel, toolRegistry: resumeRegistry,
    recorder: new SessionRecorder(root), permissionManager: new PermissionManager(config.permission),
    selectCapabilities: async () => ({ tools: ["Read"], skills: [] }) });
  let resumeAgent = createResumeAgent();
  try {
    await resumeAgent.initialize();
    const sessionId = resumeAgent.getInfo().sessionId;
    const paused = await resumeAgent.runTask("Find the requirement control", { emotionAnalysis: false, maxSteps: 1 });
    assert.equal(paused.status, "incomplete");
    assert.equal(paused.resumable, true);
    await resumeAgent.close();
    resumeAgent = createResumeAgent();
    await resumeAgent.initialize();
    await resumeAgent.resume(sessionId);
    let resumedOutcome;
    for await (const event of resumeAgent.continueInterruptedTurn({ emotionAnalysis: false, maxSteps: 3 })) {
      if (event.type === "done") resumedOutcome = event.outcome;
    }
    assert.equal(resumedOutcome?.status, "completed", resumedOutcome?.error);
    assert.equal(resumedSteps, 2, "resume must not replay completed discovery");
  } finally { await resumeAgent.close(); }

  const requests = new UserInputRequests();
  const registry = createToolRegistry({ workspaceRoot: root, ignore: [] });
  registry.registerBuiltinTool(createAskUserQuestionTool(requests));
  const recorder = new SessionRecorder(root);
  try {
    let unrelatedDiscovery = 0;
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
      prepareToolDiscovery: async () => { unrelatedDiscovery++; return { pending: ["unrelated-server"], timedOut: true }; } },
      new PermissionManager(config.permission), () => undefined, undefined, new Set(["Read"]));
    const result = await coordinator.createCodeModeTool().execute("illegal-control", { description: "illegal-control",
      code: "await searchTools('AskUserQuestion'); return await tools.AskUserQuestion({questions:[{id:'q',question:'Must stay outside the VM'}]});"
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.details), /not available in this cell/u);
    assert.deepEqual(requests.list(), []);
    assert.equal(unrelatedDiscovery, 0, "a known local control query cannot wait for unrelated MCP connections");
    assert.ok(coordinator.createAgentTools().some((tool) => tool.name === "AskUserQuestion"));
  } finally { await recorder.close(); }
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Code Mode discovery preserves control invocation and manual selection boundaries");
