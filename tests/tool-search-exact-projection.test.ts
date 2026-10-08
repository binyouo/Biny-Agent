/** Exact discovery projects only returned descriptions, preserving redaction and name ordering. */
import assert from "node:assert/strict";
import { z } from "zod";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import type { RegisteredTool } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

const makeTool = (name: string, description: string): Tool => ({
  name, description, parameters: { type: "object" }, schema: z.object({}),
  resolveExecution: () => ({ approvalRule: name, async execute() { return {}; } })
});
const entries: RegisteredTool[] = Array.from({ length: 100 }, (_, index) => ({
  source: "mcp", tool: makeTool(`remote_${String(index)}`, "apiKey=fixture-secret; " + "Read records. ".repeat(40))
}));
const search = createToolSearchTool(() => entries, () => { throw new Error("Exact names must not consult a model."); });
const execution = await search.resolveExecution({ query: "remote_99 remote_1", maxResults: 1 });
assert.ok(!("isError" in execution));
const controlSearch = createToolSearchTool(() => [entries[99]!]);
const controlExecution = await controlSearch.resolveExecution({ query: "remote_99 remote_1", maxResults: 1 });
assert.ok(!("isError" in controlExecution));
const originalReplace = String.prototype.replace;
let replacements = 0;
String.prototype.replace = new Proxy(originalReplace, {
  apply(target, thisArg, args) {
    replacements += 1;
    return Reflect.apply(target, thisArg, args);
  }
});
let result;
let selectedDescriptionPasses;
try {
  const control = await controlExecution.execute({ toolCallId: "control", operationId: "control" });
  selectedDescriptionPasses = replacements;
  assert.equal(control.tools[0]?.description, ("apiKey=[redacted]; " + "Read records. ".repeat(40)).slice(0, 400));
  replacements = 0;
  result = await execution.execute({ toolCallId: "exact", operationId: "exact" });
} finally {
  String.prototype.replace = originalReplace;
}
assert.deepEqual(result.tools.map(({ name }) => name), ["remote_99"]);
assert.equal(result.tools[0]?.description, ("apiKey=[redacted]; " + "Read records. ".repeat(40)).slice(0, 400));
assert.match(result.tools[0]!.description, /apiKey=\[redacted\]/u);
assert.doesNotMatch(result.tools[0]!.description, /fixture-secret/u);
assert.equal(replacements, selectedDescriptionPasses, "Exact discovery redaction work must depend on returned descriptions, not catalog size.");

// Arbitrary getTools callbacks can contain duplicates; retain the existing last-registration winner.
entries.push({ source: "plugin", tool: makeTool("remote_99", "password=last-secret; last registration") });
const duplicate = await execution.execute({ toolCallId: "duplicate", operationId: "duplicate" });
assert.deepEqual(duplicate.tools, [{ name: "remote_99", description: "password=[redacted]; last registration", source: "plugin", capability: undefined }]);
entries.at(-1)!.tool.description = "token=changed-secret; changed description";
const changed = await execution.execute({ toolCallId: "changed", operationId: "changed" });
assert.equal(changed.tools[0]!.description, "token=[redacted]; changed description");
assert.equal(entries.at(-1)!.tool.description, "token=changed-secret; changed description", "Projection must not mutate metadata.");
entries.at(-1)!.tool.description = null as unknown as string;
await assert.rejects(execution.execute({ toolCallId: "invalid", operationId: "invalid" }), TypeError);
console.log("tool search exact projection tests passed");
