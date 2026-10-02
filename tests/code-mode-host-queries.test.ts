/** New read queries require host registration identity, never extension hints. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { codeModePolicy } from "../src/agent/codeMode.js";
import type { AgentModel, AgentToolResult, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { createSkillLookupTool, createSkillResourceTool, createSkillTool, loadSkills } from "../src/extensions/skills.js";
import { createTaskStatusTool, type SubagentOptions } from "../src/extensions/subagent.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { isCodeModeReadTool, ToolRegistry } from "../src/tools/registry.js";
import { createBashOutputTool } from "../src/tools/process/managedProcesses.js";
import { createToolSearchTool, toolSearchResultNames, toolSearchResultNamesFromMessages } from "../src/tools/toolSearch.js";
import type { ToolSource } from "../src/tools/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-host-queries-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
await ensureAgentDirs(root);
await mkdir(path.join(root, "skills", "query-fixture"), { recursive: true });
await mkdir(path.join(root, "global"));
await writeFile(path.join(root, "skills", "query-fixture", "SKILL.md"),
  "---\nname: query-fixture\ndescription: Fixture query metadata\n---\nNever activate this fixture in Code Mode.\n");
const bundle = await loadSkills({ workspaceRoot: root, projectPaths: ["skills"], globalRoot: path.join(root, "global") });
const config = structuredClone(defaultConfig);
config.agent.toolExecutionMode = "code_mode";
config.agent.maxConcurrentTools = 1;
config.permission.mode = "full-access";
config.context.memory.enabled = false;
config.context.memory.useMemories = false;
config.context.memory.generateMemories = false;
config.context.identity.enabled = false;
config.context.identity.userEnabled = false;
config.heartbeat.enabled = false;
config.activity.enabled = false;
const selected = new Set(["TaskStatus", "skill_lookup"]);
const recorders: SessionRecorder[] = [];
let statusCalls = 0;
const statusOptions: SubagentOptions = {
  workspaceRoot: root, config, toolRegistry: new ToolRegistry(),
  getModelSettings: () => { throw new Error("A status read cannot request a model."); },
  getAccessMode: () => "read-only",
  runVerifiedTask: async () => { throw new Error("A status read cannot start a task."); },
  readTaskResult: async (taskRunId) => {
    statusCalls++;
    return { taskRunId, status: "needs_approval", verification: { status: "pending" } };
  }
};
const makeRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry();
  registry.registerHostReadQuery(createTaskStatusTool(statusOptions), "TaskStatus");
  registry.registerHostReadQuery(createSkillLookupTool(bundle), "skill_lookup");
  registry.registerUserTool(createSkillTool(bundle));
  registry.registerUserTool(createSkillResourceTool(bundle));
  registry.registerBuiltinTool(createBashOutputTool(new ManagedProcessService({ workspaceRoot: root })));
  return registry;
};
function coordinator(registry: ToolRegistry, id: string, options?: {
  tools?: Set<string>;
  ask?: (request: { tool: string; riskLevel?: string }) => Promise<{ approved: boolean; scope?: "once" }>;
  budget?: { maxToolCalls: number; maxRepeatedActions: number };
}): ToolExecutionCoordinator {
  const recorder = new SessionRecorder(root, id);
  recorders.push(recorder);
  const settings = structuredClone(config);
  if (options?.ask) { settings.permission.mode = "ask"; settings.permission.allowTools = []; }
  return new ToolExecutionCoordinator({ workspaceRoot: root, config: settings, recorder, toolRegistry: registry,
    confirmPermission: options?.ask }, new PermissionManager(settings.permission), () => undefined, () => ({}),
  options?.tools ?? selected, options?.budget);
}
const details = (result: AgentToolResult): { value?: unknown; childCalls?: unknown[]; error?: string; outcomeUnknown?: boolean } =>
  result.details as ReturnType<typeof details>;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const model = (callback: (prompt: string) => Promise<void> | void): AgentModel => ({
  provider: "fixture", modelId: "host-query-selector", supportsTools: false,
  async stream(context) {
    await callback(context.systemPrompt ?? "");
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: JSON.stringify({ tools: ["TaskStatus", "skill_lookup", "Skill", "read_skill_resource", "BashOutput", "Task"] }) };
      yield { type: "finish", reason: "stop" };
    })();
  }
});

try {
  // Every ordinary source route remains incapable of asserting host authority.
  for (const source of ["builtin", "skill", "subagent", "mcp", "plugin"] as ToolSource[]) {
    const registry = new ToolRegistry();
    for (const name of selected) {
      const impostor = Object.assign(name === "TaskStatus" ? createTaskStatusTool(statusOptions) : createSkillLookupTool(bundle), {
        source, hostReadQuery: name, readOnlyHint: true, codeModeReadOnly: true
      });
      registry.register(impostor, source);
    }
    assert.equal(registry.listEntries().some(isCodeModeReadTool), false, source);
    const exec = coordinator(registry, `untrusted-${source}`).createCodeModeTool();
    assert.doesNotMatch(exec.promptSnippet ?? "", /TaskStatus:|skill_lookup:/u);
    const before = statusCalls;
    assert.equal((await exec.execute(`untrusted-call-${source}`, { code: "return await tools.TaskStatus({taskRunId:'fixture'});" })).isError, true);
    assert.equal(statusCalls, before);
  }
  const registry = makeRegistry();
  const entries = registry.listEntries().filter(isCodeModeReadTool);
  assert.deepEqual(entries.map((entry) => [entry.tool.name, entry.source]), [["TaskStatus", "subagent"], ["skill_lookup", "skill"]]);
  for (const entry of entries) {
    assert.equal(isCodeModeReadTool({ ...entry }), false, "cloning or serializing an entry cannot copy authority");
    assert.throws(() => Object.assign(entry, { source: "builtin", hostReadQuery: entry.tool.name }), TypeError);
  }
  const invalid = createTaskStatusTool(statusOptions);
  invalid.risk = "execute";
  assert.throws(() => new ToolRegistry().registerHostReadQuery(invalid, "TaskStatus"), /Invalid host read-query/u);
  const changedRegistry = makeRegistry();
  const changedTool = changedRegistry.get("TaskStatus");
  changedTool.resolveExecution = () => ({ approvalRule: "changed", execute: async () => ({ ok: true }) });
  assert.equal(changedRegistry.listEntries().some((entry) => entry.tool.name === "TaskStatus" && isCodeModeReadTool(entry)), false,
    "an in-place resolver replacement cannot retain the original host contract");

  const main = coordinator(registry, "host-query-happy", { budget: { maxToolCalls: 8, maxRepeatedActions: 8 } });
  const exec = main.createCodeModeTool({ mode: "replace" });
  assert.match(exec.promptSnippet ?? "", /TaskStatus:|skill_lookup:/u);
  assert.doesNotMatch(exec.promptSnippet ?? "", /Skill:|read_skill_resource:|BashOutput:|Task:/u);
  const result = await exec.execute("host-query-cell", { code:
    "const status = await tools.TaskStatus({taskRunId:'fixture'}); const skills = await tools.skill_lookup({query:'query-fixture',limit:1}); return {status:status.status, skill:skills.skills[0].name};" });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.deepEqual(details(result).value, { status: "needs_approval", skill: "query-fixture" });
  assert.equal(main.getExecutionBudgetSnapshot().accountedToolCalls, 2);
  const held = coordinator(registry, "held-read-queries", { tools: new Set([...selected, "BashOutput", "read_skill_resource", "Skill"]) });
  assert.doesNotMatch(held.createCodeModeTool().promptSnippet ?? "", /BashOutput:|read_skill_resource:|Skill:/u);
  for (const [name, args] of [["BashOutput", {}], ["read_skill_resource", { skill: "query-fixture", path: "SKILL.md" }]] as const) {
    const unavailable = await held.createCodeModeTool().execute(`held-${name}`, { code: `return await tools.${name}(${JSON.stringify(args)});` });
    assert.equal(unavailable.isError, true);
    assert.deepEqual(details(unavailable).childCalls, [], "held reads must never enter the host coordinator");
  }
  await main.waitForIdle();
  const mainRecorder = recorders.find((recorder) => recorder.sessionId === "host-query-happy")!;
  const events = (await readFile(mainRecorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const id of ["host-query-cell:nested:1", "host-query-cell:nested:2"]) {
    assert.equal(events.filter((event) => event.type === "tool_call" && event.toolCallId === id && event.auditOnly).length, 1);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.toolCallId === id && event.operationId && event.auditOnly).length, 1);
  }
  assert.equal(replaySessionEvents(events, { sessionId: mainRecorder.sessionId }).messages
    .some((message) => message.role === "toolResult" && message.toolCallId.includes(":nested:")), false);

  const none = coordinator(registry, "host-query-selection-none", { tools: new Set() }).createCodeModeTool();
  assert.doesNotMatch(none.promptSnippet ?? "", /TaskStatus:|skill_lookup:/u);
  assert.equal((await none.execute("selection-none", { code: "return await tools.skill_lookup({query:'fixture'});" })).isError, true);
  for (const name of selected) {
    let approvals = 0;
    const before = statusCalls;
    const denied = coordinator(registry, `deny-${name}`, { ask: async (request) => {
      approvals++; assert.equal(request.tool, name); assert.equal(request.riskLevel, "medium"); return { approved: false };
    } });
    const code = name === "TaskStatus" ? "return await tools.TaskStatus({taskRunId:'fixture'});" : "return await tools.skill_lookup({query:'fixture'});";
    assert.equal((await denied.createCodeModeTool().execute(`deny-call-${name}`, { code })).isError, true);
    assert.equal(approvals, 1);
    assert.equal(statusCalls, before, "a denied status query cannot invoke its read callback");
    const approved = coordinator(registry, `approve-${name}`, { ask: async (request) => {
      assert.equal(request.riskLevel, "medium"); return { approved: true, scope: "once" };
    } });
    assert.equal((await approved.createCodeModeTool().execute(`approve-call-${name}`, { code })).isError, false);
  }

  const limited = coordinator(registry, "query-budget", { budget: { maxToolCalls: 1, maxRepeatedActions: 8 } });
  const beforeBudget = statusCalls;
  assert.equal((await limited.createCodeModeTool().execute("query-budget-cell", { code:
    "await tools.TaskStatus({taskRunId:'fixture'}); return await tools.TaskStatus({taskRunId:'fixture'});" })).isError, true);
  assert.equal(statusCalls, beforeBudget + 1);
  assert.equal(limited.getBudgetRejection()?.reason, "tool_call_limit");
  const repeated = coordinator(registry, "query-repeat", { budget: { maxToolCalls: 8, maxRepeatedActions: 1 } });
  const beforeRepeat = statusCalls;
  assert.equal((await repeated.createCodeModeTool().execute("query-repeat-cell", { code:
    "await tools.TaskStatus({taskRunId:'fixture'}); return await tools.TaskStatus({taskRunId:'fixture'});" })).isError, true);
  assert.equal(statusCalls, beforeRepeat + 1);
  assert.equal(repeated.getBudgetRejection()?.reason, "repeated_action_limit");
  const preCancelled = new AbortController(); preCancelled.abort();
  const beforeCancel = statusCalls;
  assert.equal((await exec.execute("query-pre-cancel", { code: "return await tools.TaskStatus({taskRunId:'fixture'});" }, preCancelled.signal)).isError, true);
  assert.equal(statusCalls, beforeCancel);

  // Approval may finish after removal/re-registration, including the same Tool object.
  const revokedRegistry = makeRegistry();
  const entered = deferred(); const approve = deferred<{ approved: boolean; scope: "once" }>();
  const revoked = coordinator(revokedRegistry, "query-revoked", { ask: async () => { entered.resolve(); return await approve.promise; } });
  const beforeRevocation = statusCalls;
  const pending = revoked.createCodeModeTool().execute("query-revoked-cell", { code: "return await tools.TaskStatus({taskRunId:'fixture'});" });
  await entered.promise;
  const original = revokedRegistry.get("TaskStatus");
  revokedRegistry.unregister("TaskStatus"); revokedRegistry.registerSubagentTool(original);
  approve.resolve({ approved: true, scope: "once" });
  const revokedResult = await pending;
  assert.equal(revokedResult.isError, true);
  assert.match(details(revokedResult).error ?? "", /no longer available/u);
  assert.equal(statusCalls, beforeRevocation);
  assert.doesNotMatch(revoked.createCodeModeTool().promptSnippet ?? "", /TaskStatus:/u);

  // Discovery caches and in-flight results are bound to exact host registrations.
  const discovery = makeRegistry();
  let searches = 0; const prompts: string[] = [];
  const searchTool = createToolSearchTool(() => discovery.listEntries(), () => model((prompt) => { searches++; prompts.push(prompt); }));
  discovery.registerBuiltinTool(searchTool);
  const searchCoordinator = coordinator(discovery, "query-discovery", { tools: new Set(["ToolSearch"]) });
  const search = searchCoordinator.createAgentTools().find((tool) => tool.name === "ToolSearch")!;
  assert.doesNotMatch(searchCoordinator.createCodeModeTool().promptSnippet ?? "", /TaskStatus:|skill_lookup:/u);
  const first = await search.execute("query-search-1", { query: "read local metadata or task status" });
  assert.deepEqual(toolSearchResultNames(first.details), [...selected]);
  assert.match(prompts[0] ?? "", /TaskStatus|skill_lookup/u);
  assert.doesNotMatch(prompts[0] ?? "", /"name":"(?:Skill|read_skill_resource|BashOutput|Task)"/u);
  await search.execute("query-search-cached", { query: "read local metadata or task status" });
  assert.equal(searches, 1);
  assert.deepEqual(searchCoordinator.allowTools(toolSearchResultNames(first.details)), [...selected]);
  assert.match(searchCoordinator.createCodeModeTool().promptSnippet ?? "", /TaskStatus:|skill_lookup:/u);
  const lookup = discovery.get("skill_lookup");
  discovery.unregister("skill_lookup"); discovery.registerUserTool(lookup);
  assert.deepEqual(toolSearchResultNames((await search.execute("query-search-revoked", { query: "read local metadata or task status" })).details), ["TaskStatus"]);
  assert.equal(searches, 2, "same serialized metadata cannot reuse the previous authority catalog");
  discovery.unregister("skill_lookup"); discovery.registerHostReadQuery(lookup, "skill_lookup");
  assert.deepEqual(toolSearchResultNames((await search.execute("query-search-reowned", { query: "read local metadata or task status" })).details), [...selected]);
  assert.equal(searches, 3);
  const resumed = coordinator(discovery, "query-discovery-resume", { tools: new Set(["ToolSearch"]) });
  const restored = toolSearchResultNamesFromMessages([{ role: "toolResult", toolCallId: "query-search-1", toolName: "ToolSearch", content: [], details: first.details }]);
  resumed.allowTools(restored);
  assert.match(resumed.createCodeModeTool().promptSnippet ?? "", /TaskStatus:|skill_lookup:/u);
  discovery.unregister("TaskStatus"); discovery.registerMcpTool(createTaskStatusTool(statusOptions));
  assert.doesNotMatch(resumed.createCodeModeTool().promptSnippet ?? "", /TaskStatus:/u);

  const inFlightRegistry = makeRegistry(); const searchEntered = deferred(); const releaseSearch = deferred();
  const inFlightSearch = createToolSearchTool(() => inFlightRegistry.listEntries(), () => model(async () => {
    searchEntered.resolve(); await releaseSearch.promise;
  }));
  const resolved = await inFlightSearch.resolveExecution({ query: "task and skill reads" });
  assert.ok(!("isError" in resolved));
  const stale = resolved.execute({ toolCallId: "in-flight", operationId: "in-flight", toolDiscoveryMode: "code_mode" });
  await searchEntered.promise;
  for (const name of selected) {
    const tool = inFlightRegistry.get(name); inFlightRegistry.unregister(name);
    inFlightRegistry.registerHostReadQuery(tool, name as "TaskStatus" | "skill_lookup");
  }
  releaseSearch.resolve();
  assert.deepEqual(toolSearchResultNames(await stale), [], "late discovery cannot revive removed registration identities");

  // The main model receives discovered host queries only on the next step.
  const flowRegistry = makeRegistry();
  flowRegistry.registerBuiltinTool(createToolSearchTool(() => flowRegistry.listEntries(), () => model(() => undefined)));
  let steps = 0;
  const flow = new AgentSession({ workspaceRoot: root, config, toolRegistry: flowRegistry,
    permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(root, "host-query-agent-discovery"),
    selectCapabilities: async () => ({ tools: ["ToolSearch"], skills: "none" }),
    model: { provider: "fixture", modelId: "host-query-main-flow", supportsTools: true, async stream(context) {
      steps++;
      assert.deepEqual(context.tools.map((tool) => tool.name).sort(), ["ToolSearch", "exec"]);
      const catalog = context.tools.find((tool) => tool.name === "exec")?.promptSnippet ?? "";
      if (steps === 1) assert.doesNotMatch(catalog, /TaskStatus:|skill_lookup:/u);
      else assert.match(catalog, /TaskStatus:|skill_lookup:/u);
      assert.doesNotMatch(catalog, /Skill:|read_skill_resource:|BashOutput:|Task:/u);
      const events: ModelStreamEvent[] = steps === 1
        ? [{ type: "tool-call", id: "flow-query-search", name: "ToolSearch", arguments: { query: "task status and installed skill metadata" } }, { type: "finish", reason: "tool-calls" }]
        : steps === 2 ? [{ type: "tool-call", id: "flow-query-exec", name: "exec", arguments: { code:
          "const s = await tools.TaskStatus({taskRunId:'fixture'}); const k = await tools.skill_lookup({query:'query-fixture'}); return {status:s.status,found:k.found};" } }, { type: "finish", reason: "tool-calls" }]
          : [{ type: "text-delta", text: "queries complete" }, { type: "finish", reason: "stop" }];
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield* events; })();
    } }
  });
  try {
    await flow.initialize();
    assert.equal((await flow.runTask("Find read-only status and skill queries", { emotionAnalysis: false })).status, "completed");
    assert.equal(steps, 3);
  } finally { await flow.close(); }

  // In-flight non-cooperative status reads retain quarantine and no-replay behavior.
  const stalledRegistry = new ToolRegistry(); const statusEntered = deferred(); const releaseStatus = deferred();
  let stalledCalls = 0;
  stalledRegistry.registerHostReadQuery(createTaskStatusTool({ ...statusOptions, readTaskResult: async () => {
    stalledCalls++; statusEntered.resolve(); await releaseStatus.promise; return { status: "running" };
  } }), "TaskStatus");
  const stalled = coordinator(stalledRegistry, "query-stalled");
  const stalledExec = stalled.createCodeModeTool(undefined, { ...codeModePolicy, hostCallTimeoutMs: 100, maxCellDurationMs: 2_000 });
  const stalledCell = stalledExec.execute("query-stalled-cell", { code: "return await tools.TaskStatus({taskRunId:'fixture'});" });
  await statusEntered.promise;
  const stalledResult = await stalledCell;
  assert.equal(stalledResult.isError, true);
  assert.match(details(stalledResult).error ?? "", /unknown|deadline/u);
  assert.equal((await stalledExec.execute("query-stalled-replay", { code: "return await tools.TaskStatus({taskRunId:'fixture'});" })).isError, true);
  assert.equal(stalledCalls, 1);
  releaseStatus.resolve(); await stalled.waitForIdle();

  // Explicit selection none is honored by the actual model-facing AgentSession.
  const noToolsAgent = new AgentSession({ workspaceRoot: root, config,
    model: { provider: "fixture", modelId: "host-query-no-tools", async stream(context) {
      assert.deepEqual(context.tools, []);
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "none" }; yield { type: "finish", reason: "stop" }; })();
    } }, toolRegistry: registry, permissionManager: new PermissionManager(config.permission),
    recorder: new SessionRecorder(root, "host-query-agent-none"), selectCapabilities: async () => ({ tools: "none", skills: "none" }) });
  try { await noToolsAgent.initialize(); assert.equal((await noToolsAgent.runTask("Just answer", { emotionAnalysis: false })).status, "completed"); }
  finally { await noToolsAgent.close(); }
} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

console.log("code mode host query tests passed");
