import assert from "node:assert/strict";
import test from "node:test";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { requestFingerprints } from "../src/agent/context/requestAnchor.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentContext, AgentModel, AgentTool, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";

// Normal CI only: actual loop and ContextMemory, with an injected model stream.
// The workspace object is never initialized; no model network or workspace I/O.
test("schema changes use estimates until a new completed request replaces the usage anchor", async () => {
  const requests: ModelStreamContext[] = [];
  const observed: ModelStreamContext[] = [];
  const tools: AgentTool[] = [
    { name: "Discover", description: "Discover one registered tool", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "Read is available" }], isError: false }) },
    { name: "Read", description: "Read a fixture value", parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("Read must not execute in this fixture"); } }
  ];
  const model: AgentModel = {
    provider: "fixture", modelId: "fixture",
    stream: async (context) => {
      const request = { ...context, messages: structuredClone(context.messages), tools: [...context.tools] };
      requests.push(request);
      const first = requests.length === 1;
      assert.deepEqual(context.tools.map(tool => tool.name), first ? ["Discover"] : ["Discover", "Read"]);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (first) yield { type: "tool-call", id: "discover-1", name: "Discover", arguments: {} };
        else yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: first ? "tool-calls" : "stop", usage: { inputTokens: first ? 1_600 : 123 } };
      })();
    }
  };
  const memory = new ContextMemory(() => model, new WorkspaceContext("/inert/anchor-fixture", [], 32_768),
    undefined, 2_000, 32_768, undefined, undefined, { reserveTokens: 500 });
  let current: AgentContext = { systemPrompt: "stable system", messages: [{ role: "user", content: "discover a reader" }], tools: [tools[0]!] };
  memory.recordToolSchema(current.tools);
  let changedSchemaChecks = 0;
  let firstFixed: string | undefined;
  for await (const event of vercelAgentLoopContinue(current, {
    model, tools: current.tools, maxSteps: 2,
    transformContext: async messages => {
      const candidate = { ...current, messages };
      if (current.tools.length === 2) {
        changedSchemaChecks++;
        assert.equal(memory.snapshot().usageAnchor?.fixedFingerprint, firstFixed, "schema change must not erase the measured anchor");
        assert.equal(memory.shouldCompactRunContext(candidate), false, "changed schemas must use the small actual estimate");
        assert.equal(memory.shouldCompactRunContext({ ...candidate, tools: [tools[0]!] }), true,
          "control: the same old schema still uses 1600 measured tokens above the 1500 threshold");
      }
      return messages;
    },
    onRequestContext: context => {
      observed.push({ ...context, messages: structuredClone(context.messages), tools: [...context.tools] });
      memory.recordRequest({ ...context, toolSources: new Map() });
      if (observed.length === 2) assert.equal(memory.snapshot().usageAnchor?.fixedFingerprint, firstFixed,
        "recordRequest changes pendingRequest only until new usage is available");
    },
    prepareNextTurn: async ({ context, toolResults }) => {
      assert.equal(toolResults[0]?.toolName, "Discover");
      assert.equal(toolResults[0]?.isError, false);
      current = { ...context, tools: [...tools] };
      memory.recordToolSchema(current.tools);
      return { context: current, tools: current.tools };
    }
  })) {
    assert.notEqual(event.type, "error", "the ordinary two-step request must not fail");
    if (event.type === "turn_end") {
      memory.recordProviderUsage(event.message.usage ?? {});
      if (requests.length === 1) firstFixed = memory.snapshot().usageAnchor?.fixedFingerprint;
    }
  }
  assert.equal(requests.length, 2);
  assert.equal(observed.length, 2, "one complete producer sample for each actual request");
  assert.ok(changedSchemaChecks >= 1, "the changed-schema consumer was reached");
  assert.deepEqual(observed, requests, "recordRequest receives the exact post-transform request");
  const latest = requests[1]!;
  const expected = requestFingerprints(model, latest);
  const saved = memory.snapshot().usageAnchor;
  assert.ok(saved);
  assert.equal(saved.fixedFingerprint, expected.fixedFingerprint);
  assert.deepEqual(saved.messageFingerprints, expected.messageFingerprints, "new anchor retains every request message");
  assert.notEqual(saved.fixedFingerprint, firstFixed);
  assert.equal(saved.inputTokens, 123);
  assert.equal(memory.getBudget().usedTokens, 123, "latest provider usage replaces the previous estimate");
});
