import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { usesChatCompletions } from "../src/agent/core/deferredToolSearch.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

for (const backend of ["openai", "openai-compatible"] as const) test(`Chat discovery preserves declarations and resumes through ${backend}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-chat-discovery-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "direct";
  config.permission.denyPaths = ["blocked.txt"];
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  const registry = new ToolRegistry();
  const executed: string[] = [];
  const registerInspect = (description: string) => registry.registerBuiltinTool({
    name: "Inspect", description, risk: "read",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    schema: z.object({ path: z.string() }),
    resolveExecution: ({ path }) => ({ approvalRule: "Inspect",
      execute: async () => { executed.push(path); return { inspected: path }; } })
  });
  registerInspect("Inspect a fixture");
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
  const bodies: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string; tool_calls?: Array<{ function: { name: string } }> }> }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://fixture.invalid/v1/chat/completions");
    bodies.push(JSON.parse(String(init?.body)));
    const index = bodies.length;
    const target = { name: "Inspect", arguments: { path: "file.txt" } };
    const calls: Record<number, [string, unknown]> = { 1: ["ToolCall", target], 2: ["ToolSearch", { query: "Inspect" }],
      3: ["ToolCall", target], 5: ["ToolCall", target],
      6: ["ToolCall", { name: "Inspect", arguments: { path: "blocked.txt" } }],
      7: ["ToolCall", { name: "Inspect", arguments: { path: 7 } }],
      8: ["ToolCall", target], 9: ["ToolCall", target], 10: ["ToolSearch", { query: "Inspect" }],
      11: ["ToolCall", { name: "Inspect", arguments: { path: "updated.txt" } }] };
    if (index === 8) {
      registry.unregister("Inspect");
      registerInspect("Inspect the updated fixture");
    }
    const call = calls[index];
    const delta = call ? { tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { content: "Done" };
    const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] });
    return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, call ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const model = { provider: backend, providerAlias: "fixture", modelId: "fixture", vercelModel: createVercelLanguageModel({
    providerAlias: "fixture", providerType: backend, authMode: "api-key", api: "chat_completions", modelId: "fixture",
    supportsReasoning: backend === "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {}, fetcher
  }) };
  const recorder = new SessionRecorder(root);
  const create = (writer: SessionRecorder) => new AgentSession({ workspaceRoot: root, config, model, toolRegistry: registry,
    selectCapabilities: async () => ({ tools: bodies.length ? ["ToolSearch", "Inspect"] : ["ToolSearch"], skills: "none" }),
    permissionManager: new PermissionManager(config.permission), recorder: writer });
  let session = create(recorder);
  t.after(async () => { await session.close(); await removeTestRoot(root, { recursive: true, force: true }); });
  await session.initialize();
  const options = { capabilitySelection: { tools: "auto" as const, skills: "none" as const }, emotionAnalysis: false };
  const first = await session.runTask("Inspect file.txt", options);
  assert.equal(first.status, "completed", first.error);
  assert.deepEqual(bodies[0]?.tools.map(tool => tool.function.name).sort(), ["ToolCall", "ToolSearch"]);
  assert.deepEqual(executed, ["file.txt"]);
  const result = bodies[2]?.messages.findLast(message => message.role === "tool");
  assert.deepEqual(JSON.parse(result?.content ?? "{}").deferredTools, [{ name: "Inspect", description: "Inspect a fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }]);
  for (const index of [1, 2, 3]) {
    const prior = bodies[index - 1]!.messages;
    assert.deepEqual(bodies[index]!.messages.slice(0, prior.length), prior);
  }
  assert.equal(bodies[3]?.messages.findLast(message => message.tool_calls?.length)?.tool_calls?.[0]?.function.name, "ToolCall");
  await recorder.flush();
  const replay = await replaySession(recorder.filePath);
  assert.ok(replay.events.some(event => event.type === "tool_call" && event.tool === "Inspect" && event.toolCallId === "call-3"));
  await session.close();
  session = create(new SessionRecorder(root));
  await session.initialize();
  await session.resume(recorder.sessionId);
  const resumed = await session.runTask("Repeat", options);
  assert.equal(resumed.status, "completed", resumed.error);
  assert.deepEqual(executed, ["file.txt", "file.txt", "updated.txt"]);
  assert.match(JSON.stringify(bodies[6]?.messages.at(-1)), /denied/i);
  assert.match(JSON.stringify(bodies[7]?.messages.at(-1)), /invalid tool arguments for Inspect.*path/i);
  assert.match(JSON.stringify(bodies[8]?.messages.at(-1)), /available|registered|revoked/);
  assert.match(JSON.stringify(bodies[9]?.messages.at(-1)), /definition has changed/);
  assert.match(JSON.stringify(bodies[10]?.messages.at(-1)), /Inspect the updated fixture/);
  assert.equal(bodies.length, 12);
  for (const body of bodies.slice(1)) assert.deepEqual(body.tools, bodies[0]?.tools);
  assert.deepEqual(bodies[4]?.messages.find(message => message.content === result?.content), result);
});

test("Chat Completions detection respects the configured provider alias", () => {
  for (const [providerType, api, expected] of [
    ["openai-compatible", "chat_completions", true], ["openai", "responses", false],
    ["anthropic", "anthropic_messages", false], ["google-native", "google_generative_ai", false]
  ] as const) {
    const providerAlias = "custom.chat";
    const vercelModel = createVercelLanguageModel({ providerAlias, providerType, api, authMode: "api-key",
      modelId: "fixture", supportsReasoning: false, apiKey: "fixture", baseUrl: "https://fixture.invalid/v1",
      headers: {}, fetcher: () => { throw new Error("Unexpected network request"); } });
    assert.equal(usesChatCompletions({ provider: providerType, providerAlias, modelId: "fixture", vercelModel }), expected, api);
  }
});
