/** An empty eligible inventory has a deterministic no-match result. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool, type ToolSearchArgs, type ToolSearchResult } from "../src/tools/toolSearch.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

const candidate = (name: string, exposure: Tool["exposure"] = "direct"): Tool => ({
  name, exposure, description: `Inspect ${name}`, risk: "read",
  parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
  namespace: { name: "known" },
  resolveExecution: () => ({ approvalRule: name, async execute() { return {}; } })
});
const cases: Array<{ name: string; args?: Partial<ToolSearchArgs>; setup?: (registry: ToolRegistry) => void; context?: Partial<ToolExecutionContext> }> = [
  { name: "empty-registry" },
  { name: "empty-source-filter", args: { type: "plugin" }, setup: (registry) => registry.registerBuiltinTool(candidate("local_inspection")) },
  { name: "empty-visible-filter", setup: (registry) => registry.registerMcpTool(candidate("hidden_inspection", "hidden")) },
  { name: "empty-host-scope", setup: (registry) => registry.registerMcpTool(candidate("remote_inspection", "deferred")), context: { toolDiscoveryNames: new Set() } },
  { name: "empty-namespace", setup: (registry) => registry.registerMcpTool(candidate("remote_inspection", "deferred")), context: { toolDiscoveryNames: new Set(["remote_inspection"]), toolDiscoveryNamespace: "missing" } },
  { name: "completed-discovery-empty", args: { type: "mcp" }, context: { prepareToolDiscovery: async () => ({ pending: [], timedOut: false }) } }
];
const failures: unknown[] = [];
for (const scenario of cases) {
  const registry = new ToolRegistry();
  scenario.setup?.(registry);
  let modelLookups = 0;
  const search = createToolSearchTool(() => registry.listEntries(), () => { modelLookups++; return []; });
  registry.registerBuiltinTool(search);
  const args = search.schema.parse({ query: "inspect task records", maxResults: 1, ...scenario.args });
  const execution = await search.resolveExecution(args);
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ toolCallId: scenario.name, operationId: scenario.name, ...scenario.context });
  console.log(scenario.name, JSON.stringify({ status: result.status, code: result.code, found: result.found, modelLookups }));
  try {
    assert.deepEqual(result, { status: "completed", query: args.query, found: 0, tools: [] }, scenario.name);
    assert.equal(modelLookups, 0, "No semantic selector is needed when the eligible inventory is empty.");
  } catch (error) { failures.push(error); }
}

const registry = new ToolRegistry();
let modelLookups = 0;
const search = createToolSearchTool(() => registry.listEntries(), () => { modelLookups++; return []; });
registry.registerBuiltinTool(search);
const execute = async (id: string, context: Partial<ToolExecutionContext> = {}, query = "inspect task records"): Promise<ToolSearchResult> => {
  const execution = await search.resolveExecution({ query, type: "mcp" });
  assert.ok(!("isError" in execution));
  return execution.execute({ toolCallId: id, operationId: id, ...context });
};
const timedOut = await execute("pending-discovery", { prepareToolDiscovery: async () => ({ pending: ["remote"], timedOut: true }) });
assert.equal(timedOut.status, "failed");
assert.equal(timedOut.code, "mcp_discovery_timeout");
assert.equal(timedOut.retryable, true);
assert.equal(modelLookups, 0, "Incomplete discovery must keep its existing retryable timeout.");

const failure = new Error("Discovery failed before catalog refresh.");
await assert.rejects(execute("failed-discovery", { prepareToolDiscovery: async () => { throw failure; } }), (error) => error === failure);
assert.equal(modelLookups, 0, "Discovery failures must never become an empty completed result.");

const controller = new AbortController();
controller.abort();
await assert.rejects(execute("cancelled", { signal: controller.signal }), { name: "AbortError" });
const duringDiscovery = new AbortController();
await assert.rejects(execute("cancelled-during-discovery", { signal: duringDiscovery.signal, prepareToolDiscovery: async () => {
  duringDiscovery.abort();
  return { pending: [], timedOut: false };
} }), { name: "AbortError" });

const prepared = await execute("prepared-explicit", { prepareToolDiscovery: async () => {
  registry.registerMcpTool(candidate("remote_inspection", "deferred"));
  return { pending: [], timedOut: false };
} }, "remote_inspection");
assert.deepEqual(prepared.tools.map(({ name }) => name), ["remote_inspection"]);
assert.equal(modelLookups, 0, "Discovery must finish before testing whether the eligible inventory is empty.");

registry.unregister("remote_inspection");
registry.registerMcpTool(candidate("remote_inspection", "deferred"));
const unavailable = await execute("populated-no-model");
assert.equal(unavailable.status, "failed");
assert.equal(unavailable.code, "tool_search_model_unavailable");
assert.equal(modelLookups, 1, "A nonempty semantic inventory still requires a configured selector.");

await testConfiguredSelector();
await testCodeModeWrapper();

async function testConfiguredSelector(): Promise<void> {
  const registry = new ToolRegistry();
  registry.registerMcpTool(candidate("remote_inspection", "deferred"));
  let modelLookups = 0;
  let modelCalls = 0;
  let text = JSON.stringify({ tools: ["remote_inspection"] });
  const model: AgentModel = {
    provider: "fixture", modelId: "empty-catalog-selector",
    async stream() {
      modelCalls++;
      return (async function* () {
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const search = createToolSearchTool(() => registry.listEntries(), () => {
    modelLookups++;
    return [{ model, failureDomain: "empty-catalog-fixture" }];
  });
  const execution = await search.resolveExecution({ query: "inspect task records" });
  assert.ok(!("isError" in execution));
  const context = { toolCallId: "configured-empty", operationId: "configured-empty", toolDiscoveryNames: new Set<string>() };
  try {
    assert.deepEqual(await execution.execute(context), { status: "completed", query: "inspect task records", found: 0, tools: [] });
    assert.equal(modelLookups, 0);
    assert.equal(modelCalls, 0, "Empty eligible catalogs never dispatch the configured selector.");
  } catch (error) { failures.push(error); }
  const callsBeforePopulated = modelCalls;
  const populated = await execution.execute({ ...context, toolDiscoveryNames: undefined });
  assert.equal(populated.status, "completed");
  assert.deepEqual(populated.tools.map(({ name }) => name), ["remote_inspection"]);
  assert.equal(modelCalls, callsBeforePopulated + 1, "A populated semantic inventory still dispatches its selector.");

  text = "not JSON";
  const invalidExecution = await search.resolveExecution({ query: "inspect a different task record" });
  assert.ok(!("isError" in invalidExecution));
  const invalid = await invalidExecution.execute({ ...context, toolDiscoveryNames: undefined });
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.code, "tool_search_invalid_response");
  assert.equal(invalid.retryable, true);
  assert.equal(modelCalls, callsBeforePopulated + 2, "Nonempty catalogs retain ordinary selector error classification.");
}

async function testCodeModeWrapper(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-search-empty-wrapper-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "empty-catalog-wrapper");
  try {
    const registry = new ToolRegistry();
    registry.registerMcpTool(candidate("remote_inspection", "deferred"));
    let modelLookups = 0;
    registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries(), () => { modelLookups++; return []; }));
    const config = structuredClone(defaultConfig);
    config.agent.toolExecutionMode = "code_mode";
    config.permission.mode = "full-access";
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
      new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["ToolSearch"]));
    const result = await coordinator.createCodeModeTool().execute("empty-namespace-cell", {
      code: "const hits = await searchTools('inspect task records', {namespace:'missing'}); return {hits, continued:true};"
    });
    try {
      assert.equal(result.isError, false, JSON.stringify(result.details));
      assert.deepEqual((result.details as { value: unknown }).value, { hits: [], continued: true }, "A deterministic no-match must not poison the Code Mode cell.");
      assert.equal(modelLookups, 0);
    } catch (error) { failures.push(error); }
    await coordinator.waitForIdle();
  } finally {
    await recorder.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

if (failures.length) throw new AggregateError(failures, "Empty eligible ToolSearch catalogs must complete without a model.");
console.log("tool search empty catalog tests passed");
