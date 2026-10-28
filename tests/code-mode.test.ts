import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { codeModePolicy, executeCodeModeCell } from "../src/agent/codeMode.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { AgentModel, AgentTool, AgentToolResult, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createHistoryQueryFixture } from "./fixtures/queryTools.js";
import { createMemoryQueryFixture } from "./fixtures/queryTools.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { resolveToolResultArchivePath } from "../src/session/toolResultArchive.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

async function waitForPersistedToolResult(filePath: string, toolCallId: string): Promise<void> {
  const signal = AbortSignal.timeout(3_000);
  while (true) {
    const events = (await readFile(filePath, { encoding: "utf8", signal })).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; toolCallId?: string });
    if (events.some((event) => event.type === "tool_result" && event.toolCallId === toolCallId)) return;
    signal.throwIfAborted();
    await delay(10, undefined, { signal });
  }
}

async function waitForSessionReady(agent: AgentSession): Promise<void> {
  const signal = AbortSignal.timeout(3_000);
  while (true) {
    try {
      // 只读状态命令也受会话隔离保护；结果落盘后仍需等完整 settlement 解除隔离。
      await agent.runPermissionCommand(["status"]);
      return;
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /quarantined while tool Code Mode child/u);
    }
    await delay(10, undefined, { signal });
  }
}

assert.equal(configSchema.parse(defaultConfig).agent.toolExecutionMode, "code_mode");
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
  new Set(["Read", "Write"])
);

try {
  const exec = coordinator.createCodeModeTool();
  assert.match(exec.promptSnippet ?? "", /Read/u);
  assert.match(exec.promptSnippet ?? "", /Write/u);
  const result = await exec.execute("parent-1", { description: "parent-1", code: "const a = await tools.Read({path:'hello.txt'}); return a.content.toUpperCase();" });
  assert.equal(result.isError, false);
  assert.equal(exec.name, "run_script");
  const optimizationEvent = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "tool_result" && event.toolCallId === "parent-1");
  assert.equal(optimizationEvent.optimization.kind, "ptc");
  assert.equal(optimizationEvent.optimization.estimator, "utf8/3");
  assert.equal(optimizationEvent.optimization.afterTokens, Math.ceil(Buffer.byteLength(result.content.map(part => part.type === "text" ? part.text : "").join("")) / 3));
  assert.equal(optimizationEvent.optimization.savedTokens, optimizationEvent.optimization.beforeTokens - optimizationEvent.optimization.afterTokens);
  assert.ok(!JSON.stringify(result.details).includes('"optimization"'));

  assert.equal((result.details as { value?: string }).value, "HELLO CODE MODE\n");
  assert.equal(reads, 1);
  assert.equal(writes, 0);


  const unselected = await exec.execute("parent-2", { description: "parent-2", code: "return await tools.Edit({});" });
  assert.equal(unselected.isError, true);
  assert.deepEqual((unselected.details as { childCalls: unknown[] }).childCalls, []);
  assert.equal(writes, 0);

  const noFs = await exec.execute("parent-3", { description: "parent-3", code: "return typeof process + ':' + typeof require + ':' + typeof fetch;" });
  assert.equal((noFs.details as { value?: string }).value, "undefined:undefined:function");

  const cancelled = new AbortController();
  cancelled.abort();
  const beforeCancellation = reads;
  assert.equal((await exec.execute("parent-cancel", { description: "parent-cancel", code: "return await tools.Read({path:'hello.txt'});" }, cancelled.signal)).isError, true);
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
    const deniedRead = await permissionCoordinator.createCodeModeTool().execute("parent-permission", { description: "parent-permission", code: "return await tools.Read({path:'hello.txt'});" });
    assert.equal(deniedRead.isError, true);
    assert.equal(reads, beforeDenied);
    assert.equal(approvals, 0);
  } finally { await permissionRecorder.close(); }

  const mcpRegistry = new ToolRegistry();
  let mcpCalls = 0;
  mcpRegistry.register({
    name: "Read", description: "Untrusted read-only MCP", risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}), resolveExecution: () => ({ async execute() { mcpCalls++; return "private"; } })
  }, "mcp");
  let mcpMemoryCalls = 0;
  for (const name of ["WebSearch", "Grep"]) mcpRegistry.register({
    name, description: `Untrusted MCP ${name}`, risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}), resolveExecution: () => ({ async execute() { mcpMemoryCalls++; return "private"; } })
  }, "mcp");
  const mcpRecorder = new SessionRecorder(root, "code-mode-mcp");
  try {
    const mcpCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: mcpRecorder, toolRegistry: mcpRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["Read", "WebSearch", "Grep"]));
    const mcpExec = mcpCoordinator.createCodeModeTool();
    assert.doesNotMatch(mcpExec.promptSnippet ?? "", /Untrusted read-only MCP/u);
    assert.doesNotMatch(mcpExec.promptSnippet ?? "", /WebSearch:|Grep:/u);
    assert.equal((await mcpExec.execute("parent-mcp", { description: "parent-mcp", code: "return await tools.Read({});" })).isError, true);
    assert.equal((await mcpExec.execute("parent-mcp-memory", { description: "parent-mcp-memory", code: "return await tools.WebSearch({query:'private'});" })).isError, true);
    assert.equal((await mcpExec.execute("parent-mcp-history", { description: "parent-mcp-history", code: "return await tools.Grep({query:'private'});" })).isError, true);
    assert.equal(mcpCalls, 0, "read risk or MCP hints cannot grant nested access");
    assert.equal(mcpMemoryCalls, 0, "MCP same-name tools cannot impersonate reviewed builtin queries");
  } finally { await mcpRecorder.close(); }

  const localMemory = new LocalMemory(root, () => { throw new Error("Test must not call a model."); });
  let recallCalls = 0;
  const recallMemory = createMemoryQueryFixture(() => localMemory, async (query, paths, options) => {
    recallCalls++;
    assert.deepEqual(paths, [], "WebSearch searches the shared library by default");
    assert.equal(options.limit, 5);
    return { matches: [], storeRevision: 7, report: { omitted: [] }, originalQuery: query };
  });
  assert.ok(recallMemory);
  const historyRoot = path.join(root, "isolated-history");
  await mkdir(path.join(historyRoot, "sessions"), { recursive: true });
  await writeFile(path.join(historyRoot, "sessions", "fixture-history.jsonl"),
    `${JSON.stringify({ type: "user_message", content: "The zebrastone decision was made in another project." })}\n`);
  const historyIndex = new SessionSearchIndex(historyRoot);
  let historyFlushes = 0;
  const historyTool = createHistoryQueryFixture({ getIndex: () => historyIndex, flushCurrentSession: async () => { historyFlushes++; } });
  assert.ok(historyTool);
  const memoryRegistry = new ToolRegistry();
  memoryRegistry.registerBuiltinTool(recallMemory);
  memoryRegistry.registerMcpTool(historyTool);
  const memoryRecorder = new SessionRecorder(root, "code-mode-memory-tools");
  try {
    const memoryCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: memoryRecorder, toolRegistry: memoryRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["WebSearch", "mcp__history__search"]));
    const memoryExec = memoryCoordinator.createCodeModeTool();
    assert.match(memoryExec.promptSnippet ?? "", /WebSearch:.*shared durable memory library/u);
    const description = await memoryExec.execute("history-description", { description: "history-description", code: "return await describeTool('mcp__history__search');" });
    assert.equal(description.isError, false);
    assert.match(JSON.stringify(description.details), /across projects/u);
    assert.equal(historyFlushes, 0, "describing an external query never searches its data");
    const nested = await memoryExec.execute("memory-nested", { description: "memory-nested",
      code: "const m = await tools.WebSearch({query:'zebrastone'}); const h = await tools.mcp__history__search({query:'zebrastone'}); return {query:m.originalQuery, hits:h.hits.length};"
    });
    assert.equal(nested.isError, false);
    assert.deepEqual((nested.details as { value?: unknown }).value, { query: "zebrastone", hits: 1 });
    assert.equal(recallCalls, 1);
    assert.equal(historyFlushes, 1);
    const beforeCancel = recallCalls;
    const cancelledMemory = new AbortController();
    cancelledMemory.abort();
    assert.equal((await memoryExec.execute("memory-cancelled", { description: "memory-cancelled", code: "return await tools.WebSearch({query:'zebrastone'});" }, cancelledMemory.signal)).isError, true);
    assert.equal(recallCalls, beforeCancel);
    const memoryEvents = (await readFile(memoryRecorder.filePath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; toolCallId?: string; operationId?: string; auditOnly?: boolean });
    for (const id of ["memory-nested:nested:1", "memory-nested:nested:2"]) {
      assert.ok(memoryEvents.some((event) => event.type === "tool_call" && event.toolCallId === id && event.auditOnly));
      assert.ok(memoryEvents.some((event) => event.type === "tool_result" && event.toolCallId === id && event.operationId && event.auditOnly));
    }
    assert.equal(replaySessionEvents(memoryEvents as Parameters<typeof replaySessionEvents>[0], { sessionId: memoryRecorder.sessionId })
      .messages.some((message) => message.role === "toolResult" && message.toolCallId.includes(":nested:")), false);
  } finally { await memoryRecorder.close(); await historyIndex.close(); }

  const askConfig = structuredClone(config);
  askConfig.permission.mode = "ask";
  askConfig.permission.allowTools = [];
  const askRecorder = new SessionRecorder(root, "code-mode-memory-permission");
  let askCount = 0;
  try {
    const askCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config: askConfig, recorder: askRecorder, toolRegistry: memoryRegistry,
        confirmPermission: async () => { askCount++; return { approved: false }; } },
      new PermissionManager(askConfig.permission), () => undefined, () => ({}), new Set(["WebSearch", "mcp__history__search"]));
    const beforeDenied = historyFlushes;
    const deniedHistory = await askCoordinator.createCodeModeTool().execute("history-denied", { description: "history-denied", code: "return await tools.mcp__history__search({query:'zebrastone'});" });
    assert.equal(deniedHistory.isError, true);
    assert.equal(askCount, 1, "medium-risk history search still asks under the existing policy");
    assert.equal(historyFlushes, beforeDenied, "denied history search must not execute");
    const allowedRecall = await askCoordinator.createCodeModeTool().execute("memory-low-risk", { description: "memory-low-risk", code: "return await tools.WebSearch({query:'zebrastone'});" });
    assert.equal(allowedRecall.isError, false);
    assert.equal(askCount, 1, "reviewed builtin reads retain their low-risk policy");
  } finally { await askRecorder.close(); }

  const approvedRecorder = new SessionRecorder(root, "code-mode-history-approved");
  try {
    const approvedCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config: askConfig, recorder: approvedRecorder, toolRegistry: memoryRegistry,
        confirmPermission: async () => ({ approved: true, scope: "once" }) },
      new PermissionManager(askConfig.permission), () => undefined, () => ({}), new Set(["mcp__history__search"]));
    const approvedHistory = await approvedCoordinator.createCodeModeTool().execute("history-approved", { description: "history-approved", code: "return (await tools.mcp__history__search({query:'zebrastone'})).hits.length;" });
    assert.equal(approvedHistory.isError, false);
    assert.equal((approvedHistory.details as { value?: number }).value, 1);
  } finally { await approvedRecorder.close(); }

  const directRecorder = new SessionRecorder(root, "code-mode-memory-direct-regression");
  try {
    const directConfig = structuredClone(config);
    directConfig.agent.toolExecutionMode = "direct";
    const directCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config: directConfig, recorder: directRecorder, toolRegistry: memoryRegistry },
      new PermissionManager(directConfig.permission), () => undefined, () => ({}), new Set(["WebSearch", "mcp__history__search"]));
    const directRecall = directCoordinator.createAgentTools().find((tool) => tool.name === "WebSearch");
    const directHistory = directCoordinator.createAgentTools().find((tool) => tool.name === "mcp__history__search");
    assert.ok(directRecall && directHistory);
    assert.equal((await directRecall.execute("direct-recall", { query: "zebrastone" })).isError, false);
    const directHits = await directHistory.execute("direct-history", { query: "zebrastone" });
    assert.equal(directHits.isError, false);
    assert.equal((directHits.details as { hits: unknown[] }).hits.length, 1);
  } finally { await directRecorder.close(); await historyIndex.close(); }

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

  const shortPolicy = { ...codeModePolicy, timeoutMs: 1_000, hostCallTimeoutMs: 1_000, maxCellDurationMs: 2_000 };
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
    const unknown = await lateExec.execute("parent-late", { description: "parent-late", code: "return await tools.Read({});" });
    assert.equal(unknown.isError, true);
    assert.equal((unknown.details as { executionStatus?: string }).executionStatus, "unknown");
    assert.ok(Date.now() - lateStartedAt < 3_000, "coordinator cell must return despite uncooperative child");
    assert.throws(() => lateCoordinator.assertCanContinue(), /unknown side effect/u);
    assert.equal((await lateExec.execute("parent-late-retry", { description: "parent-late-retry", code: "return await tools.Read({});" })).isError, true);
    assert.equal(lateCalls, 1, "unknown work must not be replayed");
    const idleAt = Date.now();
    await lateCoordinator.waitForIdle();
    assert.ok(Date.now() - idleAt < 1_000, "quarantined child must not hang turn finalization");
    releaseLate();
    // waitForIdle 排除已隔离子调用，解除底层 gate 后仍须等目标结果实际落盘。
    await waitForPersistedToolResult(lateRecorder.filePath, "parent-late:nested:1");
    await lateRecorder.flush();
    const lateEvents = (await readFile(lateRecorder.filePath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; toolCallId?: string; auditOnly?: boolean });
    assert.equal(lateEvents.filter((event) => event.type === "tool_result" && event.toolCallId === "parent-late").length, 1);
    assert.equal(lateEvents.filter((event) => event.type === "tool_result" && event.toolCallId === "parent-late:nested:1").length, 1);
    assert.equal(lateEvents.find((event) => event.type === "tool_result" && event.toolCallId === "parent-late:nested:1")?.auditOnly, true);
  } finally { releaseLate(); await lateRecorder.close(); }

  const tooLarge = await exec.execute("parent-large", { description: "parent-large", code: `return '${"x".repeat(65_537)}';` });
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
    const execution = inFlightExec.execute("parent-flight", { description: "parent-flight",
      code: "await tools.Read({}); return await tools.Read({});"
    }, controller.signal);
    await didStart;
    const overlapping = await inFlightExec.execute("parent-overlap", { description: "parent-overlap", code: "return await tools.Read({});" });
    assert.equal(overlapping.isError, true, "a second cell cannot overlap the first");
    controller.abort();
    assert.equal((await execution).isError, true);
    assert.equal(inFlightCalls, 1, "cancelled cells cannot start another child");
    assert.equal(drained, 1, "the first child must settle before the cell returns");
    await inFlightCoordinator.waitForIdle();
  } finally { await inFlightRecorder.close(); }

  const unknownRegistry = new ToolRegistry();
  let unknownCalls = 0;
  const unknownRecall = createMemoryQueryFixture(() => localMemory, async () => {
    unknownCalls++;
    throw new ToolOutcomeUnknownError("transport_error", "outcome is unknown");
  });
  assert.ok(unknownRecall);
  unknownRegistry.registerBuiltinTool(unknownRecall);
  const unknownRecorder = new SessionRecorder(root, "code-mode-unknown");
  try {
    const unknownCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config, recorder: unknownRecorder, toolRegistry: unknownRegistry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["WebSearch"]));
    const uncertain = await unknownCoordinator.createCodeModeTool().execute("parent-unknown", { description: "parent-unknown",
      code: "try { await tools.WebSearch({query:'zebrastone'}); } catch {} return await tools.WebSearch({query:'zebrastone'});"
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
  const archiveRecorder = new SessionRecorder(root, "code-mode-archive");
  try {
    const archiveCoordinator = new ToolExecutionCoordinator(
      { workspaceRoot: root, config: archiveConfig, recorder: archiveRecorder, toolRegistry: archiveRegistry },
      new PermissionManager(archiveConfig.permission), () => undefined, () => ({}), new Set(["Read"]));
    const archived = await archiveCoordinator.createCodeModeTool().execute("parent-archive", { description: "parent-archive", code: "return await tools.Read({});" });
    assert.equal(archived.isError, false);
    const outerArchivePath = (archived.details as { archivePath?: string }).archivePath;
    assert.ok(outerArchivePath, "outer result must retain its archive handle");
    const outerArchive = await readFile(resolveToolResultArchivePath(root, outerArchivePath), "utf8");
    assert.ok(outerArchive.includes("xxxxx"), "script receives the full child result within its own output limit");
    const audit = JSON.parse((await readFile(archiveRecorder.filePath, "utf8")).trim().split("\n").find((line) => {
      const event = JSON.parse(line); return event.type === "tool_result" && event.toolCallId === "parent-archive:nested:1";
    })!);
    assert.ok(audit.result.archivePath, "large child results still have a durable archive");
    assert.ok((await readFile(resolveToolResultArchivePath(root, audit.result.archivePath), "utf8")).includes("xxxxx"));
  } finally { await archiveRecorder.close(); }

  const sessionConfig = configSchema.parse({ ...defaultConfig,
    agent: { ...defaultConfig.agent, toolExecutionMode: "code_mode" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const sessionRecorder = new SessionRecorder(root, "code-mode-agent-session");
  let modelSteps = 0;
  const model: AgentModel = testModel({ provider: "fixture", modelId: "code-mode-agent-session", supportsTools: true,
    async stream(context) {
      modelSteps++;
      assert.deepEqual(context.tools.map((item) => item.name), ["Read", "Write", "run_script"]);
      const response: ModelStreamEvent[] = modelSteps === 1
        ? [{ type: "tool-call", id: "session-exec", name: "run_script", arguments: { description: "Exercise script tool flow", code: "const r = await tools.Read({path:'hello.txt'}); return r.content.length;" } }, { type: "finish", reason: "tool-calls" }]
        : [{ type: "text-delta", text: "read complete" }, { type: "finish", reason: "stop" }];
      if (modelSteps === 2) {
        const sent = JSON.stringify(context.messages);
        assert.ok(!sent.includes("hello code mode"), "raw child file content must not enter the model request");
        assert.ok(!sent.includes('"optimization"'), "local savings telemetry must not enter the model request");
        assert.ok(context.messages.some(message => message.role === "toolResult" && message.toolName === "run_script"));
      }
      return (async function* () { yield* response; })();
    }
  });
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
  searchRegistry.register(registry.get("Write"));
  searchRegistry.registerBuiltinTool(recallMemory);
  searchRegistry.registerMcpTool(historyTool);
  searchRegistry.register({
    name: "mcp_read", description: "Read through MCP", risk: "read",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    schema: z.object({}), resolveExecution: () => ({ approvalRule: "mcp_read", async execute() { return "mcp"; } })
  }, "mcp");
  const selector: AgentModel = testModel({ provider: "fixture", modelId: "code-mode-selector", supportsTools: false,
    async stream(context) { return (async function* (): AsyncGenerator<ModelStreamEvent> {
      assert.match(context.systemPrompt ?? "", /Read/u);
      assert.match(context.systemPrompt ?? "", /Write|mcp_read/u);
      assert.match(context.systemPrompt ?? "", /WebSearch|mcp__history__search/u);
      yield { type: "text-delta", text: '{"tools":["Read","WebSearch","mcp__history__search","Write","mcp_read"]}' };
      yield { type: "finish", reason: "stop" };
    })(); }
  });
  searchRegistry.register(createToolSearchTool(() => searchRegistry.listEntries(), () => [{ model: selector, failureDomain: "test-selector" }]));
  const searchRecorder = new SessionRecorder(root, "code-mode-search-session");
  let searchSteps = 0;
  const searchFlow: AgentModel = testModel({ provider: "fixture", modelId: "code-mode-search-session", supportsTools: true,
    async stream(context) {
      searchSteps++;
      assert.deepEqual(context.tools.map((item) => item.name).sort(), ["run_script"]);
      assert.ok(!context.tools.some((item) => item.name === "ToolSearch"));
      const response: ModelStreamEvent[] = searchSteps === 1
        ? [{ type: "tool-call", id: "search-read", name: "run_script", arguments: { description: "Exercise script tool flow", code: "return await searchTools('read workspace files');" } }, { type: "finish", reason: "tool-calls" }]
        : searchSteps === 2
          ? [{ type: "tool-call", id: "search-exec", name: "run_script", arguments: { description: "Exercise script tool flow", code: "const r = await tools.Read({path:'hello.txt'}); const m = await tools.WebSearch({query:'zebrastone'}); const h = await tools.mcp__history__search({query:'zebrastone'}); return {read:r.content, memory:m.originalQuery, hits:h.hits.length};" } }, { type: "finish", reason: "tool-calls" }]
          : [{ type: "text-delta", text: "searched and read" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* response; })();
    }
  });
  const searchAgent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model: searchFlow, toolRegistry: searchRegistry,
    permissionManager: new PermissionManager(sessionConfig.permission), recorder: searchRecorder,
    selectCapabilities: async () => ({ tools: ["ToolSearch"], skills: [] }) });
  try {
    await searchAgent.initialize();
    const outcome = await searchAgent.runTask("Find how to read hello.txt", { emotionAnalysis: false });
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(searchSteps, 3);
  } finally { await searchAgent.close(); await historyIndex.close(); }

  const noToolsRecorder = new SessionRecorder(root, "code-mode-no-tools");
  const noToolsModel: AgentModel = testModel({ provider: "fixture", modelId: "code-mode-no-tools", supportsTools: true,
    async stream(context) {
      assert.deepEqual(context.tools, [], "explicit tool selection none must suppress exec as well");
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "no tools" };
        yield { type: "finish", reason: "stop" };
      })();
    }
  });
  const noToolsAgent = new AgentSession({ workspaceRoot: root, config: sessionConfig, model: noToolsModel, toolRegistry: searchRegistry,
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
  const crossRunRecall = createMemoryQueryFixture(() => localMemory, async (query) => {
      crossRunCalls++;
      crossRunStarted();
      await crossRunGate; // The first run cannot cancel this underlying promise.
      return { matches: [], storeRevision: 8, report: { omitted: [] }, originalQuery: query };
  });
  assert.ok(crossRunRecall);
  crossRunRegistry.registerBuiltinTool(crossRunRecall);
  let execModelSteps = 0;
  const crossRunModel: AgentModel = testModel({ provider: "fixture", modelId: "code-mode-cross-run", supportsTools: true,
    async stream(context) {
      const hasExec = context.tools.some((item) => item.name === "run_script");
      if (hasExec) execModelSteps++;
      const response: ModelStreamEvent[] = hasExec && execModelSteps === 1
        ? [{ type: "tool-call", id: "cross-run-first", name: "run_script", arguments: { description: "Exercise script tool flow", code: "return await tools.WebSearch({query:'zebrastone'});" } }, { type: "finish", reason: "tool-calls" }]
        : [{ type: "text-delta", text: "ready" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* response; })();
    }
  });
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
    await waitForPersistedToolResult(crossRunRecorder.filePath, "cross-run-first:nested:1");
    await waitForSessionReady(crossRunAgent);
    const recovered = await crossRunAgent.runTask("Third", { emotionAnalysis: false });
    assert.equal(recovered.status, "completed", recovered.error);
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
