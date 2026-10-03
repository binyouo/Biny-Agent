/** Hardened file queries gain authority only through the exact host assembly route. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { codeModePolicy } from "../src/agent/codeMode.js";
import { defaultConfig } from "../src/config/schema.js";
import { createSkillResourceTool, loadSkills } from "../src/extensions/skills.js";
import { PermissionManager, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { bindManagedProcessLog, readManagedProcessLog } from "../src/runtime/managedProcessLog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createBashOutputTool } from "../src/tools/process/managedProcesses.js";
import { isCodeModeReadTool, ToolRegistry, type HostReadQuery } from "../src/tools/registry.js";
import { createToolSearchTool, toolSearchResultNames } from "../src/tools/toolSearch.js";
import type { ToolSource } from "../src/tools/types.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-file-queries-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
await ensureAgentDirs(root);
const skillDir = path.join(root, "skills", "file-query-fixture");
await mkdir(skillDir, { recursive: true });
await mkdir(path.join(root, "global"));
await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: file-query-fixture\ndescription: File query fixture\n---\nNever activate this fixture\n");
const resource = path.join(skillDir, "reference.txt");
await writeFile(resource, "temporary query resource");
const bundle = await loadSkills({ workspaceRoot: root, projectPaths: ["skills"], globalRoot: path.join(root, "global") });
const selected = new Set(["BashOutput", "read_skill_resource"]);
const recorders: SessionRecorder[] = [];
let listReads = 0;
const service = new ManagedProcessService({ workspaceRoot: root });
service.list = async () => { listReads++; return []; };
const processId = "00000000-0000-4000-8000-000000000002";
const logPath = path.join(root, "managed-fixture.log");
const logFile = await open(logPath, "wx+");
await logFile.writeFile("temporary managed log fixture");
const logBinding = await bindManagedProcessLog(logPath, logFile);
await logFile.close();
let logReads = 0;
service.outputPath = () => logPath;
service.status = async () => ({ processId, pid: 1, command: "fixture-never-launched", cwd: root, state: "exited", logPath,
  startedAt: "2026-10-02T00:00:00Z", cleanup: { status: "not_needed" } });
service.readOutput = async (id, options, signal) => { logReads++; return { processId: id, ...await readManagedProcessLog(logBinding, options, signal) }; };
const factory = (name: string) => name === "BashOutput" ? createBashOutputTool(service) : createSkillResourceTool(bundle);
function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of selected) registry.registerHostReadQuery(factory(name), name as HostReadQuery);
  return registry;
}
class AskFiles extends PermissionManager {
  override evaluate(request: PermissionRequestContext) {
    const result = super.evaluate(request);
    return result.decision === "deny" ? result : { decision: "ask" as const, reason: "Approve this exact local fixture read." };
  }
}
function coordinator(registry: ToolRegistry, options?: { tools?: Set<string>; denyPaths?: string[];
  budget?: { maxToolCalls: number; maxRepeatedActions: number }; ask?: () => Promise<{ approved: boolean; scope: "once" }> }): ToolExecutionCoordinator {
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "code_mode";
  config.agent.maxConcurrentTools = 1;
  config.permission = { mode: "full-access", allowTools: [], allowPaths: [], denyPaths: options?.denyPaths ?? [], criticalAlwaysAsk: true };
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  const recorder = new SessionRecorder(root, `file-query-${String(recorders.length)}`);
  recorders.push(recorder);
  return new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, confirmPermission: options?.ask },
    options?.ask ? new AskFiles(config.permission) : new PermissionManager(config.permission), () => undefined, () => ({}), options?.tools ?? selected, options?.budget);
}
function details(result: AgentToolResult): { value?: unknown; childCalls?: unknown[]; error?: string } { return result.details as ReturnType<typeof details>; }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const resourceCode = "return await tools.read_skill_resource({skill:'file-query-fixture',path:'reference.txt'});";

try {
  for (const source of ["builtin", "skill", "subagent", "mcp", "plugin"] as ToolSource[]) {
    const registry = new ToolRegistry();
    for (const name of selected) registry.register(Object.assign(factory(name), { source, hostReadQuery: name, readOnlyHint: true, codeModeReadOnly: true }), source);
    assert.equal(registry.listEntries().some(isCodeModeReadTool), false, "source/name/hints cannot assert file-read authority");
    const exec = coordinator(registry).createCodeModeTool();
    assert.doesNotMatch(exec.promptSnippet ?? "", /BashOutput:|read_skill_resource:/u);
    const before = listReads;
    for (const code of [resourceCode, "return await tools.BashOutput({});"]) {
      const result = await exec.execute(`untrusted-${source}-${code}`, { code });
      assert.equal(result.isError, true);
      assert.deepEqual(details(result).childCalls, []);
    }
    assert.equal(listReads, before);
  }
  const registry = makeRegistry();
  assert.deepEqual(registry.listEntries().filter(isCodeModeReadTool).map((entry) => [entry.tool.name, entry.source]), [["BashOutput", "builtin"], ["read_skill_resource", "skill"]]);
  for (const entry of registry.listEntries()) assert.equal(isCodeModeReadTool({ ...entry }), false);
  for (const name of selected) {
    const changed = makeRegistry();
    changed.get(name).resolveExecution = () => ({ approvalRule: "altered", execute: async () => ({}) });
    assert.equal(changed.listEntries().some((entry) => entry.tool.name === name && isCodeModeReadTool(entry)), false);
    const changedParameters = makeRegistry(); changedParameters.get(name).parameters = { type: "object", properties: {} };
    assert.equal(changedParameters.listEntries().some((entry) => entry.tool.name === name && isCodeModeReadTool(entry)), false);
  }
  const main = coordinator(registry, { budget: { maxToolCalls: 8, maxRepeatedActions: 8 } });
  const mainRecorder = recorders.at(-1)!;
  const result = await main.createCodeModeTool().execute("file-query-happy", { code:
    "const resource = await tools.read_skill_resource({skill:'file-query-fixture',path:'reference.txt'}); const logs = await tools.BashOutput({}); return {content:resource.content,processes:logs.processes};" });
  assert.equal(result.isError, false, JSON.stringify(result.details));
  assert.deepEqual(details(result).value, { content: "temporary query resource", processes: [] });
  assert.equal(main.getExecutionBudgetSnapshot().accountedToolCalls, 2);
  const events = (await readFile(mainRecorder.filePath, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  for (const id of ["file-query-happy:nested:1", "file-query-happy:nested:2"]) {
    assert.equal(events.filter((event) => event.type === "tool_call" && event.toolCallId === id && event.auditOnly).length, 1);
    assert.equal(events.filter((event) => event.type === "tool_result" && event.toolCallId === id && event.operationId && event.auditOnly).length, 1);
  }
  assert.equal(replaySessionEvents(events, { sessionId: mainRecorder.sessionId }).messages.some((message) => message.role === "toolResult" && message.toolCallId.includes(":nested:")), false);
  const none = coordinator(registry, { tools: new Set() }).createCodeModeTool();
  assert.doesNotMatch(none.promptSnippet ?? "", /BashOutput:|read_skill_resource:/u);
  assert.deepEqual(details(await none.execute("no-file-selection", { code: resourceCode })).childCalls, []);
  const outputOnly = coordinator(registry, { tools: new Set(["BashOutput"]) }).createCodeModeTool();
  assert.match(outputOnly.promptSnippet ?? "", /BashOutput:/u);
  assert.doesNotMatch(outputOnly.promptSnippet ?? "", /read_skill_resource:/u);
  const denied = await coordinator(registry, { denyPaths: [resource] }).createCodeModeTool().execute("denied-resource", { code: resourceCode });
  assert.equal(denied.isError, true);
  assert.match(details(denied).error ?? "", /denied by project policy/u);
  const logCode = `return await tools.BashOutput({processId:${JSON.stringify(processId)},maxBytes:9});`;
  const deniedLog = await coordinator(registry, { denyPaths: [logPath] }).createCodeModeTool().execute("denied-log-page", { code: logCode });
  assert.equal(deniedLog.isError, true);
  assert.equal(logReads, 0);
  const allowedLog = await coordinator(registry).createCodeModeTool().execute("allowed-log-page", { code: logCode });
  assert.equal(allowedLog.isError, false);
  assert.equal((details(allowedLog).value as { output: { content: string; nextOffset: number } }).output.content, "temporary");
  assert.equal(logReads, 1);
  const budget = coordinator(registry, { budget: { maxToolCalls: 1, maxRepeatedActions: 8 } });
  const beforeBudget = listReads;
  assert.equal((await budget.createCodeModeTool().execute("file-budget", { code: `${resourceCode.replace("return ", "")} return await tools.BashOutput({});` })).isError, true);
  assert.equal(budget.getBudgetRejection()?.reason, "tool_call_limit");
  assert.equal(listReads, beforeBudget);
  const repeated = coordinator(registry, { budget: { maxToolCalls: 8, maxRepeatedActions: 1 } });
  assert.equal((await repeated.createCodeModeTool().execute("file-repeat", { code: "await tools.BashOutput({}); return await tools.BashOutput({});" })).isError, true);
  assert.equal(repeated.getBudgetRejection()?.reason, "repeated_action_limit");
  const cancelled = new AbortController(); cancelled.abort();
  const beforeCancel = listReads;
  assert.equal((await main.createCodeModeTool().execute("file-cancelled", { code: "return await tools.BashOutput({});" }, cancelled.signal)).isError, true);
  assert.equal(listReads, beforeCancel);

  for (const name of selected) {
    const revoked = makeRegistry(); const entered = deferred(); const release = deferred<{ approved: boolean; scope: "once" }>();
    const active = coordinator(revoked, { ask: async () => { entered.resolve(); return await release.promise; } });
    const pending = active.createCodeModeTool().execute(`revoked-${name}`, { code: name === "BashOutput" ? "return await tools.BashOutput({});" : resourceCode });
    await entered.promise;
    const old = revoked.get(name); revoked.unregister(name); revoked.register(old, name === "BashOutput" ? "builtin" : "skill");
    release.resolve({ approved: true, scope: "once" });
    assert.equal((await pending).isError, true);
    assert.doesNotMatch(active.createCodeModeTool().promptSnippet ?? "", new RegExp(`${name}:`, "u"));
  }
  const discovery = makeRegistry(); let searches = 0;
  discovery.registerBuiltinTool(createToolSearchTool(() => discovery.listEntries(), () => [{ model: { provider: "fixture", modelId: "file-query-selector", supportsTools: false,
    async stream() { searches++; return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: JSON.stringify({ tools: [...selected, "Bash", "Skill", "WebFetch", "KillShell"] }) }; yield { type: "finish", reason: "stop" };
    })(); }
  }, failureDomain: "file-query-fixture" }]));
  const discovered = coordinator(discovery, { tools: new Set(["ToolSearch"]) });
  const search = discovered.createAgentTools(undefined, { toolDiscoveryNames: new Set(discovery.list().map((tool) => tool.name)) }).find((tool) => tool.name === "ToolSearch")!;
  const first = await search.execute("file-search", { query: "read file resources and process output" });
  assert.deepEqual(toolSearchResultNames(first.details), [...selected]);
  discovered.allowTools(toolSearchResultNames(first.details));
  assert.match(discovered.createCodeModeTool().promptSnippet ?? "", /BashOutput:|read_skill_resource:/u);
  await search.execute("file-search-cached", { query: "read file resources and process output" }); assert.equal(searches, 1);
  const resourceTool = discovery.get("read_skill_resource"); discovery.unregister("read_skill_resource"); discovery.registerUserTool(resourceTool);
  assert.deepEqual(toolSearchResultNames((await search.execute("file-search-revoked", { query: "read file resources and process output" })).details), ["BashOutput"]);
  assert.equal(searches, 2);

  const stalledRegistry = makeRegistry(); const entered = deferred(); const release = deferred();
  const oldList = service.list; let stalledCalls = 0;
  service.list = async () => { stalledCalls++; entered.resolve(); await release.promise; return []; };
  try {
    const stalled = coordinator(stalledRegistry);
    const exec = stalled.createCodeModeTool(undefined, { ...codeModePolicy, hostCallTimeoutMs: 100, maxCellDurationMs: 2_000 });
    const pending = exec.execute("stalled-file-query", { code: "return await tools.BashOutput({});" });
    await entered.promise;
    assert.equal((await pending).isError, true);
    assert.equal((await exec.execute("stalled-file-replay", { code: "return await tools.BashOutput({});" })).isError, true);
    assert.equal(stalledCalls, 1);
    release.resolve(); await stalled.waitForIdle();
  } finally { service.list = oldList; release.resolve(); }
  assert.equal(await readFile(resource, "utf8"), "temporary query resource");
} finally {
  for (const recorder of recorders) await recorder.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("code mode file query tests passed");
