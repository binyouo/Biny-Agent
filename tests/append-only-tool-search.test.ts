import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentMessage, AgentTool } from "../src/agent/core/types.js";
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

function response(item: Record<string, unknown>): Response {
  const events = [
    { type: "response.created", response: { id: "response-fixture", created_at: 1, model: "gpt-5.4" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Done" }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response-fixture", created_at: 1, model: "gpt-5.4", status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("native discovery keeps top-level schemas fixed and replays the loaded schema after serialization", async () => {
  const bodies: Array<{ tools: unknown[]; input: Array<Record<string, unknown>> }> = [];
  let executed = 0;
  const inspect: AgentTool = {
    name: "Inspect", description: "Inspect a document", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (_id, args) => { assert.equal(args.path, "README.md"); executed++; return { content: [{ type: "text", text: "document contents" }] }; }
  };
  const search: AgentTool = {
    name: "ToolSearch", description: "Find a tool", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    execute: async (_id, args) => {
      assert.equal(args.query, "Inspect");
      return { content: [{ type: "text", text: "Found Inspect" }], details: { status: "completed", tools: [{ name: "Inspect" }] } };
    }
  };
  const provider = createOpenAI({ apiKey: "fixture", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return response({ type: "tool_search_call", id: "search-item", call_id: "search-call", execution: "client", arguments: { query: "Inspect" }, status: "completed" });
    if (bodies.length === 2) return response({ type: "function_call", id: "inspect-item", call_id: "inspect-call", name: "Inspect", arguments: '{"path":"README.md"}', status: "completed" });
    return response({ type: "message", id: "done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] });
  } });
  const model = { provider: "openai", modelId: "gpt-5.4", vercelModel: provider.responses("gpt-5.4") };
  let history: AgentMessage[] = [];
  for await (const event of vercelAgentLoopContinue({ systemPrompt: "Stable instructions", messages: [{ role: "user", content: "Inspect README.md" }], tools: [search] }, {
    model, tools: [search], maxSteps: 4,
    resolveToolSearchTools: () => [inspect],
    prepareNextTurn: async ({ context }) => ({ context, tools: [search, inspect] })
  })) { if (event.type === "agent_end") history = event.contextMessages ?? []; }
  assert.equal(executed, 1);
  assert.equal(bodies.length, 3);
  assert.equal((bodies[0]!.tools[0] as { type: string }).type, "tool_search");
  assert.deepEqual(bodies[1]!.tools, bodies[0]!.tools);
  assert.deepEqual(bodies[2]!.tools, bodies[0]!.tools);
  const load = bodies[1]!.input.find(item => item.type === "tool_search_output");
  assert.ok(load);
  assert.deepEqual(load.tools, [{ type: "function", name: "Inspect", description: "Inspect a document", parameters: inspect.parameters, strict: false }]);
  assert.deepEqual(bodies[2]!.input.slice(0, bodies[1]!.input.length), bodies[1]!.input);
  const restored: AgentMessage[] = JSON.parse(JSON.stringify(history));
  restored.push({ role: "user", content: "Continue" });
  for await (const _event of vercelAgentLoopContinue({ systemPrompt: "Stable instructions", messages: restored, tools: [search, inspect] }, {
    model, tools: [search, inspect], resolveToolSearchTools: () => [inspect], maxSteps: 1
  })) { /* consume */ }
  assert.deepEqual(bodies[3]!.tools, bodies[0]!.tools);
  assert.deepEqual(bodies[3]!.input.find(item => item.type === "tool_search_output"), load);
});

test("native discovery uses the real coordinator and a revoked registration cannot execute its saved schema", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-native-discovery-"));
  await ensureAgentDirs(root);
  const registry = new ToolRegistry();
  let executions = 0;
  registry.registerBuiltinTool({ name: "Inspect", description: "Inspect a fixture", risk: "read", parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "Inspect", execute: async () => { executions++; return { ok: true }; } }) });
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
  const bodies: Array<{ tools: unknown[]; input: Array<Record<string, unknown>> }> = [];
  const provider = createOpenAI({ apiKey: "fixture", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return response({ type: "tool_search_call", id: "search-item", call_id: "search-call", execution: "client", arguments: { query: "Inspect" }, status: "completed" });
    if (bodies.length === 2) {
      registry.unregister("Inspect");
      return response({ type: "function_call", id: "inspect-item", call_id: "inspect-call", name: "Inspect", arguments: "{}", status: "completed" });
    }
    return response({ type: "message", id: `done-${bodies.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] });
  } });
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "direct";
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  const recorder = new SessionRecorder(root);
  const model = { provider: "openai", modelId: "gpt-5.4", vercelModel: provider.responses("gpt-5.4") };
  let session = new AgentSession({ workspaceRoot: root, config, model, toolRegistry: registry, permissionManager: new PermissionManager(config.permission), recorder });
  t.after(async () => { await session.close(); await removeTestRoot(root, { recursive: true, force: true }); });
  await session.initialize();
  const outcome = await session.runTask("Find Inspect and inspect the fixture", { capabilitySelection: { tools: ["ToolSearch"], skills: "none" }, emotionAnalysis: false });
  assert.equal(outcome.status, "completed", outcome.error);
  assert.equal(executions, 0);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[1]!.tools, bodies[0]!.tools);
  assert.match(JSON.stringify(bodies[2]!.input), /unavailable|registered|revoked/u);
  await recorder.flush();
  const replay = await replaySession(recorder.filePath);
  const result = replay.messages.find(message => message.role === "toolResult" && message.toolName === "ToolSearch");
  assert.ok(result?.role === "toolResult");
  assert.equal((result.details as { loadedToolSchemas: Array<{ name: string }> }).loadedToolSchemas[0]?.name, "Inspect");
  await session.close();
  session = new AgentSession({ workspaceRoot: root, config, model, toolRegistry: registry, permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(root) });
  await session.initialize();
  await session.resume(recorder.sessionId);
  const resumed = await session.runTask("Continue", { toolAccessSelection: "auto", capabilitySelection: { tools: ["ToolSearch"], skills: "none" }, emotionAnalysis: false });
  assert.equal(resumed.status, "completed", resumed.error);
  assert.deepEqual(bodies[3]!.input.find(item => item.type === "tool_search_output"), bodies[1]!.input.find(item => item.type === "tool_search_output"));
  assert.equal(executions, 0);
});
