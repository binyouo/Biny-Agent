/** 真实 SDK adapter 的思考元数据必须从 SSE 经持久化投影回到下一轮请求。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentAssistantMessage, AgentEvent, AgentMessage, AgentTool, ModelStreamOptions } from "../src/agent/core/types.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

type WireEvent = { type: string; [key: string]: unknown };
type WireMessage = { role: string; content: Array<Record<string, unknown>> };
const reasoningText = "Inspect the fixture before answering.";
const signature = "fixture-signature";
const encrypted = "fixture-encrypted-reasoning";
const toolId = "call-fixture";
const toolInput = { path: "README.md" };

function sse(events: WireEvent[]): Response {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 53));
      offset += 53;
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

function anthropicResponse(kind: "signed" | "omitted" | "redacted" | "text"): Response {
  const events: WireEvent[] = [{
    type: "message_start",
    message: {
      id: "msg-fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 }
    }
  }];
  const block = (index: number, content: Record<string, unknown>, deltas: Record<string, unknown>[]) => {
    events.push({ type: "content_block_start", index, content_block: content });
    for (const delta of deltas) events.push({ type: "content_block_delta", index, delta });
    events.push({ type: "content_block_stop", index });
  };
  if (kind === "text") {
    block(0, { type: "text", text: "" }, [{ type: "text_delta", text: "Done." }]);
  } else {
    if (kind === "redacted") block(0, { type: "redacted_thinking", data: encrypted }, []);
    else block(0, { type: "thinking", thinking: "", signature: "" }, [
      ...(kind === "signed" ? [{ type: "thinking_delta", thinking: reasoningText }] : []),
      { type: "signature_delta", signature }
    ]);
    block(1, { type: "text", text: "" }, [{ type: "text_delta", text: "Checking the fixture." }]);
    block(2, { type: "tool_use", id: toolId, name: "inspect", input: {} }, [
      { type: "input_json_delta", partial_json: '{"path":"REA' },
      { type: "input_json_delta", partial_json: 'DME.md"}' }
    ]);
  }
  events.push({ type: "message_delta", delta: { stop_reason: kind === "text" ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } }, { type: "message_stop" });
  return sse(events);
}

function responsesResponse(withTool: boolean): Response {
  const events: WireEvent[] = [{ type: "response.created", response: { id: "resp-fixture", created_at: 1, model: "gpt-5.4" } }];
  const output: Array<Record<string, unknown>> = [];
  if (withTool) {
    const reasoning = { type: "reasoning", id: "rs-fixture", encrypted_content: encrypted, summary: [{ type: "summary_text", text: reasoningText }] };
    const call = { type: "function_call", id: "fc-fixture", call_id: toolId, name: "inspect", arguments: JSON.stringify(toolInput), status: "completed" };
    output.push(reasoning, call);
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: reasoning.id, encrypted_content: null } },
      { type: "response.reasoning_summary_part.added", item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: reasoningText },
      { type: "response.reasoning_summary_part.done", item_id: reasoning.id, output_index: 0, summary_index: 0, part: reasoning.summary[0] },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 1, delta: '{"path":"REA' },
      { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 1, delta: 'DME.md"}' },
      { type: "response.function_call_arguments.done", item_id: call.id, output_index: 1, arguments: call.arguments },
      { type: "response.output_item.done", output_index: 1, item: call }
    );
  } else {
    const message = { type: "message", id: "msg-final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
    output.push(message);
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Done." },
      { type: "response.output_item.done", output_index: 0, item: message }
    );
  }
  events.push({ type: "response.completed", response: {
    id: "resp-fixture", created_at: 1, model: "gpt-5.4", status: "completed", output,
    usage: { input_tokens: 15, output_tokens: 7, total_tokens: 22, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 4 } }
  } });
  return sse(events);
}

async function runLoop(provider: LanguageModelV4, modelOptions: ModelStreamOptions) {
  const events: AgentEvent[] = [];
  const saved: AgentAssistantMessage[] = [];
  const executed: unknown[] = [];
  const tool: AgentTool = {
    name: "inspect", description: "Inspect a test fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(id, input) {
      executed.push({ id, input });
      return { content: [{ type: "text", text: "fixture contents" }] };
    }
  };
  for await (const event of vercelAgentLoopContinue(
    { messages: [{ role: "user", content: "Inspect the fixture." }], tools: [tool] },
    {
      model: { provider: provider.provider, modelId: provider.modelId, stream: async () => { throw new Error("Must use the native provider adapter."); } },
      vercelModel: provider, tools: [tool], maxSteps: 2, maxRetries: 0, modelOptions,
      persistStep: async ({ message }) => { saved.push(structuredClone(message)); }
    }
  )) events.push(event);
  assert.deepEqual(events.filter(event => event.type === "error"), []);
  assert.deepEqual(executed, [{ id: toolId, input: toolInput }]);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1]?.content, [{ type: "text", text: "Done." }]);
  return { saved, events };
}

for (const kind of ["signed", "omitted", "redacted"] as const) {
  test(`Anthropic ${kind} reasoning survives the native tool continuation`, async () => {
    const bodies: Array<{ messages: WireMessage[] }> = [];
    const provider = createVercelLanguageModel({
      providerAlias: "claude-fixture", providerType: "anthropic", authMode: "api-key", api: "anthropic_messages",
      modelId: "claude-sonnet-4-5", supportsReasoning: true, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {},
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
        return anthropicResponse(bodies.length === 1 ? kind : "text");
      }
    });
    const { saved } = await runLoop(provider, { maxOutputTokens: 2048, providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } } });
    assert.equal(bodies.length, 2);
    const reasoning = saved[0]?.content.find(part => part.type === "reasoning");
    assert.deepEqual(reasoning, {
      type: "reasoning", text: kind === "signed" ? reasoningText : "",
      providerMetadata: { anthropic: kind === "redacted" ? { redactedData: encrypted } : { signature } }
    }, "the persisted format must keep providerMetadata unchanged");
    assert.deepEqual(bodies[1]?.messages.find(message => message.role === "assistant")?.content, [
      kind === "redacted" ? { type: "redacted_thinking", data: encrypted } : { type: "thinking", thinking: kind === "signed" ? reasoningText : "", signature },
      { type: "text", text: "Checking the fixture." },
      { type: "tool_use", id: toolId, name: "inspect", input: toolInput }
    ]);
    assert.deepEqual(saved[0]?.usage, { inputTokens: 15, outputTokens: 7, totalTokens: 22, reasoningTokens: undefined, cacheReadTokens: 2, cacheWriteTokens: 3 });
    assert.deepEqual(bodies[1]?.messages.at(-1)?.content, [{ type: "tool_result", tool_use_id: toolId, content: "fixture contents" }]);
  });
}

test("OpenAI Responses replays encrypted reasoning with a custom provider name", async () => {
  const bodies: Array<{ input: Array<Record<string, unknown>>; store: boolean }> = [];
  const provider = createVercelLanguageModel({
    providerAlias: "openai-fixture", providerType: "openai", authMode: "api-key", api: "responses",
    modelId: "gpt-5.4", supportsReasoning: true, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {},
    fetcher: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      return responsesResponse(bodies.length === 1);
    }
  });
  const { saved } = await runLoop(provider, { providerOptions: { openai: { store: false } } });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]?.store, false);
  assert.deepEqual(saved[0]?.content.find(part => part.type === "reasoning"), {
    type: "reasoning", text: reasoningText,
    providerMetadata: { openai: { itemId: "rs-fixture", reasoningEncryptedContent: encrypted } }
  });
  assert.deepEqual(bodies[1]?.input.find(item => item.type === "reasoning"), {
    type: "reasoning", id: "rs-fixture", encrypted_content: encrypted,
    summary: [{ type: "summary_text", text: reasoningText }]
  });
  assert.deepEqual(saved[0]?.usage, { inputTokens: 15, outputTokens: 7, totalTokens: 22, reasoningTokens: 4, cacheReadTokens: 2, cacheWriteTokens: undefined });
  assert.deepEqual(bodies[1]?.input.find(item => item.type === "function_call_output"), { type: "function_call_output", call_id: toolId, output: "fixture contents" });
});

test("the metadata input field changes only reasoning and leaves stored messages untouched", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Inspect." },
    { role: "assistant", content: [
      { type: "text", text: "Checking." },
      { type: "reasoning", text: "Plain reasoning." },
      { type: "reasoning", text: reasoningText, providerMetadata: { fixture: { signature } } },
      { type: "toolCall", id: toolId, name: "inspect", arguments: toolInput }
    ] },
    { role: "toolResult", toolCallId: toolId, toolName: "inspect", content: [{ type: "text", text: "fixture contents" }] }
  ];
  const original = structuredClone(messages);
  assert.deepEqual(toModelMessages(messages), [
    { role: "user", content: "Inspect." },
    { role: "assistant", content: [
      { type: "text", text: "Checking." },
      { type: "reasoning", text: "Plain reasoning.", providerOptions: undefined },
      { type: "reasoning", text: reasoningText, providerOptions: { fixture: { signature } } },
      { type: "tool-call", toolCallId: toolId, toolName: "inspect", input: toolInput }
    ] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: toolId, toolName: "inspect", output: { type: "text", value: "fixture contents" } }] }
  ]);
  assert.deepEqual(messages, original);
});
