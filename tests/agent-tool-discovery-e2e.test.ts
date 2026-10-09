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

// query 改写不能绕过发现预算；现有逐参数预算无法识别同一能力的反复发现。
async function testDiscoveryWithoutProgress(scenario: {
  actions: Array<"search" | "inspect" | "interrupt" | "other" | "script" | "script-loop" | "parallel" | "empty" | "invalid">;
  requests: number;
  searches: number;
  stopped: boolean;
}): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-discovery-no-progress-"));
  await ensureAgentDirs(workspaceRoot);
  const registry = new ToolRegistry();
  registry.registerBuiltinTool({
    name: "inspect_records", description: "Read records", risk: "read",
    parameters: { type: "object", properties: {} }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "inspect_records", execute: async () => ({ records: [1] }) })
  });
  registry.registerMcpTool({
    name: "other_records", description: "Read other records", risk: "read", exposure: "deferred",
    parameters: { type: "object", properties: {} }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "other_records", execute: async () => ({ records: [2] }) })
  });
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries(), () => [{
    failureDomain: "empty-fixture", model: { provider: "test", modelId: "empty-fixture", stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: scenario.actions.includes("invalid") ? '{}' : '{"tools":[]}' };
      yield { type: "finish", reason: "stop" };
    })() }
  }]));
  let requests = 0;
  const model: AgentModel = { provider: "test", modelId: "repeated-discovery", supportsTools: true,
    async stream() {
      requests += 1;
      const action = scenario.actions[requests - 1];
      if (action === "interrupt") throw new Error("synthetic provider interruption");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (action) {
          if (action === "inspect") {
            yield { type: "tool-call", id: `inspect-${requests}`, name: "inspect_records", arguments: {} };
          } else if (action === "script" || action === "script-loop") {
            yield { type: "tool-call", id: `exec-${requests}`, name: "exec", arguments: {
              code: action === "script-loop" ? 'for (let i = 0; i < 8; i++) await searchTools("other_records alternative " + i);' : `return await searchTools("other_records alternative ${requests}");`
            } };
          } else {
            for (let index = 0; index < (action === "parallel" ? 3 : 1); index++) {
              yield { type: "tool-call", id: `search-${requests}-${index}`, name: "ToolSearch", arguments: {
                query: `${action === "empty" || action === "invalid" ? "missing capability" : action === "other" ? "other_records" : "inspect_records"} alternative ${requests} ${index}`
              } };
            }
          }
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: "No execution progress." };
          yield { type: "finish", reason: "stop" };
        }
      })();
    }
  };
  const config = configSchema.parse({ ...defaultConfig,
    agent: { ...defaultConfig.agent, toolExecutionMode: scenario.actions.some((action) => action.startsWith("script")) ? "code_mode" : "direct", maxRepeatedActions: 2 },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(workspaceRoot);
  const agent = new AgentSession({ workspaceRoot, config, recorder, model, toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission),
    selectCapabilities: async () => ({ tools: ["ToolSearch"], skills: "none" }) });
  try {
    await agent.initialize();
    const options = { emotionAnalysis: false, capabilitySelection: { tools: "auto" as const, skills: "none" as const },
      confirmPermission: async () => ({ approved: true as const, scope: "once" as const }) };
    let outcome = await agent.runTask("Read the records", options);
    if (scenario.actions.includes("interrupt")) {
      assert.equal(outcome.stopReason, "provider_error");
      for await (const event of agent.continueInterruptedTurn(options)) if (event.type === "done") outcome = event.outcome;
    }
    assert.equal(outcome.status, scenario.stopped ? "incomplete" : "completed", JSON.stringify(scenario));
    assert.equal(requests, scenario.requests, JSON.stringify(scenario));
    if (scenario.stopped) {
      assert.equal(outcome.stopReason, "repeated_action_limit");
      assert.match(outcome.error ?? "", /discovery.*progress/iu);
    }
    const replay = await replaySession(recorder.filePath);
    assert.equal(replay.events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch").length, scenario.searches);
    if (scenario.stopped) assert.ok(replay.events.some((event) => event.type === "turn_status" && event.status === "incomplete"));
  } finally {
    await agent.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await testDiscoveryWithoutProgress({ actions: ["search", "search", "search", "search"], requests: 3, searches: 3, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["search", "search", "inspect", "search"], requests: 5, searches: 3, stopped: false });
await testDiscoveryWithoutProgress({ actions: ["search", "inspect", "search", "inspect", "search"], requests: 5, searches: 3, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["search", "search", "interrupt", "search"], requests: 4, searches: 3, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["search", "search", "other", "search"], requests: 5, searches: 4, stopped: false });
await testDiscoveryWithoutProgress({ actions: ["parallel"], requests: 1, searches: 3, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["empty", "empty"], requests: 2, searches: 2, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["invalid", "invalid"], requests: 2, searches: 2, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["script", "script", "script", "script"], requests: 3, searches: 3, stopped: true });
await testDiscoveryWithoutProgress({ actions: ["script-loop"], requests: 1, searches: 4, stopped: true });
await testDiscoveryFailure(true);
await testDiscoveryFailure(false);
console.log("agent tool discovery e2e tests passed");
