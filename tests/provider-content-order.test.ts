/** SDK content is ordered by block starts, not by text/reasoning/tool categories. */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentAssistantMessage, AgentEvent, AgentTool } from "../src/agent/core/types.js";

const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 1, reasoning: 2 } };
const text = (id: string, value: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id }, { type: "text-delta", id, delta: value }, { type: "text-end", id }
];
const call = (id: string): LanguageModelV4StreamPart => ({ type: "tool-call", toolCallId: id, toolName: "inspect", input: JSON.stringify({ path: id }) });
const toolContent = (id: string) => ({ type: "toolCall", id, name: "inspect", arguments: { path: id }, invalid: undefined });
const metadata = (signature: string) => ({ fixture: { signature, nested: { preserved: true } } });

async function run(parts: LanguageModelV4StreamPart[], withTools = true) {
  const requests: LanguageModelV4CallOptions[] = [];
  const saved: AgentAssistantMessage[] = [];
  const events: AgentEvent[] = [];
  const executed: string[] = [];
  const tool: AgentTool = {
    name: "inspect", description: "Inspect a local fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(id) {
      executed.push(id);
      return { content: [{ type: "text", text: `result:${id}` }] };
    }
  };
  const provider: LanguageModelV4 = {
    specificationVersion: "v4", provider: "ordered-fixture", modelId: "ordered-fixture", supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected non-streaming request"); },
    async doStream(options) {
      requests.push(options);
      const first = requests.length === 1;
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          for (const part of first ? parts : text("final", "Done.")) controller.enqueue(part);
          controller.enqueue({ type: "finish", finishReason: { unified: first && withTools ? "tool-calls" : "stop", raw: undefined }, usage });
          controller.close();
        }
      }) };
    }
  };
  for await (const event of vercelAgentLoopContinue(
    { messages: [{ role: "user", content: "Inspect." }], tools: [tool] },
    {
      model: { provider: provider.provider, modelId: provider.modelId, stream: async () => { throw new Error("Unexpected legacy model"); } },
      vercelModel: provider, tools: [tool], maxSteps: 2, maxRetries: 0,
      persistStep: async ({ message }) => { saved.push(structuredClone(message)); }
    }
  )) events.push(event);
  assert.deepEqual(events.filter(event => event.type === "error"), []);
  assert.equal(requests.length, withTools ? 2 : 1);
  const first = saved[0];
  assert.ok(first);
  const ended = events.filter((event): event is Extract<AgentEvent, { type: "message_end" }> => event.type === "message_end" && event.message.role === "assistant");
  assert.deepEqual(ended[0]?.message, first, "persisted and final display messages must agree");
  const agentEnd = events.find(event => event.type === "agent_end");
  assert.deepEqual(agentEnd?.messages[0], first, "history must retain the same ordered assistant message");
  return { requests, saved, events, executed, first };
}

test("text-first and interleaved blocks keep their order, signatures and tool IDs", async () => {
  const { first, requests, events, executed } = await run([
    ...text("text-z", "Before."),
    { type: "reasoning-start", id: "reason-z", providerMetadata: metadata("start-z") },
    { type: "reasoning-delta", id: "reason-z", delta: "Same reasoning." },
    { type: "reasoning-end", id: "reason-z", providerMetadata: metadata("end-z") },
    call("call-z"),
    ...text("text-a", "Between."),
    { type: "reasoning-start", id: "reason-a" },
    { type: "reasoning-delta", id: "reason-a", delta: "Same reasoning.", providerMetadata: metadata("delta-a") },
    { type: "reasoning-end", id: "reason-a" },
    call("call-a"),
    ...text("text-last", "After.")
  ]);
  assert.deepEqual(first.content, [
    { type: "text", text: "Before." },
    { type: "reasoning", text: "Same reasoning.", providerMetadata: metadata("end-z") },
    toolContent("call-z"),
    { type: "text", text: "Between." },
    { type: "reasoning", text: "Same reasoning.", providerMetadata: metadata("delta-a") },
    toolContent("call-a"),
    { type: "text", text: "After." }
  ]);
  assert.deepEqual(executed, ["call-z", "call-a"]);
  const replay = requests[1]?.prompt.find(message => message.role === "assistant");
  assert.deepEqual(JSON.parse(JSON.stringify(replay?.content)), [
    { type: "text", text: "Before." },
    { type: "reasoning", text: "Same reasoning.", providerOptions: metadata("end-z") },
    { type: "tool-call", toolCallId: "call-z", toolName: "inspect", input: { path: "call-z" } },
    { type: "text", text: "Between." },
    { type: "reasoning", text: "Same reasoning.", providerOptions: metadata("delta-a") },
    { type: "tool-call", toolCallId: "call-a", toolName: "inspect", input: { path: "call-a" } },
    { type: "text", text: "After." }
  ]);
  const updates = events.filter(event => event.type === "message_update");
  assert.deepEqual(updates.filter(event => event.event.type === "reasoning-start").map(event => event.event.type === "reasoning-start" ? event.event.id : undefined), ["reason-z", "reason-a"]);
  // UI streaming snapshots still aggregate display text, independently of canonical block order.
  const lastTool = updates.find(event => event.event.type === "tool-call" && event.event.id === "call-a");
  assert.deepEqual(lastTool?.message.content.filter(part => part.type === "text"), [{ type: "text", text: "Before.Between." }]);
});

test("interleaved deltas are assembled by stream ID without merging separate text blocks", async () => {
  const { first } = await run([
    { type: "text-start", id: "text-z" },
    { type: "reasoning-start", id: "reason-z" },
    { type: "text-start", id: "text-a" },
    { type: "reasoning-start", id: "reason-a" },
    { type: "text-delta", id: "text-a", delta: "A" },
    { type: "reasoning-delta", id: "reason-a", delta: "second" },
    { type: "reasoning-end", id: "reason-a", providerMetadata: metadata("a") },
    { type: "reasoning-delta", id: "reason-z", delta: "first" },
    { type: "text-delta", id: "text-z", delta: "Z" },
    { type: "text-delta", id: "text-z", delta: "!" },
    { type: "text-end", id: "text-z" },
    { type: "reasoning-end", id: "reason-z", providerMetadata: metadata("z") },
    { type: "text-end", id: "text-a" }
  ], false);
  assert.deepEqual(first.content, [
    { type: "text", text: "Z!" },
    { type: "reasoning", text: "first", providerMetadata: metadata("z") },
    { type: "text", text: "A" },
    { type: "reasoning", text: "second", providerMetadata: metadata("a") }
  ]);
});

test("unsupported content and empty text do not hide later tools or empty signed reasoning", async () => {
  const { first, executed, saved } = await run([
    ...text("empty", ""),
    { type: "reasoning-start", id: "empty-reasoning" },
    { type: "reasoning-end", id: "empty-reasoning", providerMetadata: metadata("empty") },
    { type: "source", sourceType: "url", id: "source", url: "https://fixture.invalid/source" },
    { type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([0]) } },
    { type: "reasoning-file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([0]) } },
    { type: "custom", kind: "fixture.ignored", providerMetadata: metadata("custom") },
    call("last-call")
  ]);
  assert.deepEqual(first.content, [
    { type: "reasoning", text: "", providerMetadata: metadata("empty") },
    toolContent("last-call")
  ], "unsupported SDK content and tool results must not become assistant content");
  assert.deepEqual(executed, ["last-call"]);
  assert.deepEqual(saved[1]?.content, [{ type: "text", text: "Done." }], "later steps must not retain earlier blocks");
});
