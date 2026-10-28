import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { createWidgetReadmeTool, createWidgetRendererTool } from "../src/tools/widget.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";

for (const scenario of [
  { mode: "direct", manual: false, exposure: "direct" },
  { mode: "direct", manual: true, exposure: "direct" },
  { mode: "direct", manual: false, exposure: "hidden" },
  { mode: "direct", manual: false, exposure: "codemode" },
  { mode: "code_mode", manual: false, exposure: "direct" }
] as const) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-companions-"));
  await ensureAgentDirs(root);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createWidgetRendererTool());
  registry.registerBuiltinTool({ ...createWidgetReadmeTool(), exposure: scenario.exposure });
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
  const recorder = new SessionRecorder(root);
  const hasCompanion = !scenario.manual && scenario.exposure === "direct";
  let requests = 0;
  const model = testModel({ provider: "test", modelId: "tool-companions", supportsTools: true,
    async stream(context) {
      requests += 1;
      assert.ok(requests <= 5);
      const names = context.tools.map((tool) => tool.name);
      if (requests === 1) {
        assert.equal(names.includes("WidgetRenderer"), false);
        assert.equal(names.includes("WidgetReadme"), false);
      } else {
        assert.ok(names.includes("WidgetRenderer"));
        assert.equal(names.includes("WidgetReadme"), hasCompanion, JSON.stringify(scenario));
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (requests === 1) {
          yield scenario.mode === "direct"
            ? { type: "tool-call", id: "discover-widget", name: "ToolSearch", arguments: { query: "WidgetRenderer" } }
            : { type: "tool-call", id: "discover-widget", name: "run_script", arguments: {
              description: "Discover the widget renderer", code: 'return await searchTools("WidgetRenderer");'
            } };
          yield { type: "finish", reason: "tool-calls" };
        } else if (requests === 2 && hasCompanion) {
          yield { type: "tool-call", id: "read-widget-guide", name: "WidgetReadme", arguments: {} };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: "Ready." };
          yield { type: "finish", reason: "stop" };
        }
      })();
    }
  });
  const config = configSchema.parse({ ...defaultConfig,
    agent: { ...defaultConfig.agent, toolExecutionMode: scenario.mode },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, model, toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    selectCapabilities: async () => ({ tools: scenario.mode === "direct" ? ["ToolSearch"] : [], skills: "none" })
  });
  try {
    await agent.initialize();
    const options = { emotionAnalysis: false,
      capabilitySelection: { tools: scenario.manual ? ["ToolSearch"] : "auto" as const, skills: "none" as const },
      abortSignal: AbortSignal.timeout(20_000)
    };
    const outcome = await agent.runTask("Prepare an interactive explanation", options);
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const events = await readSessionEvents(recorder.filePath);
    const guide = events.find((event) => event.type === "tool_result" && event.tool === "WidgetReadme");
    assert.equal(!!guide, hasCompanion);
    if (guide?.type === "tool_result") assert.ok((guide.result as { guide: string }).guide.length > 100);
    if (!scenario.manual && scenario.mode === "direct") {
      const continued = await agent.runTask("Continue the explanation", options);
      assert.equal(continued.status, "completed", JSON.stringify(continued));
      assert.equal((await readSessionEvents(recorder.filePath)).filter((event) => event.type === "tool_call" && event.tool === (scenario.mode === "direct" ? "ToolSearch" : "run_script")).length, 1);
    }
  } finally {
    await agent.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
}
console.log("tool companion discovery e2e tests passed");
