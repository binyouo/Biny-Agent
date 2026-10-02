import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { codeModePolicy, executeCodeModeCell } from "../src/agent/codeMode.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, AgentTool, AgentToolResult, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { resolveToolResultArchivePath } from "../src/session/toolResultArchive.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

assert.equal(configSchema.parse(defaultConfig).agent.toolExecutionMode, "direct");
assert.equal(configSchema.parse({ ...defaultConfig, agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" } }).agent.toolExecutionMode, "code_mode");

const root = await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-"));
await ensureAgentDirs(root);
await writeFile(path.join(root, "hello.txt"), "hello code mode\n", "utf8");
const registry = new ToolRegistry();
let reads = 0;
let writes = 0;
registry.register({
  name: "Read", description: "Read a fixture file", risk: "read", capability: "filesystem.read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  schema: z.object({ path: z.string() }),
  resolveExecution: ({ path: file }) => ({
    approvalRule: `Read(${file})`,
    async execute() { reads++; return { content: await readFile(path.join(root, file), "utf8") }; }
  })
});
registry.register({
  name: "Write", description: "Write a fixture file", risk: "write", capability: "filesystem.write",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  schema: z.object({}), resolveExecution: () => ({ approvalRule: "Write", async execute() { writes++; return { ok: true }; } })
});
const config = structuredClone(defaultConfig);
config.agent.maxConcurrentTools = 1;
config.permission.mode = "full-access";
const recorder = new SessionRecorder(root, "code-mode-test");
const coordinator = new ToolExecutionCoordinator(
  { workspaceRoot: root, config, recorder, toolRegistry: registry },
  new PermissionManager(config.permission), () => undefined, () => ({}),
  new Set(["Read", "Write"]), { maxToolCalls: 3, maxRepeatedActions: 3 }
);

try {
  const exec = coordinator.createCodeModeTool();
  assert.match(exec.promptSnippet ?? "", /Read/u);
  assert.doesNotMatch(exec.promptSnippet ?? "", /Write/u);
  const result = await exec.execute("parent-1", { code: "const a = await tools.Read({path:'hello.txt'}); return a.content.toUpperCase();" });
  assert.equal(result.isError, false);
  assert.equal((result.details as { value?: string }).value, "HELLO CODE MODE\n");
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 1);

  const denied = await exec.execute("parent-2", { code: "return await tools.Write({});" });
  assert.equal(denied.isError, true);
  assert.equal(writes, 0);

  const noFs = await exec.execute("parent-3", { code: "return typeof process + ':' + typeof require + ':' + typeof fetch;" });
  assert.equal((noFs.details as { value?: string }).value, "undefined:undefined:undefined");

  const cancelled = new AbortController();
  cancelled.abort();
  const beforeCancellation = reads;
  assert.equal((await exec.execute("parent-cancel", { code: "return await tools.Read({path:'hello.txt'});" }, cancelled.signal)).isError, true);
  assert.equal(reads, beforeCancellation);

  const permissionsConfig = structuredClone(config);
  permissionsConfig.permission.mode = "ask";
  permissionsConfig.permission.allowTools = [];
  permissionsConfig.permission.denyPaths = ["hello.txt"];
  const permissionRecorder = new SessionRecorder(root, "code-mode-permission");
  const permissionRegistry = new ToolRegistry();
  permissionRegistry.register(createReadFileTool({ workspaceRoot: root, ignore: [] }));
  let approvals = 0;
  try {
    const permissionCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config: permissionsConfig, recorder: permissionRecorder, toolRegistry: permissionRegistry,
        confirmPermission: async () => { approvals++; return { approved: false }; } },
      new PermissionManager(permissionsConfig.permission), () => undefined, () => ({}), new Set(["Read"]));
    const beforeDenied = reads;
    const deniedRead = await permissionCoordinator.createCodeModeTool().execute("parent-permission", { code: "return await tools.Read({path:'hello.txt'});" });
    assert.equal(deniedRead.isError, true);
    assert.equal(reads, beforeDenied);
    assert.equal(approvals, 0);
  } finally { await permissionRecorder.close(); }

  const budgetRecorder = new SessionRecorder(root, "code-mode-budget");
  try {
    const budgetCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: budgetRecorder, toolRegistry: registry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read"]),
      { maxToolCalls: 1, maxRepeatedActions: 3 });
    const beforeBudget = reads;
    const overBudget = await budgetCoordinator.createCodeModeTool().execute("parent-budget", {
      code: "await tools.Read({path:'hello.txt'}); return await tools.Read({path:'hello.txt'});"
    });
    assert.equal(overBudget.isError, true);
    assert.equal(reads, beforeBudget + 1);
    assert.equal(budgetCoordinator.getExecutionBudgetSnapshot().accountedToolCalls, 2);
  } finally { await budgetRecorder.close(); }

  const mcpRegistry = new ToolRegistry();
  let mcpCalls = 0;
  mcpRegistry.register({
    name: "Read", description: "Untrusted read-only MCP", risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}), resolveExecution: () => ({ async execute() { mcpCalls++; return "private"; } })
  }, "mcp");
  const mcpRecorder = new SessionRecorder(root, "code-mode-mcp");
  try {
    const mcpCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: mcpRecorder, toolRegistry: mcpRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read"]));
    const mcpExec = mcpCoordinator.createCodeModeTool();
    assert.doesNotMatch(mcpExec.promptSnippet ?? "", /Untrusted read-only MCP/u);
    assert.equal((await mcpExec.execute("parent-mcp", { code: "return await tools.Read({});" })).isError, true);
    assert.equal(mcpCalls, 0, "read risk or MCP hints cannot grant nested access");
  } finally { await mcpRecorder.close(); }

  const loop = await executeCodeModeCell({
    code: "while(true){}", parentToolCallId: "loop", tools: [], isCurrent: () => false,
  });
  assert.equal(loop.ok, false);
  assert.match(loop.error ?? "", /interrupt|time|budget|limit/i);
  const importEscape = await executeCodeModeCell({
    code: "return await import('node:fs');", parentToolCallId: "import", tools: [], isCurrent: () => false
  });
  assert.equal(importEscape.ok, false);
  assert.match(importEscape.error ?? "", /could not load module/u);

  const shortPolicy = { ...codeModePolicy, timeoutMs: 1_000 };
  let permissionWaitAborted = false;
  const waitingForPermission: AgentTool = {
    name: "Read", description: "Read after permission", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    async execute(_id, _args, signal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      permissionWaitAborted = true;
      return { content: [{ type: "text", text: "cancelled" }], details: { status: "cancelled" }, isError: true };
    }
  };
  const permissionWaitResult = await executeCodeModeCell({
    code: "return await tools.Read({});", parentToolCallId: "permission-wait", tools: [waitingForPermission],
    isCurrent: () => true, executionPolicy: shortPolicy
  });
  assert.equal(permissionWaitResult.ok, false);
  assert.equal(permissionWaitResult.outcomeUnknown, undefined, "a cooperative approval wait must drain cleanly");
  assert.equal(permissionWaitAborted, true);

  let rejectNever!: (error: Error) => void;
  const neverSettles: AgentTool = {
    name: "Read", description: "Never settles", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    async execute(): Promise<AgentToolResult> { return await new Promise<AgentToolResult>((_resolve, reject) => { rejectNever = reject; }); }
  };
  const stuckAt = Date.now();
  const stuck = await executeCodeModeCell({
    code: "return await tools.Read({});", parentToolCallId: "stuck", tools: [neverSettles],
    isCurrent: () => true, executionPolicy: shortPolicy
  });
  assert.equal(stuck.outcomeUnknown, true, "uncooperative host work must be reported as unknown");
  assert.ok(Date.now() - stuckAt < 3_000, "drain must be bounded after sandbox timeout");
  rejectNever(new Error("late host rejection"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const lateRegistry = new ToolRegistry();
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
  let lateCalls = 0;
  lateRegistry.register({
    name: "Read", description: "Late read", risk: "read", capability: "filesystem.read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}), resolveExecution: () => ({ approvalRule: "Read", async execute() {
      lateCalls++;
      await lateGate; // Deliberately ignores abort to exercise the bounded drain.
      return { content: "late" };
    } })
  });
  const lateRecorder = new SessionRecorder(root, "code-mode-late-child");
  try {
    const lateCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: lateRecorder, toolRegistry: lateRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read"]));
    const lateExec = lateCoordinator.createCodeModeTool(undefined, shortPolicy);
    const lateStartedAt = Date.now();
    const unknown = await lateExec.execute("parent-late", { code: "return await tools.Read({});" });
    assert.equal(unknown.isError, true);
    assert.equal((unknown.details as { executionStatus?: string }).executionStatus, "unknown");
    assert.ok(Date.now() - lateStartedAt < 3_000, "coordinator cell must return despite uncooperative child");
    assert.throws(() => lateCoordinator.assertCanContinue(), /unknown side effect/u);
    assert.equal((await lateExec.execute("parent-late-retry", { code: "return await tools.Read({});" })).isError, true);
    assert.equal(lateCalls, 1, "unknown work must not be replayed");
    const idleAt = Date.now();
    await lateCoordinator.waitForIdle();
    assert.ok(Date.now() - idleAt < 1_000, "quarantined child must not hang turn finalization");
    releaseLate();
    await lateCoordinator.waitForIdle();
    await lateRecorder.flush();
    const lateEvents = (await readFile(lateRecorder.filePath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; toolCallId?: string; auditOnly?: boolean });
    assert.equal(lateEvents.filter((event) => event.type === "tool_result" && event.toolCallId === "parent-late").length, 1);
    assert.equal(lateEvents.filter((event) => event.type === "tool_result" && event.toolCallId === "parent-late:nested:1").length, 1);
    assert.equal(lateEvents.find((event) => event.type === "tool_result" && event.toolCallId === "parent-late:nested:1")?.auditOnly, true);
  } finally { releaseLate(); await lateRecorder.close(); }

  const tooLarge = await exec.execute("parent-large", { code: `return '${"x".repeat(65_537)}';` });
  assert.equal(tooLarge.isError, true);
  assert.equal((tooLarge.details as { childCalls: unknown[] }).childCalls.length, 0);

  const inFlightRegistry = new ToolRegistry();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  let inFlightCalls = 0;
  let drained = 0;
  inFlightRegistry.register({
    name: "Read", description: "Abortable read", risk: "read", capability: "filesystem.read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "Read", async execute({ signal }) {
      inFlightCalls++;
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      drained++;
      throw new Error("aborted");
    } })
  });
  const inFlightRecorder = new SessionRecorder(root, "code-mode-in-flight");
  try {
    const inFlightCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: inFlightRecorder, toolRegistry: inFlightRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read"]));
    const controller = new AbortController();
    const inFlightExec = inFlightCoordinator.createCodeModeTool();
    const execution = inFlightExec.execute("parent-flight", {
      code: "await tools.Read({}); return await tools.Read({});"
    }, controller.signal);
    await didStart;
    const overlapping = await inFlightExec.execute("parent-overlap", { code: "return await tools.Read({});" });
    assert.equal(overlapping.isError, true, "a second cell cannot overlap the first");
    controller.abort();
    assert.equal((await execution).isError, true);
    assert.equal(inFlightCalls, 1, "cancelled cells cannot start another child");
    assert.equal(drained, 1, "the first child must settle before the cell returns");
    await inFlightCoordinator.waitForIdle();
  } finally { await inFlightRecorder.close(); }

  const unknownRegistry = new ToolRegistry();
  let unknownCalls = 0;
  unknownRegistry.register({
    name: "Read", description: "Uncertain read", risk: "read", capability: "filesystem.read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "Read", async execute() {
      unknownCalls++;
      throw new ToolOutcomeUnknownError("transport_error", "outcome is unknown");
    } })
  });
  const unknownRecorder = new SessionRecorder(root, "code-mode-unknown");
  try {
    const unknownCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: unknownRecorder, toolRegistry: unknownRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read"]));
    const uncertain = await unknownCoordinator.createCodeModeTool().execute("parent-unknown", {
      code: "try { await tools.Read({}); } catch {} return await tools.Read({});"
    });
    assert.equal(uncertain.isError, true);
    assert.equal(unknownCalls, 1, "an unknown child cannot cause replay of the cell");
    assert.throws(() => unknownCoordinator.assertCanContinue(), /unknown side effect/u);
  } finally { await unknownRecorder.close(); }

  const archiveConfig = structuredClone(config);
  archiveConfig.context.maxTurnToolResultBytes = 512;
  const archiveRegistry = new ToolRegistry();
  archiveRegistry.register({
    name: "Read", description: "Large read", risk: "read", capability: "filesystem.read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "Read", async execute() { return { content: "x".repeat(50_000) }; } })
  });
  archiveRegistry.register(createReadToolResultTool({ workspaceRoot: root, ignore: [] }));
  const archiveRecorder = new SessionRecorder(root, "code-mode-archive");
  try {
    const archiveCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config: archiveConfig, recorder: archiveRecorder, toolRegistry: archiveRegistry },
      new PermissionManager(archiveConfig.permission), () => undefined, () => ({}), new Set(["Read", "read_tool_result"]));
    const archived = await archiveCoordinator.createCodeModeTool().execute("parent-archive", { code: "return await tools.Read({});" });
    assert.equal(archived.isError, false);
    const outerArchivePath = (archived.details as { archivePath?: string }).archivePath;
    assert.ok(outerArchivePath, "outer result must retain its archive handle");
    const outerArchive = await readFile(resolveToolResultArchivePath(root, outerArchivePath), "utf8");
    const childArchivePath = outerArchive.match(/\.biny\/tool-results\/tool-result-[0-9a-f]{64}\.json/u)?.[0];
    assert.ok(childArchivePath, "nested result must retain its own archive handle");
    assert.ok((await readFile(resolveToolResultArchivePath(root, childArchivePath), "utf8")).includes("xxxxx"));
  } finally { await archiveRecorder.close(); }

  const sessionConfig = configSchema.parse({ ...defaultConfig,
    agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const sessionRecorder = new SessionRecorder(root, "code-mode-agent-session");
  let modelSteps = 0;
  const model: AgentModel = { provider: "fixture", modelId: "code-mode-agent-session", supportsTools: true,
    async stream(context) {
      modelSteps++;
      assert.deepEqual(context.tools.map((item) => item.name), ["exec"]);
      const response: ModelStreamEvent[] = modelSteps === 1
        ? [{ type: "tool-call", id: "session-exec", name: "exec", arguments: { code: "const r = await tools.Read({path:'hello.txt'}); return r.content;" } }, { type: "finish", reason: "tool-calls" }]
        : [{ type: "text-delta", text: "read complete" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* response; })();
    }
  };
  const agent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model, toolRegistry: registry,
    permissionManager: new PermissionManager(sessionConfig.permission), recorder: sessionRecorder });
  try {
    await agent.initialize();
    const outcome = await agent.runTask("Read hello.txt", { emotionAnalysis: false });
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(modelSteps, 2);
    assert.equal(writes, 0);
  } finally { await agent.close(); }

  const searchRegistry = new ToolRegistry();
  searchRegistry.register(registry.get("Read"));
  const selector: AgentModel = { provider: "fixture", modelId: "code-mode-selector", supportsTools: false,
    async stream() { return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: '{"tools":["Read"]}' };
      yield { type: "finish", reason: "stop" };
    })(); }
  };
  searchRegistry.register(createToolSearchTool(() => searchRegistry.listEntries(), () => selector));
  const searchRecorder = new SessionRecorder(root, "code-mode-search-session");
  let searchSteps = 0;
  const searchFlow: AgentModel = { provider: "fixture", modelId: "code-mode-search-session", supportsTools: true,
    async stream(context) {
      searchSteps++;
      assert.deepEqual(context.tools.map((item) => item.name).sort(), ["ToolSearch", "exec"]);
      const execCatalog = context.tools.find((item) => item.name === "exec")?.promptSnippet ?? "";
      if (searchSteps === 1) assert.doesNotMatch(execCatalog, /Read:/u);
      if (searchSteps >= 2) assert.match(execCatalog, /Read:/u);
      const response: ModelStreamEvent[] = searchSteps === 1
        ? [{ type: "tool-call", id: "search-read", name: "ToolSearch", arguments: { query: "read workspace files" } }, { type: "finish", reason: "tool-calls" }]
        : searchSteps === 2
          ? [{ type: "tool-call", id: "search-exec", name: "exec", arguments: { code: "return await tools.Read({path:'hello.txt'});" } }, { type: "finish", reason: "tool-calls" }]
          : [{ type: "text-delta", text: "searched and read" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* response; })();
    }
  };
  const searchAgent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model: searchFlow, toolRegistry: searchRegistry,
    permissionManager: new PermissionManager(sessionConfig.permission), recorder: searchRecorder,
    selectCapabilities: async () => ({ tools: ["ToolSearch"], skills: [] }) });
  try {
    await searchAgent.initialize();
    const outcome = await searchAgent.runTask("Find how to read hello.txt", { emotionAnalysis: false });
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(searchSteps, 3);
  } finally { await searchAgent.close(); }

  const noToolsRecorder = new SessionRecorder(root, "code-mode-no-tools");
  const noToolsModel: AgentModel = { provider: "fixture", modelId: "code-mode-no-tools", supportsTools: true,
    async stream(context) {
      assert.deepEqual(context.tools, [], "explicit tool selection none must suppress exec as well");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "no tools" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const noToolsAgent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model: noToolsModel, toolRegistry: registry,
    permissionManager: new PermissionManager(sessionConfig.permission), recorder: noToolsRecorder,
    selectCapabilities: async () => ({ tools: "none", skills: [] }) });
  try {
    await noToolsAgent.initialize();
    assert.equal((await noToolsAgent.runTask("Just answer", { emotionAnalysis: false })).status, "completed");
  } finally { await noToolsAgent.close(); }

  const crossRunRegistry = new ToolRegistry();
  let crossRunStarted!: () => void;
  const crossRunDidStart = new Promise<void>((resolve) => { crossRunStarted = resolve; });
  let releaseCrossRun!: () => void;
  const crossRunGate = new Promise<void>((resolve) => { releaseCrossRun = resolve; });
  let crossRunCalls = 0;
  crossRunRegistry.register({
    name: "Glob", description: "Fixture list", risk: "read", capability: "filesystem.list",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "Glob", async execute() {
      crossRunCalls++;
      crossRunStarted();
      await crossRunGate; // The first run cannot cancel this underlying promise.
      return { files: [] };
    } })
  });
  let execModelSteps = 0;
  const crossRunModel: AgentModel = { provider: "fixture", modelId: "code-mode-cross-run", supportsTools: true,
    async stream(context) {
      const hasExec = context.tools.some((item) => item.name === "exec");
      if (hasExec) execModelSteps++;
      const response: ModelStreamEvent[] = hasExec && execModelSteps === 1
        ? [{ type: "tool-call", id: "cross-run-first", name: "exec", arguments: { code: "return await tools.Glob({});" } }, { type: "finish", reason: "tool-calls" }]
        : [{ type: "text-delta", text: "ready" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* response; })();
    }
  };
  const crossRunRecorder = new SessionRecorder(root, "code-mode-cross-run");
  const crossRunAgent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model: crossRunModel,
    toolRegistry: crossRunRegistry, permissionManager: new PermissionManager(sessionConfig.permission), recorder: crossRunRecorder });
  try {
    await crossRunAgent.initialize();
    const abortFirst = new AbortController();
    const firstRun = crossRunAgent.runTask("First", { emotionAnalysis: false, abortSignal: abortFirst.signal });
    await crossRunDidStart;
    abortFirst.abort();
    assert.equal((await firstRun).status, "cancelled");
    const blocked = await crossRunAgent.runTask("Second", { emotionAnalysis: false });
    assert.equal(blocked.status, "failed");
    assert.match(blocked.error ?? "", /quarantined/u);
    assert.equal(crossRunCalls, 1, "a new run must not overlap or replay the unsettled child");
    releaseCrossRun();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await crossRunAgent.runTask("Third", { emotionAnalysis: false })).status, "completed");
    assert.equal(crossRunCalls, 1, "recovery must not replay the prior Code Mode cell");
  } finally { releaseCrossRun(); await crossRunAgent.close(); }

  const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; toolCallId?: string; operationId?: string; auditOnly?: boolean });
  assert.ok(events.some((event) => event.type === "tool_call" && event.toolCallId === "parent-1"));
  assert.ok(events.some((event) => event.type === "tool_call" && event.toolCallId === "parent-1:nested:1" && event.auditOnly));
  assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === "parent-1:nested:1" && event.operationId && event.auditOnly));
  assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === "parent-1" && event.operationId));
  const replay = replaySessionEvents(events as Parameters<typeof replaySessionEvents>[0], { sessionId: recorder.sessionId });
  assert.equal(replay.messages.some((message) => message.role === "toolResult" && message.toolCallId.includes(":nested:")), false);
} finally {
  await recorder.close();
  await rm(root, { recursive: true, force: true });
}
console.log("code mode tests passed");
