import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";

async function testDiscoveryFailure(permanent: boolean): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-discovery-failure-"));
  await ensureAgentDirs(workspaceRoot);
  const registry = new ToolRegistry();
  let executions = 0;
  registry.registerBuiltinTool({
    name: "InspectScreen",
    description: "Inspect the current display",
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    resolveExecution: () => ({
      approvalRule: "InspectScreen",
      execute: async () => { executions += 1; return { inspected: true }; }
    })
  });
  let repaired = false;
  let searches = 0;
  const auxiliary: AgentModel = {
    provider: "test", modelId: "discovery", supportsTools: false,
    async stream() {
      searches += 1;
      if (!repaired) throw new Error(permanent ? "Insufficient Balance" : "temporary network failure");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify({ tools: ["InspectScreen"] }) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries(), () => [{ model: auxiliary, failureDomain: "test-discovery" }]));
  let requests = 0;
  const model: AgentModel = {
    provider: "test", modelId: "discovery-main", supportsTools: true,
    async stream(context) {
      requests += 1;
      assert.ok(requests <= 4, "discovery must not create an unbounded continuation loop");
      const discovered = context.tools.some((tool) => tool.name === "InspectScreen");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (requests === 1 || repaired && !discovered) {
          yield { type: "tool-call", id: `search-${requests}`, name: "ToolSearch", arguments: { query: "inspect the current display" } };
          yield { type: "finish", reason: "tool-calls" };
        } else if (repaired && executions === 0) {
          assert.ok(discovered, "successful discovery must disclose the registered tool");
          yield { type: "tool-call", id: "inspect", name: "InspectScreen", arguments: {} };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: repaired ? "Display inspected." : "Discovery temporarily unavailable." };
          yield { type: "finish", reason: "stop" };
        }
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    crystal: { ...defaultConfig.crystal, passiveEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({ workspaceRoot, config, model, toolRegistry: registry, permissionManager: new PermissionManager(config.permission), recorder });
  const runOptions = {
    capabilitySelection: { tools: ["ToolSearch"], skills: "none" as const },
    confirmPermission: async () => ({ approved: true as const, scope: "once" as const })
  };
  try {
    await agent.initialize();
    const outcome = await agent.runTask("Discover an optional display capability", runOptions);
    assert.equal(outcome.status, permanent ? "blocked" : "completed");
    assert.equal(requests, permanent ? 1 : 2, "permanent discovery failures must stop before another model request");
    assert.equal(executions, 0, "failed discovery must not execute optional tools");
    assert.ok(searches > 0);
    await recorder.flush();
    const replay = await replaySession(recorder.filePath);
    const result = replay.events.find((event) => event.type === "tool_result" && event.tool === "ToolSearch");
    assert.ok(result, "failed discovery must retain the stable tool_result fact");
    assert.match(JSON.stringify(result), /tool_search_request_failed/u);
    if (permanent) {
      assert.equal(outcome.stopReason, "blocked");
      assert.equal(outcome.blockedReason, "external_service_failure");
      assert.equal(outcome.resumable, true);
      assert.match(outcome.requiredAction ?? "", /工具发现|模型/u);
      const stored = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
      assert.ok(stored.some((event) => event.type === "turn_status" && event.status === "blocked"));
      repaired = true;
      let resumed;
      for await (const event of agent.continueInterruptedTurn(runOptions)) {
        if (event.type === "done") resumed = event.outcome;
      }
      assert.equal(resumed?.status, "completed", JSON.stringify(resumed));
      assert.equal(executions, 1, "explicit continuation must not replay completed side effects");
      assert.equal(requests, 4);
    }
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await testDiscoveryFailure(true);
await testDiscoveryFailure(false);
console.log("agent tool discovery failure e2e tests passed");
