import assert from "node:assert/strict";
import test from "node:test";
import { generateText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentMessage } from "../src/agent/core/types.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";

// Normal CI only: imports the real projection and SDK. The transport below is
// an injected fetch function; no real provider, credential or filesystem tool
// is contacted. This isolates historical projection, not the model-switch UI.
type Call = { id: string; name: string };
const patch: Call = { id: "patch-p", name: "apply_patch" };
const read: Call = { id: "read-r", name: "Read" };
const other: Call = { id: "read-q", name: "Read" };
const latestInput = "Continue with the exact latest instruction: KEEP-LATEST-USER.";

function argumentsFor(call: Call): Record<string, unknown> {
  return call.name === "apply_patch"
    ? { callId: call.id, operation: { type: "create_file", path: "example.txt", diff: "+PATCH-CONTENT\n" } }
    : { path: `${call.id}.txt` };
}

function history(calls: Call[], failedPatch = false): AgentMessage[] {
  return [
    { role: "user", content: "Edit one file and inspect the other files." },
    { role: "assistant", content: [
      { type: "text", text: "ORIGINAL-ASSISTANT-TEXT" },
      ...calls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: argumentsFor(call) }))
    ] },
    ...calls.map((call): AgentMessage => ({
      role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: `RESULT-${call.id}` }],
      isError: call.name === "apply_patch" && failedPatch
    })),
    { role: "assistant", content: [{ type: "text", text: "ORIGINAL-FINAL-ANSWER" }] },
    { role: "user", content: latestInput }
  ];
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

// Independent protocol oracle: matching IDs somewhere later is insufficient.
// A batch's ordinary results must finish before another assistant/user message.
function assertContiguousResults(messages: ModelMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") {
      assert.deepEqual([...pending], [], `interrupted tool results before ${message.role}`);
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-call") {
            assert.equal(pending.has(part.toolCallId), false);
            pending.add(part.toolCallId);
          }
        }
      }
    } else {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        assert.equal(pending.delete(part.toolCallId), true, `orphan result ${part.toolCallId}`);
      }
    }
  }
  assert.deepEqual([...pending], []);
}

function assertPayloads(messages: ModelMessage[], calls: Call[], failedPatch = false): void {
  const assistantParts = messages.flatMap(message => message.role === "assistant" && Array.isArray(message.content) ? message.content : []);
  const text = assistantParts.flatMap(part => part.type === "text" ? [part.text] : []);
  assert.equal(text.filter(value => value === "ORIGINAL-ASSISTANT-TEXT").length, 1);
  assert.equal(text.filter(value => value === "ORIGINAL-FINAL-ANSWER").length, 1);
  assert.deepEqual(messages.at(-1), { role: "user", content: latestInput });
  const ordinaryCalls = assistantParts.flatMap(part => part.type === "tool-call" ? [part] : []);
  assert.deepEqual(ordinaryCalls.map(call => ({ id: call.toolCallId, name: call.toolName, input: call.input })),
    calls.filter(call => call.name !== "apply_patch").map(call => ({ id: call.id, name: call.name, input: argumentsFor(call) })));
  const results = messages.flatMap(message => message.role === "tool" ? message.content : [])
    .flatMap(part => part.type === "tool-result" ? [part] : []);
  assert.deepEqual(results.map(result => ({ id: result.toolCallId, name: result.toolName, output: result.output })),
    calls.filter(call => call.name !== "apply_patch").map(call => ({ id: call.id, name: call.name, output: { type: "text", value: `RESULT-${call.id}` } })));
  for (const call of calls.filter(call => call.name === "apply_patch")) {
    assert.equal(text.filter(value => value === `Historical file patch request: ${JSON.stringify(argumentsFor(call))}`).length, 1);
    assert.equal(text.filter(value => value === `Historical file patch result (${failedPatch ? "failed" : "completed"}): RESULT-${call.id}`).length, 1);
  }
}

for (const [name, calls, failedPatch] of [
  ["patch first in a mixed batch", [patch, read], false],
  ["patch between ordinary results", [read, patch, other], false],
  ["failed patch before ordinary result", [patch, read], true],
  ["ordinary result before a final patch", [read, patch], false],
  ["patch-only batch", [patch], false],
  ["ordinary-only batch", [read, other], false]
] as const) {
  test(`non-native history keeps contiguous results: ${name}`, () => {
    const canonical = history([...calls], failedPatch);
    const before = JSON.stringify(canonical);
    freeze(canonical);
    const projected = toModelMessages(canonical, false);
    // Check payloads and immutability before the intentionally red adjacency
    // assertion, so baseline failures cannot hide an earlier loss of content.
    assertPayloads(projected, [...calls], failedPatch);
    assert.equal(JSON.stringify(canonical), before);
    assertContiguousResults(projected);
  });
}

test("native history retains every original call/result and result order", () => {
  const calls = [read, patch, other];
  const canonical = history(calls);
  const before = JSON.stringify(canonical);
  freeze(canonical);
  const projected = toModelMessages(canonical, true);
  assertContiguousResults(projected);
  const projectedCalls = projected.flatMap(message => message.role === "assistant" && Array.isArray(message.content) ? message.content : [])
    .flatMap(part => part.type === "tool-call" ? [part] : []);
  assert.deepEqual(projectedCalls.map(call => ({ id: call.toolCallId, name: call.toolName, input: call.input })),
    calls.map(call => ({ id: call.id, name: call.name, input: argumentsFor(call) })));
  const results = projected.flatMap(message => message.role === "tool" ? message.content : [])
    .flatMap(part => part.type === "tool-result" ? [part] : []);
  assert.deepEqual(results.map(result => ({ id: result.toolCallId, name: result.toolName, output: result.output })),
    calls.map(call => ({ id: call.id, name: call.name, output: call.name === "apply_patch"
      ? { type: "json", value: { status: "completed", output: `RESULT-${call.id}` } }
      : { type: "text", value: `RESULT-${call.id}` } })));
  assert.deepEqual(projected.at(-1), { role: "user", content: latestInput });
  assert.equal(JSON.stringify(canonical), before);
});

interface WireMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function assertWireAdjacency(messages: WireMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      assert.equal(typeof message.tool_call_id, "string");
      assert.equal(pending.delete(message.tool_call_id!), true);
    } else {
      assert.deepEqual([...pending], [], `wire interruption before ${message.role}`);
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.deepEqual([...pending], []);
}

for (const [name, calls] of [
  ["patch first", [patch, read]],
  ["patch between results", [read, patch, other]],
  ["patch last control", [read, patch]]
] as const) {
  test(`actual SDK Chat Completions wire keeps batch adjacency: ${name}`, { timeout: 10_000 }, async () => {
    const bodies: Array<{ messages: WireMessage[] }> = [];
    const provider = createOpenAICompatible({
      name: "mixed-history-fixture",
      baseURL: "https://mixed-history.invalid/v1",
      apiKey: "inert-fixture-key",
      fetch: async (url, init) => {
        assert.equal(String(url), "https://mixed-history.invalid/v1/chat/completions");
        assert.equal(init?.method, "POST");
        bodies.push(JSON.parse(String(init?.body)) as { messages: WireMessage[] });
        // Always return a valid response. The oracle below examines the emitted
        // body; this is not a claim that a real server rejected the request.
        return new Response(JSON.stringify({
          id: "fixture-completion", object: "chat.completion", created: 1,
          model: "fixture-model",
          choices: [{ index: 0, message: { role: "assistant", content: "fixture ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }), { headers: { "content-type": "application/json" } });
      }
    });
    const canonical = history([...calls]);
    const before = JSON.stringify(canonical);
    freeze(canonical);
    const result = await generateText({
      model: provider("fixture-model"), messages: toModelMessages(canonical, false),
      maxRetries: 0, abortSignal: AbortSignal.timeout(5_000)
    });
    assert.equal(result.text, "fixture ok");
    assert.equal(bodies.length, 1);
    assert.equal(JSON.stringify(canonical), before);
    const wire = bodies[0]!.messages;
    assert.deepEqual(wire.at(-1), { role: "user", content: latestInput });
    const ordinary = calls.filter(call => call.name !== "apply_patch");
    assert.deepEqual(wire.flatMap(message => message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
      ordinary.map(call => ({ id: call.id, name: call.name, input: argumentsFor(call) })));
    assert.deepEqual(wire.filter(message => message.role === "tool").map(message => ({ id: message.tool_call_id, content: message.content })),
      ordinary.map(call => ({ id: call.id, content: `RESULT-${call.id}` })));
    const wireText = wire.flatMap(message => message.role === "assistant" && typeof message.content === "string" ? [message.content] : []).join("\n");
    for (const retained of [
      "ORIGINAL-ASSISTANT-TEXT", "ORIGINAL-FINAL-ANSWER",
      `Historical file patch request: ${JSON.stringify(argumentsFor(patch))}`,
      "Historical file patch result (completed): RESULT-patch-p"
    ]) assert.equal(wireText.split(retained).length - 1, 1, `wire must retain exactly one ${retained}`);
    assertWireAdjacency(wire);
  });
}
