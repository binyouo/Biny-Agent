import assert from "node:assert/strict";
import { codeModeCatalog, codeModePolicy, executeCodeModeCell } from "../src/agent/codeMode.js";
import type { AgentTool } from "../src/agent/core/types.js";

let calls = 0;
const reports: AgentTool = {
  name: "mcp__reports__list",
  description: "Read issue reports",
  namespace: { name: "reports", description: "Issue reporting", instructions: "Use the project key." },
  parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false },
  outputSchema: { type: "object", properties: { reports: { type: "array", items: { type: "object" } } } },
  async execute(id, args) {
    calls++;
    return { content: [], details: { id, project: args.project, reports: [{ comments: 4 }, { comments: 12 }] } };
  }
};
const privateTool: AgentTool = {
  name: "mcp__private__write", description: "Private write operation",
  namespace: { name: "private" },
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() { throw new Error("The caller did not admit this tool."); }
};

const admitted = await executeCodeModeCell({
  code: "const rows = await tools.mcp__reports__list({project:'demo'}); return rows.reports.sort((a,b) => b.comments-a.comments)[0];",
  parentToolCallId: "admitted", tools: [], admittedTools: [reports], isCurrent: () => true
});
assert.equal(admitted.ok, true, admitted.error);
assert.deepEqual(admitted.value, { comments: 12 });
assert.deepEqual(admitted.childCalls, [{ tool: reports.name, toolCallId: "admitted:nested:1" }]);
assert.equal(calls, 1);

const searches: Array<{ query: string; names: string[]; limit: number; namespace?: string }> = [];
const discovered = await executeCodeModeCell({
  code: `const hits = await searchTools('查询项目报告', {limit:2, namespace:'reports'});
const description = await describeTool(hits[0].name);
const namespace = await describeNamespace('reports');
return {hits, description, namespace, inaccessible: await describeTool('mcp__private__write')};`,
  parentToolCallId: "discover", tools: [privateTool], admittedTools: [reports], isCurrent: () => true,
  async searchTools(query, options) {
    searches.push({ query, names: options.tools.map((entry) => entry.name), limit: options.limit, namespace: options.namespace });
    return [{ name: privateTool.name }, { name: reports.name }, { name: reports.name }];
  }
});
assert.equal(discovered.ok, true, discovered.error);
assert.deepEqual(searches, [{ query: "查询项目报告", names: [reports.name], limit: 2, namespace: "reports" }]);
assert.deepEqual(discovered.value, {
  hits: [{ name: reports.name, description: reports.description, namespace: "reports" }],
  description: { name: reports.name, description: reports.description, parameters: reports.parameters, outputSchema: reports.outputSchema, namespace: "reports" },
  namespace: { name: "reports", description: "Issue reporting", instructions: "Use the project key.", tools: [
    { name: reports.name, description: reports.description, parameters: reports.parameters, outputSchema: reports.outputSchema, namespace: "reports" }
  ] },
  inaccessible: null
});
assert.deepEqual(discovered.childCalls, []);
assert.equal(calls, 1, "discovery cannot execute an admitted tool");
assert.doesNotMatch(codeModeCatalog([reports]), /mcp__reports__list|project|Use the project/u, "the stable catalog does not publish MCP schemas");
assert.equal(codeModeCatalog([{ ...reports, name: "Read" }]), "Read: Read issue reports");

const revoked = await executeCodeModeCell({
  code: "return {tool: await describeTool('mcp__reports__list'), namespace: await describeNamespace('reports')};",
  parentToolCallId: "revoked", tools: [], admittedTools: [reports], isCurrent: () => false
});
assert.equal(revoked.ok, true, revoked.error);
assert.deepEqual(revoked.value, { tool: null, namespace: null });
const noSearch = await executeCodeModeCell({
  code: "return await searchTools('查询项目报告');",
  parentToolCallId: "no-search", tools: [], admittedTools: [reports], isCurrent: () => true
});
assert.equal(noSearch.ok, false);
assert.match(noSearch.error ?? "", /discovery|search|configured/iu);

const failedSearch = await executeCodeModeCell({
  code: "try { await searchTools('查询项目报告'); } catch {} return await tools.mcp__reports__list({project:'demo'});",
  parentToolCallId: "failed-search", tools: [], admittedTools: [reports], isCurrent: () => true,
  async searchTools() { throw new Error("Discovery unavailable"); }
});
assert.equal(failedSearch.ok, false);
assert.equal(calls, 1, "a caught host discovery failure cannot resume tool dispatch");

const capped = await executeCodeModeCell({
  code: "await describeTool('mcp__reports__list'); return await describeTool('mcp__reports__list');",
  parentToolCallId: "bounded-discovery", tools: [], admittedTools: [reports], isCurrent: () => true,
  executionPolicy: { ...codeModePolicy, maxBridgeRequests: 1 }
});
assert.equal(capped.ok, false);
assert.match(capped.error ?? "", /bridge|request|limit/iu);

let searchAborted = false;
const cancelled = await executeCodeModeCell({
  code: "return await searchTools('查询项目报告');",
  parentToolCallId: "cancel-discovery", tools: [], admittedTools: [reports], isCurrent: () => true,
  executionPolicy: { ...codeModePolicy, timeoutMs: 1_000, hostCallTimeoutMs: 1_000, maxCellDurationMs: 2_000 },
  async searchTools(_query, { signal }) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    searchAborted = true;
    signal.throwIfAborted();
    return [];
  }
});
assert.equal(cancelled.ok, false);
assert.equal(cancelled.outcomeUnknown, undefined);
assert.equal(searchAborted, true);

let prepared = 0;
const localRead: AgentTool = {
  name: "Read", description: "Read local data", parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { content: [], details: { local: true } }; }
};
const localOnly = await executeCodeModeCell({
  code: "return await tools.Read({});", parentToolCallId: "local-only", tools: [localRead], isCurrent: () => true,
  async prepareTools() { prepared++; throw new Error("The optional server is still connecting."); }
});
assert.equal(localOnly.ok, true, localOnly.error);
assert.deepEqual(localOnly.value, { local: true });
assert.equal(prepared, 0, "known local tools do not wait for optional servers");
const dynamicQueries: Array<string | undefined> = [];
const dynamic = await executeCodeModeCell({
  code: "const row = await tools.mcp__reports__list({project:'dynamic'}); return row.project;",
  parentToolCallId: "dynamic", tools: [localRead], isCurrent: () => true,
  async prepareTools(query) { dynamicQueries.push(query); return [localRead, reports]; }
});
assert.equal(dynamic.ok, true, dynamic.error);
assert.equal(dynamic.value, "dynamic");
assert.deepEqual(dynamicQueries, [reports.name]);
assert.deepEqual(dynamic.childCalls, [{ tool: reports.name, toolCallId: "dynamic:nested:1" }]);
const dynamicNamespace = await executeCodeModeCell({
  code: "const scope = await describeNamespace('reports'); const hits = await searchTools('查询项目报告'); return [scope.name,hits[0].name];",
  parentToolCallId: "dynamic-namespace", tools: [localRead], isCurrent: () => true,
  async prepareTools(query) { dynamicQueries.push(query); return [localRead, reports]; },
  async searchTools(_query, options) { assert.ok(options.tools.some((entry) => entry.name === reports.name)); return [{ name: reports.name }]; }
});
assert.equal(dynamicNamespace.ok, true, dynamicNamespace.error);
assert.deepEqual(dynamicNamespace.value, ["reports", reports.name]);
assert.deepEqual(dynamicQueries, [reports.name, "reports", "查询项目报告"]);

const failedPreparation = await executeCodeModeCell({
  code: "try { await tools.mcp__reports__list({project:'demo'}); } catch {} return await tools.Read({});",
  parentToolCallId: "failed-preparation", tools: [localRead], isCurrent: () => true,
  async prepareTools() { throw new Error("Discovery preparation timed out."); }
});
assert.equal(failedPreparation.ok, false);
assert.deepEqual(failedPreparation.childCalls, [], "caught readiness failure cannot dispatch another target");

const reservedBridge = await executeCodeModeCell({
  code: "try { await tools.__biny_code_mode_search({query:'read'}); } catch {} return await tools.Read({});",
  parentToolCallId: "reserved-bridge", tools: [localRead], isCurrent: () => true
});
assert.equal(reservedBridge.ok, false);
assert.deepEqual(reservedBridge.childCalls, [], "internal helpers cannot be invoked through the target dispatch bridge");

let preparationAborted = false;
const preparationTimeout = await executeCodeModeCell({
  code: "return await tools.mcp__reports__list({project:'demo'});",
  parentToolCallId: "preparation-timeout", tools: [], isCurrent: () => true,
  executionPolicy: { ...codeModePolicy, timeoutMs: 1_000, hostCallTimeoutMs: 1_000, maxCellDurationMs: 2_000 },
  async prepareTools(_query, signal) {
    assert.ok(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    preparationAborted = true;
    signal.throwIfAborted();
    return [];
  }
});
assert.equal(preparationTimeout.ok, false);
assert.equal(preparationTimeout.outcomeUnknown, undefined, "a cooperative connection wait drains after cell cancellation");
assert.deepEqual(preparationTimeout.childCalls, []);
assert.equal(preparationAborted, true);

console.log("code-mode discovery tests passed");
