import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession, type AgentRunOptions, type AgentSessionOptions } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import type { Tool, ToolExposure } from "../src/tools/types.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-exposure-"));
await ensureAgentDirs(workspaceRoot);
await writeFile(path.join(workspaceRoot, "hello.txt"), "hello reports\n");
const config = configSchema.parse({
  ...defaultConfig,
  agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" },
  permission: { ...defaultConfig.permission, mode: "full-access" },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
});
const reportName = "mcp__reports__list";
const privateNames = ["mcp__reports__hidden", "mcp__reports__model_only"];
const schemaMarker = "project-key-schema-marker";
let reports = 0;
let privateCalls = 0;
let failedCalls = 0;
let semanticQueries = 0;
const envelope = {
  content: [
    { type: "text", text: "Two reports" },
    { type: "resource_link", uri: "report://demo", name: "demo", mimeType: "application/json" }
  ],
  structuredContent: { reports: [{ comments: 4 }, { comments: 12 }] },
  isError: false
};

function reportTool(name = reportName, exposure: ToolExposure = "deferred"): Tool {
  return {
    name, description: "Read issue reports", risk: "read", exposure,
    namespace: { name: "reports", description: "Issue reporting", instructions: "Reports require a project key." },
    parameters: { type: "object", properties: { project: { type: "string", description: schemaMarker } }, required: ["project"], additionalProperties: false },
    schema: z.object({ project: z.string() }),
    resolveExecution: () => ({
      approvalRule: name, accesses: ToolAccesses.none(),
      async execute(context) {
        if (name !== reportName) { privateCalls++; return "private"; }
        reports++;
        return context.mcpResultMode === "envelope" ? envelope : envelope.structuredContent;
      }
    })
  };
}

function registryWithTools(includeReports = true): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createReadFileTool({ workspaceRoot, ignore: [] }));
  registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot, ignore: [] }));
  if (includeReports) registry.registerMcpTool(reportTool());
  registry.registerMcpTool(reportTool(privateNames[0], "hidden"));
  registry.registerMcpTool(reportTool(privateNames[1], "model-only"));
  const auxiliary: AgentModel = {
    provider: "fixture", modelId: "report-discovery", supportsTools: false,
    async stream(context) {
      semanticQueries++;
      assert.doesNotMatch(context.systemPrompt ?? "", /mcp__reports__hidden/u);
      assert.match(JSON.stringify(context.messages), /查询项目报告/u);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify({ tools: [reportName] }) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries(), () => [{ model: auxiliary, failureDomain: "fixture-reports" }]));
  return registry;
}

type Step = (context: ModelStreamContext) => ModelStreamEvent[];
const call = (id: string, name: string, args: Record<string, unknown>): ModelStreamEvent[] => [
  { type: "tool-call", id, name, arguments: args }, { type: "finish", reason: "tool-calls" }
];
const finish = (): ModelStreamEvent[] => [{ type: "text-delta", text: "Complete." }, { type: "finish", reason: "stop" }];
const eventsFor = (events: SessionEvent[], toolCallId: string) => events.filter((event) => ("toolCallId" in event) && event.toolCallId === toolCallId);
function resultFor(events: SessionEvent[], toolCallId: string): unknown {
  const event = events.find((entry) => entry.type === "tool_result" && entry.toolCallId === toolCallId);
  assert.ok(event && event.type === "tool_result", `Missing result for ${toolCallId}`);
  return event.result;
}

async function runFixture(
  name: string, registry: ToolRegistry, steps: Step[],
  options: { run?: AgentRunOptions; prepareToolDiscovery?: AgentSessionOptions["prepareToolDiscovery"]; permissionMode?: "full-access" | "read-only"; automatic?: boolean; executionMode?: "direct" | "code_mode" } = {}
): Promise<SessionEvent[]> {
  const fixtureConfig = configSchema.parse({ ...config,
    agent: { ...config.agent, toolExecutionMode: options.executionMode ?? "code_mode" },
    permission: { ...config.permission, mode: options.permissionMode ?? "full-access" }
  });
  let step = 0;
  const model: AgentModel = {
    provider: "fixture", modelId: name, supportsTools: true,
    async stream(context) {
      const next = steps[step++];
      assert.ok(next, `${name} exceeded its scripted model steps`);
      return (async function* () { yield* next(context); })();
    }
  };
  const recorder = new SessionRecorder(workspaceRoot, name);
  const agent = new AgentSession({
    workspaceRoot, config: fixtureConfig, model, toolRegistry: registry, recorder,
    permissionManager: new PermissionManager(fixtureConfig.permission),
    prepareToolDiscovery: options.prepareToolDiscovery,
    selectCapabilities: options.automatic === false ? undefined : async () => ({ tools: ["Read", "Write", "ToolSearch"], skills: [] })
  });
  try {
    await agent.initialize();
    const outcome = await agent.runTask("Query reports and inspect hello.txt", { emotionAnalysis: false, maxSteps: 10, ...options.run });
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(step, steps.length);
    await recorder.flush();
    return (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
  } finally { await agent.close(); }
}

try {
  const coexist = await runFixture("exposure-coexist", registryWithTools(), [
    (context) => {
      assert.deepEqual(context.tools.map((tool) => tool.name).sort(), ["Read", "ToolSearch", "Write", "exec"]);
      assert.doesNotMatch(context.systemPrompt ?? "", new RegExp(schemaMarker, "u"));
      return call("coexist-read", "Read", { path: "hello.txt" });
    },
    () => call("coexist-write", "Write", { path: "direct.txt", content: "ordinary tools remain usable" }),
    () => call("coexist-exec", "exec", { code: "const row = await tools.Read({path:'hello.txt'}); return {read:row.content};" }),
    finish
  ]);
  assert.equal(await readFile(path.join(workspaceRoot, "direct.txt"), "utf8"), "ordinary tools remain usable");
  assert.deepEqual((resultFor(coexist, "coexist-exec") as { value: unknown }).value, { read: "hello reports" });
  assert.ok(eventsFor(coexist, "coexist-exec:nested:1").some((event) => event.type === "tool_call" && event.auditOnly));
  assert.ok(eventsFor(coexist, "coexist-exec:nested:1").some((event) => event.type === "tool_result" && event.auditOnly));
  assert.equal(defaultConfig.agent.toolExecutionMode, "code_mode");
  assert.equal(configSchema.parse({ ...defaultConfig, agent: { ...defaultConfig.agent, toolExecutionMode: undefined } }).agent.toolExecutionMode, "code_mode");

  let localPreparation = 0;
  const localRead = await runFixture("exposure-local-readiness", registryWithTools(false), [
    () => call("local-read-exec", "exec", { code: "return (await tools.Read({path:'hello.txt'})).content;" }), finish
  ], {
    async prepareToolDiscovery() { localPreparation++; return { pending: ["reports"], timedOut: true }; }
  });
  assert.equal(localPreparation, 0, "a local script never waits for unrelated MCP connections");
  assert.equal((resultFor(localRead, "local-read-exec") as { value: unknown }).value, "hello reports");

  const discoveryRegistry = registryWithTools(false);
  let prepared = 0;
  const discovered = await runFixture("exposure-script-discovery", discoveryRegistry, [
    (context) => {
      assert.ok(!context.tools.some((tool) => tool.name === reportName));
      const exec = context.tools.find((tool) => tool.name === "exec");
      assert.ok(exec);
      assert.doesNotMatch(`${exec.description}\n${exec.promptSnippet ?? ""}`, /project-key-schema-marker|Reports require a project key/u);
      return call("report-exec", "exec", { code: `const scope = await describeNamespace('reports');
const hits = await searchTools('查询项目报告', {namespace:'reports',limit:2});
const signature = await describeTool(hits[0].name);
const data = await tools[hits[0].name]({project:'demo'});
return {instructions:scope.instructions, signature:signature.parameters.properties.project.description, sum:data.structuredContent.reports.reduce((sum,row)=>sum+row.comments,0), resource:data.content[1].uri};` });
    }, finish
  ], {
    async prepareToolDiscovery(_query, signal) {
      signal?.throwIfAborted();
      prepared++;
      if (!discoveryRegistry.list().some((tool) => tool.name === reportName)) discoveryRegistry.registerMcpTool(reportTool());
      return { pending: [], timedOut: false };
    }
  });
  assert.ok(prepared > 0);
  assert.equal(semanticQueries, 1, "the Chinese script lookup uses the injected semantic tool model");
  assert.equal(reports, 1);
  assert.deepEqual((resultFor(discovered, "report-exec") as { value: unknown }).value, {
    instructions: "Reports require a project key.", signature: schemaMarker, sum: 16, resource: "report://demo"
  });
  const nestedResult = discovered.find((event) => event.type === "tool_result" && event.tool === reportName);
  assert.ok(nestedResult && nestedResult.type === "tool_result" && nestedResult.auditOnly);
  assert.equal(nestedResult.toolCallId, "report-exec:nested:1");
  const persistedEnvelope = nestedResult.result as typeof envelope;
  assert.deepEqual(persistedEnvelope.content, envelope.content);
  assert.deepEqual(persistedEnvelope.structuredContent, envelope.structuredContent);
  assert.equal(persistedEnvelope.isError, false);
  assert.ok(eventsFor(discovered, "report-exec:discovery:2").some((event) => event.type === "tool_call" && event.tool === "ToolSearch" && event.auditOnly));
  assert.ok(eventsFor(discovered, "report-exec:discovery:2").some((event) => event.type === "tool_result" && event.tool === "ToolSearch" && event.auditOnly));
  const replay = replaySessionEvents(discovered, { sessionId: "exposure-script-discovery" });
  assert.ok(!replay.messages.some((message) => message.role === "toolResult" && message.toolCallId === "report-exec:nested:1"));

  const directDiscovered = await runFixture("exposure-direct-discovery", registryWithTools(), [
    (context) => {
      assert.ok(!context.tools.some((tool) => tool.name === reportName));
      return call("discover-direct", "ToolSearch", { query: "查询项目报告" });
    },
    (context) => {
      const direct = context.tools.find((tool) => tool.name === reportName);
      assert.ok(direct, "ToolSearch discloses deferred MCP as an ordinary tool");
      assert.match(JSON.stringify(direct.parameters), /project-key-schema-marker/u);
      assert.ok(context.tools.some((tool) => tool.name === "exec"));
      return call("report-direct", reportName, { project: "demo" });
    }, finish
  ]);
  assert.deepEqual((resultFor(directDiscovered, "report-direct") as typeof envelope.structuredContent).reports, envelope.structuredContent.reports);
  assert.equal(reports, 2);

  const privateEvents = await runFixture("exposure-private", registryWithTools(), [
    (context) => {
      assert.ok(context.tools.some((tool) => tool.name === privateNames[1]), "model-only tools remain directly callable when selected");
      assert.ok(!context.tools.some((tool) => tool.name === privateNames[0]), "hidden tools are never disclosed to the model");
      return call("private-description", "exec", { code: `return {hidden:await describeTool('${privateNames[0]}'), modelOnly:await describeTool('${privateNames[1]}')};` });
    },
    () => call("private-call", "exec", { code: `try { await tools['${privateNames[0]}']({project:'demo'}); } catch {} return await tools['${privateNames[1]}']({project:'demo'});` }),
    finish
  ], { automatic: false, run: { capabilitySelection: { tools: "all", skills: "none" } } });
  assert.deepEqual((resultFor(privateEvents, "private-description") as { value: unknown }).value, { hidden: null, modelOnly: null });
  assert.equal((resultFor(privateEvents, "private-call") as { ok: boolean }).ok, false);
  assert.equal(privateCalls, 0);

  const failureRegistry = registryWithTools();
  const failureTool = reportTool("mcp__reports__failure");
  failureTool.resolveExecution = () => ({ approvalRule: failureTool.name, accesses: ToolAccesses.none(), async execute() {
    failedCalls++;
    throw new Error("Remote lookup failed");
  } });
  failureRegistry.registerMcpTool(failureTool);
  const failed = await runFixture("exposure-fail-closed", failureRegistry, [
    () => call("failed-script", "exec", { code: "try { await tools.mcp__reports__failure({project:'demo'}); } catch {} return await tools.mcp__reports__failure({project:'demo'});" }), finish
  ]);
  assert.equal((resultFor(failed, "failed-script") as { ok: boolean }).ok, false);
  assert.equal(failedCalls, 1, "caught script failures neither replay the cell nor dispatch the second child");

  const permissionRegistry = registryWithTools();
  let deniedWrites = 0;
  const remoteWrite = reportTool("mcp__reports__write");
  remoteWrite.risk = "write";
  remoteWrite.resolveExecution = () => ({ approvalRule: remoteWrite.name, accesses: ToolAccesses.none(), async execute() {
    deniedWrites++;
    await writeFile(path.join(workspaceRoot, "forbidden.txt"), "no");
    return { written: true };
  } });
  permissionRegistry.registerMcpTool(remoteWrite);
  const denied = await runFixture("exposure-permission-denied", permissionRegistry, [
    () => call("denied-script", "exec", { code: "try { await tools.mcp__reports__write({project:'demo'}); } catch {} return await tools.mcp__reports__write({project:'demo'});" }), finish
  ], { permissionMode: "read-only" });
  assert.equal((resultFor(denied, "denied-script") as { ok: boolean }).ok, false);
  assert.equal(deniedWrites, 0, "the real permission authority denies the MCP write before dispatch");
  assert.match(JSON.stringify(resultFor(denied, "denied-script:nested:1")), /permission|read.only/iu);
  assert.equal(eventsFor(denied, "denied-script:nested:2").length, 0);
  await assert.rejects(readFile(path.join(workspaceRoot, "forbidden.txt")), { code: "ENOENT" });

  const manual = await runFixture("exposure-manual", registryWithTools(), [
    (context) => {
      assert.deepEqual(context.tools.map((tool) => tool.name).sort(), ["Read", "exec"]);
      return call("manual-description", "exec", { code: "return await describeNamespace('reports');" });
    },
    () => call("manual-call", "exec", { code: "return await tools.mcp__reports__list({project:'demo'});" }), finish
  ], { automatic: false, run: { capabilitySelection: { tools: ["Read"], skills: "none" } } });
  assert.equal((resultFor(manual, "manual-description") as { value: unknown }).value, null);
  assert.equal((resultFor(manual, "manual-call") as { ok: boolean }).ok, false);
  assert.equal(reports, 2, "deferred exposure cannot widen an explicit manual whitelist");
  await runFixture("exposure-none", registryWithTools(), [(context) => {
    assert.deepEqual(context.tools, []);
    return finish();
  }], { automatic: false, run: { capabilitySelection: { tools: "none", skills: "none" } } });
  await runFixture("exposure-direct-mode", registryWithTools(), [(context) => {
    assert.ok(context.tools.some((tool) => tool.name === "Read"));
    assert.ok(context.tools.some((tool) => tool.name === "Write"));
    assert.ok(!context.tools.some((tool) => tool.name === "exec"));
    return finish();
  }], { executionMode: "direct" });
} finally { await rm(workspaceRoot, { recursive: true, force: true }); }

console.log("tool exposure runtime tests passed");
