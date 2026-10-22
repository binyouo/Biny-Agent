import { testModel } from "./helpers/model.js";
/** A nonempty invalid selector answer must not poison the semantic no-match cache. */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool, type ToolSearchResult } from "../src/tools/toolSearch.js";
import type { Tool } from "../src/tools/types.js";

const query = "find the relevant records";

for (const [name, answer] of [
  ["unknown-only", '{"tools":["missing_tool"]}'],
  ["wrong-case-only", '{"tools":["Candidate"]}'],
  ["whitespace-only", '{"tools":[" "]}']
] as const) {
  await test(`invalid ${name} selections are retryable and do not enter the cache`, async () => {
    const fixture = createFixture(answer);
    const invalid = await fixture.execute();
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.code, "tool_search_invalid_response");
    assert.equal(invalid.retryable, true);
    assert.equal(invalid.found, 0);
    assert.deepEqual(invalid.tools, []);
    fixture.setAnswer('{"tools":["candidate"]}');
    const recovered = await fixture.execute();
    assert.equal(recovered.status, "completed");
    assert.deepEqual(recovered.tools.map((tool) => tool.name), ["candidate"]);
    assert.equal(fixture.calls(), 2, "The same query must ask the corrected selector again.");
    const cached = await fixture.execute();
    assert.deepEqual(cached.tools.map((tool) => tool.name), ["candidate"]);
    assert.equal(fixture.calls(), 2, "A later valid selection remains cacheable.");
    assert.equal(fixture.executions(), 0, "Discovery must not invoke the selected tool.");
  });
}

await test("an explicit empty selection remains a cacheable no-match", async () => {
  const fixture = createFixture('{"tools":[]}');
  const empty = await fixture.execute();
  assert.equal(empty.status, "completed");
  assert.equal(empty.found, 0);
  assert.deepEqual(empty.tools, []);
  fixture.setAnswer('{"tools":["candidate"]}');
  const cached = await fixture.execute();
  assert.equal(cached.status, "completed");
  assert.equal(cached.found, 0);
  assert.deepEqual(cached.tools, []);
  assert.equal(fixture.calls(), 1, "A legitimate no-match still uses the existing cache.");
  assert.equal(fixture.executions(), 0);
});

await test("mixed valid and invalid names retain the exact unique match and its cache", async () => {
  const fixture = createFixture('{"tools":["missing_tool","Candidate","candidate","candidate"]}');
  const selected = await fixture.execute();
  assert.equal(selected.status, "completed");
  assert.equal(selected.found, 1);
  assert.deepEqual(selected.tools.map((tool) => tool.name), ["candidate"]);
  fixture.setAnswer('{"tools":[]}');
  const cached = await fixture.execute();
  assert.deepEqual(cached.tools.map((tool) => tool.name), ["candidate"]);
  assert.equal(fixture.calls(), 1);
  assert.equal(fixture.executions(), 0);
});

await test("exact query names still resolve locally and case variants do not become aliases", async () => {
  const fixture = createFixture("not JSON");
  const exact = await fixture.execute("candidate");
  assert.equal(exact.status, "completed");
  assert.deepEqual(exact.tools.map((tool) => tool.name), ["candidate"]);
  assert.equal(fixture.calls(), 0, "An exact registered query bypasses the selector.");
  const differentCase = await fixture.execute("Candidate");
  assert.equal(differentCase.status, "failed");
  assert.equal(differentCase.code, "tool_search_invalid_response");
  assert.equal(fixture.calls(), 1, "A case variant must still take the semantic path.");
  assert.equal(fixture.executions(), 0);
});

for (const change of ["remove", "replace"] as const) {
  await test(`a valid snapshot answer stays completed when its registration is ${change}d while waiting`, async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let wait = true;
    const fixture = createFixture('{"tools":["candidate"]}', async () => {
      if (!wait) return;
      enter();
      await gate;
    });
    const pending = fixture.execute();
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("Search settled before entering the selector."); })]);
      fixture.registry.unregister("candidate");
      if (change === "replace") fixture.registry.registerBuiltinTool(fixture.candidate);
      wait = false;
      release();
      const stale = await pending;
      assert.equal(stale.status, "completed", "The answer was valid in the selector's original snapshot.");
      assert.equal(stale.code, undefined);
      assert.equal(stale.found, 0);
      assert.deepEqual(stale.tools, [], "Removed or replacement registrations cannot inherit the old result.");
      assert.equal(fixture.calls(), 1);
      if (change === "remove") fixture.registry.registerBuiltinTool(fixture.candidate);
      const refreshed = await fixture.execute();
      assert.equal(refreshed.status, "completed");
      assert.deepEqual(refreshed.tools.map((tool) => tool.name), ["candidate"]);
      assert.equal(fixture.calls(), 2, "A fresh registration identity invalidates the old cache entry.");
      assert.equal(fixture.executions(), 0);
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  });
}

function createFixture(initialAnswer: string, beforeResponse?: () => Promise<void>) {
  let answer = initialAnswer;
  let modelCalls = 0;
  let toolExecutions = 0;
  const registry = new ToolRegistry();
  const candidate: Tool = {
    name: "candidate", description: "Read task records", risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    resolveExecution: () => ({
      approvalRule: "candidate",
      async execute() { toolExecutions++; return {}; }
    })
  };
  registry.registerBuiltinTool(candidate);
  const model: AgentModel = testModel({
    provider: "fixture", modelId: "invalid-selection",
    async stream() {
      modelCalls++;
      const response = answer;
      await beforeResponse?.();
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: response };
        yield { type: "finish", reason: "stop" };
      })();
    }
  });
  const search = createToolSearchTool(() => registry.listEntries(), () => [{ model, failureDomain: "invalid-selection-fixture" }]);
  registry.registerBuiltinTool(search);
  let sequence = 0;
  return {
    registry, candidate,
    setAnswer(value: string) { answer = value; },
    calls: () => modelCalls,
    executions: () => toolExecutions,
    async execute(searchQuery = query): Promise<ToolSearchResult> {
      const execution = await search.resolveExecution(search.schema.parse({ query: searchQuery }));
      assert.ok(!("isError" in execution));
      const id = `invalid-selection-${String(++sequence)}`;
      return execution.execute({ toolCallId: id, operationId: id });
    }
  };
}
