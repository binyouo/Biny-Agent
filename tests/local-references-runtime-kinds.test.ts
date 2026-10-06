/** Runtime 引用保留公开身份与工具定义，不复制执行参数或私有 payload。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { LocalReferenceService } from "../src/session/localReferences.js";
import { runtimeReferenceEntries } from "../src/session/runtimeReferenceEntries.js";

const entries = runtimeReferenceEntries({
  tasks: { tasks: [{ taskRunId: "task-1", status: "running", task: { secret: "SECRET_PAYLOAD" } }] },
  automations: [{ automationId: "cron-1", name: "明日提醒", status: "active", triggerType: "once", schedule: { at: "2026-10-03T08:00:00Z" } }],
  graphs: [{ graphId: "graph-1", status: "running", payload: { secret: "SECRET_PAYLOAD" } }]
}, [{ name: "Read", description: "读文件", source: "builtin" }]);
assert.deepEqual(entries.map((item) => item.kind), ["task", "cron", "plan", "tool"]);
assert.doesNotMatch(JSON.stringify(entries), /SECRET_PAYLOAD/u);

const definition = {
  name: "mcp_records_list", description: "Read records with token=OPAQUE_DESCRIPTION_KEY", source: "mcp", risk: "read", exposure: "deferred",
  namespace: { name: "records", description: "Stored records", instructions: "PRIVATE_NAMESPACE_INSTRUCTIONS" },
  parameters: { type: "object", properties: {
    apiKey: { type: "string", description: "Credential field", default: "OPAQUE_DEFAULT_KEY", examples: ["OPAQUE_EXAMPLE_KEY"] },
    limit: { type: "integer", default: 2, enum: [1, 2, 3] }
  }, required: ["apiKey"], additionalProperties: false },
  outputSchema: { type: "object", properties: { token: { type: "string", const: "OPAQUE_OUTPUT_KEY" } } },
  args: { apiKey: "EXECUTION_ARGUMENT_KEY" }, payload: { secret: "SECRET_PAYLOAD" }
};
const definitions = runtimeReferenceEntries({}, [definition, { ...definition, name: "mcp_records_hidden", exposure: "hidden" }]);
assert.equal(definitions.length, 1, "Hidden tools must not enter the local runtime reference catalog");
const content = definitions[0]?.content;
assert.ok(content?.startsWith("{"), "Tool references must return structured catalog metadata and schema definitions");
assert.deepEqual(JSON.parse(content), {
  name: "mcp_records_list", description: "Read records with token=[redacted]", source: "mcp", risk: "read", exposure: "deferred",
  namespace: { name: "records", description: "Stored records" },
  inputSchema: { type: "object", properties: {
    apiKey: { type: "string", description: "Credential field", default: "[redacted]", examples: ["[redacted]"] },
    limit: { type: "integer", default: 2, enum: [1, 2, 3] }
  }, required: ["apiKey"], additionalProperties: false },
  outputSchema: { type: "object", properties: { token: { type: "string", const: "[redacted]" } } }
});
assert.doesNotMatch(content, /OPAQUE_|EXECUTION_ARGUMENT_KEY|SECRET_PAYLOAD|PRIVATE_NAMESPACE_INSTRUCTIONS/u);
assert.equal(definition.parameters.properties.apiKey.default, "OPAQUE_DEFAULT_KEY", "The projection must not mutate registered definitions");
const builtin = runtimeReferenceEntries({}, [{ name: "Read", source: "builtin", parameters: { type: "object" } }]);
assert.equal(JSON.parse(builtin[0]!.content).exposure, "direct");

const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-reference-schema-"));
try {
  const service = new LocalReferenceService({ root, projects: [{ id: "p1", name: "Project", path: root }],
    loadConfig: async () => defaultConfig, runtimeEntries: async () => definitions });
  assert.equal((await service.search("records", "p1", "tool"))[0]?.uri, "biny://tool/mcp_records_list");
  const resolved = await service.resolve("biny://tool/mcp_records_list", "p1");
  assert.equal(JSON.parse(resolved.content).inputSchema.properties.apiKey.type, "string");
  assert.equal(JSON.parse(JSON.stringify(resolved)).content, content, "Text and JSON CLI projections share the same structured definition");
  await assert.rejects(service.resolve("biny://tool/mcp_records_hidden", "p1"), /not available/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("local reference runtime kind tests passed");
