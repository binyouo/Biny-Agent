/** 注册目录、模型声明与脚本调用采用独立的暴露策略；暴露本身不授予执行权限。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import type { Tool } from "../src/tools/types.js";

const modes = ["direct", "model-only", "codemode", "deferred", "hidden"] as const;

function tool(name: string, mode?: typeof modes[number]): Tool {
  return {
    name,
    description: `Read ${name}.`,
    parameters: { type: "object" as const, properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "read" as const,
    exposure: mode,
    resolveExecution: () => ({ approvalRule: name, async execute() { return { ok: true }; } })
  };
}

// Given a registered hidden tool, it remains host-visible without becoming a model declaration.
const registry = new ToolRegistry();
registry.register(tool("ordinary"));
registry.register(tool("host_secret", "hidden"));
assert.deepEqual(registry.list().map((entry) => entry.name), ["ordinary", "host_secret"]);
assert.deepEqual(registry.listDefinitions().map((entry) => entry.name), ["ordinary"]);
assert.deepEqual(registry.listCatalogDefinitions().map((entry) => [entry.name, entry.exposure]), [
  ["ordinary", "direct"], ["host_secret", "hidden"]
]);

const { getToolExposure, isToolModelVisible, isToolScriptCallable } = await import("../src/tools/exposure.js");
assert.equal(getToolExposure(tool("ordinary")), "direct");
assert.equal(isToolModelVisible(tool("ordinary")), true);
assert.equal(isToolScriptCallable(tool("ordinary"), false), false);
assert.equal(isToolScriptCallable(tool("ordinary"), true), true);

for (const mode of modes) {
  const entry = tool(mode, mode);
  assert.equal(getToolExposure(entry), mode);
  assert.equal(isToolModelVisible(entry), mode !== "hidden" && mode !== "codemode", `${mode} model eligibility`);
  assert.equal(isToolScriptCallable(entry, false), mode === "codemode" || mode === "deferred", `${mode} unselected script eligibility`);
  assert.equal(isToolScriptCallable(entry, true), mode === "direct" || mode === "codemode" || mode === "deferred", `${mode} selected script eligibility`);
}

// External source and a self-declared read risk never override model-only or hidden exposure.
for (const mode of ["model-only", "hidden"] as const) {
  const entry = { ...tool("remote_read", mode), source: "mcp" as const, capability: "remote" };
  assert.equal(isToolScriptCallable(entry, true), false);
}

const catalogRegistry = new ToolRegistry();
const remote = {
  ...tool("remote_records", "deferred"),
  outputSchema: { type: "object" as const, properties: { count: { type: "integer" as const } }, required: ["count"] },
  namespace: { name: "project-data", description: "Project records", instructions: "Use stable IDs." }
};
catalogRegistry.registerMcpTool(remote);
catalogRegistry.register(tool("default_records"));
assert.deepEqual(catalogRegistry.listCatalogDefinitions(), [
  {
    name: "remote_records", description: remote.description, parameters: remote.parameters,
    outputSchema: remote.outputSchema,
    source: "mcp", risk: "read", exposure: "deferred", namespace: remote.namespace
  },
  {
    name: "default_records", description: "Read default_records.", parameters: remote.parameters,
    outputSchema: undefined,
    source: "builtin", risk: "read", exposure: "direct", namespace: undefined
  }
]);
assert.deepEqual(catalogRegistry.listDefinitions(), [
  { name: "remote_records", description: remote.description, parameters: remote.parameters },
  { name: "default_records", description: "Read default_records.", parameters: remote.parameters }
]);

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-exposure-admission-"));
await ensureAgentDirs(workspaceRoot);
const config = structuredClone(defaultConfig);
config.permission.mode = "full-access";
try {
  for (const mode of modes) {
    let calls = 0;
    const entry = tool(`fixture_${mode}`, mode);
    entry.resolveExecution = () => ({
      approvalRule: entry.name,
      accesses: ToolAccesses.none(),
      async execute() { calls++; return { ok: true }; }
    });
    const executionRegistry = new ToolRegistry();
    executionRegistry.registerBuiltinTool(entry);
    const recorder = new SessionRecorder(workspaceRoot, mode);
    const coordinator = new ToolExecutionCoordinator(
      { workspaceRoot, config, recorder, toolRegistry: executionRegistry },
      new PermissionManager(config.permission), () => undefined
    );
    try {
      const eligible = mode !== "hidden" && mode !== "codemode";
      assert.deepEqual(coordinator.createAgentTools().map((definition) => definition.name), eligible ? [entry.name] : []);
      await coordinator.handleInvalidToolCall(entry.name, `raw_${mode}`, {});
      assert.equal(calls, eligible ? 1 : 0, `${mode} must retain model exposure at the raw invocation boundary`);
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      assert.ok(events.some((event) => event.type === "tool_call" && event.toolCallId === `raw_${mode}`));
      assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === `raw_${mode}` && event.executionStatus === (eligible ? "succeeded" : "failed")));
      if (!eligible) assert.ok(!events.some((event) => event.type === "tool_execution" && event.state === "admitted"));
    } finally {
      await coordinator.waitForIdle();
      await recorder.close();
    }
  }

  let remoteCalls = 0;
  const envelopeRegistry = new ToolRegistry();
  envelopeRegistry.registerMcpTool({
    ...tool("remote_error", "deferred"),
    resolveExecution: () => ({
      approvalRule: "remote_error", accesses: ToolAccesses.none(),
      async execute(context) {
        assert.equal(context.mcpResultMode, "envelope");
        remoteCalls++;
        return { isError: true, content: [{ type: "text", text: "External lookup failed" }], structuredContent: { message: "No records available" } };
      }
    })
  });
  const envelopeRecorder = new SessionRecorder(workspaceRoot, "mcp-envelope-error");
  const envelopeCoordinator = new ToolExecutionCoordinator(
    { workspaceRoot, config, recorder: envelopeRecorder, toolRegistry: envelopeRegistry },
    new PermissionManager(config.permission), () => undefined
  );
  try {
    const result = await envelopeCoordinator.createCodeModeTool().execute("error-cell", {
      code: "try { await tools.remote_error({}); } catch {} return await tools.remote_error({});"
    });
    assert.equal(remoteCalls, 1, "a remote protocol error must block the second child even when caught by the script");
    assert.equal(result.isError, true);
    await envelopeRecorder.flush();
    const events = await readSessionEvents(envelopeRecorder.filePath);
    const child = events.find((event) => event.type === "tool_result" && event.toolCallId === "error-cell:nested:1");
    assert.ok(child && child.type === "tool_result");
    assert.equal(child.executionStatus, "failed");
    assert.equal(child.auditOnly, true);
    assert.deepEqual((child.result as { content?: unknown }).content, [{ type: "text", text: "External lookup failed" }]);
    assert.deepEqual((child.result as { structuredContent?: unknown }).structuredContent, { message: "No records available" });
    assert.ok(!events.some((event) => event.type === "tool_call" && event.toolCallId === "error-cell:nested:2"));
    const replay = replaySessionEvents(events, { sessionId: "mcp-envelope-error" });
    assert.ok(!replay.messages.some((message) => message.role === "toolResult" && message.toolCallId === "error-cell:nested:1"));
  } finally {
    await envelopeCoordinator.waitForIdle();
    await envelopeRecorder.close();
  }

  const changingRegistry = new ToolRegistry();
  const remoteName = "mcp_records_read";
  let markSearchStarted!: () => void;
  const searchStarted = new Promise<void>((resolve) => { markSearchStarted = resolve; });
  let releaseSearch!: () => void;
  const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
  const versionOne: Tool = {
    ...tool(remoteName, "deferred"), description: "Read legacy records, version one",
    namespace: { name: "records" },
    parameters: { type: "object", properties: { legacy: { type: "string" } }, required: ["legacy"] },
    schema: z.object({ legacy: z.string() })
  };
  const versionTwo: Tool = {
    ...versionOne, description: "Read current records, version two",
    parameters: { type: "object", properties: { current: { type: "string" } }, required: ["current"] },
    schema: z.object({ current: z.string() }),
    resolveExecution: () => ({
      approvalRule: remoteName, accesses: ToolAccesses.none(),
      async execute() { releaseSearch(); return { version: 2 }; }
    })
  };
  changingRegistry.registerMcpTool(versionOne);
  const semanticModel: AgentModel = {
    provider: "fixture", modelId: "changing-tool-catalog",
    async stream(context) {
      assert.ok(context.systemPrompt?.includes(versionOne.description), "semantic selection starts from the original catalog");
      markSearchStarted();
      await searchGate;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify({ tools: [remoteName] }) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  changingRegistry.registerBuiltinTool(createToolSearchTool(() => changingRegistry.listEntries(), () => [
    { model: semanticModel, failureDomain: "changing-catalog" }
  ]));
  const changingRecorder = new SessionRecorder(workspaceRoot, "changing-catalog");
  const changingCoordinator = new ToolExecutionCoordinator(
    {
      workspaceRoot, config, recorder: changingRecorder, toolRegistry: changingRegistry,
      async prepareToolDiscovery(query) {
        if (query === remoteName) {
          await searchStarted;
          changingRegistry.unregister(remoteName);
          changingRegistry.registerMcpTool(versionTwo);
        }
        return { pending: [], timedOut: false };
      }
    },
    new PermissionManager(config.permission), () => undefined
  );
  try {
    const result = await changingCoordinator.createCodeModeTool().execute("changing-cell", {
      code: `const [matches, current] = await Promise.all([
searchTools('查询项目记录'),
(async () => { const definition = await describeTool('${remoteName}'); await tools.${remoteName}({current:'live'}); return definition; })()
]); return {matches, current};`
    }, AbortSignal.timeout(5_000));
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const value = (result.details as { value: { matches: { name: string; description: string }[]; current: { description: string; parameters: unknown } } }).value;
    assert.equal(value.current.description, versionTwo.description);
    assert.deepEqual(value.current.parameters, versionTwo.parameters);
    assert.deepEqual(value.matches.filter((entry) => entry.name !== remoteName || entry.description !== versionTwo.description), [], "a concurrent refresh must revoke version-one search wrappers instead of admitting them by the reused name");
  } finally {
    releaseSearch();
    await changingCoordinator.waitForIdle();
    await changingRecorder.close();
  }
} finally { await rm(workspaceRoot, { recursive: true, force: true }); }

console.log("tool exposure tests passed");
