import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

function reply(anthropic: boolean, step: number, name?: string, args: Record<string, string> = {}): Response {
  const headers = { "content-type": "text/event-stream" };
  if (!anthropic) {
    const part = name ? { functionCall: { id: `c${step}`, name, args }, thoughtSignature: "fixture-signature" } : { text: "Done" };
    const chunk = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers });
  }
  const events = [
    { type: "message_start", message: { id: `msg${step}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [],
      usage: { input_tokens: 100, output_tokens: 1 }, stop_reason: null, stop_sequence: null } },
    { type: "content_block_start", index: 0, content_block: name ? { type: "tool_use", name, id: `c${step}`, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: name ? { type: "input_json_delta", partial_json: JSON.stringify(args) } : { type: "text_delta", text: "Done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: name ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers });
}

for (const protocol of ["anthropic", "gemini"] as const) test(`${protocol} discovery preserves wire tools, history, and execution scope`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-protocol-search-"));
  await ensureAgentDirs(root);
  const anthropic = protocol === "anthropic";
  const modelId = anthropic ? "claude-sonnet-4-6" : "gemini-3-pro";
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "fixture",
    providers: { fixture: { type: anthropic ? "anthropic" : "google-native", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" } },
    models: { fixture: { provider: "fixture", model: modelId, capabilities: { tools: true } } }
  });
  config.agent.toolExecutionMode = "direct";
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  const registry = new ToolRegistry();
  const executions: string[] = [];
  registry.registerBuiltinTool({ name: "Inspect", description: "Inspect a fixture", risk: "read",
    schema: z.object({ path: z.string() }), parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    resolveExecution: ({ path }) => ({ approvalRule: "Inspect", execute: async () => { executions.push(path); return { ok: true }; } }) });
  registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
  const bodies: Array<{ tools: unknown[]; messages?: unknown[]; contents?: unknown[] }> = [];
  const runtime = new ConfiguredProviderRuntime("fixture", config.providers.fixture!, new AiRegistry(), [], undefined, async (url, init) => {
    assert.ok(String(url).startsWith("https://fixture.invalid/v1/"));
    bodies.push(JSON.parse(String(init?.body)));
    const step = bodies.length;
    if (step === 2) return reply(anthropic, step, "ToolSearch", { query: "Inspect" });
    if ([1, 3, 5].includes(step)) {
      const path = step === 1 ? "unreviewed.txt" : "file.txt";
      return anthropic ? reply(true, step, "Inspect", { path })
        : reply(false, step, "ToolCall", { name: "Inspect", argumentsJson: JSON.stringify({ path }, null, 2) });
    }
    return reply(anthropic, step);
  });
  const { model } = runtime.createModelSettings(config, config.models.fixture!);
  const recorder = new SessionRecorder(root);
  const create = (writer: SessionRecorder) => new AgentSession({ workspaceRoot: root, config, recorder: writer, toolRegistry: registry,
    model,
    permissionManager: new PermissionManager(config.permission), selectCapabilities: async () => ({ tools: ["ToolSearch"], skills: "none" }) });
  let session = create(recorder);
  t.after(async () => { await session.close(); await removeTestRoot(root, { recursive: true, force: true }); });
  const options = { emotionAnalysis: false, capabilitySelection: { tools: "auto" as const, skills: "none" as const } };
  await session.initialize();
  const run = await session.runTask("Inspect file.txt", options);
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(executions, ["file.txt"]);
  const signedCall = { functionCall: { id: "c3", name: "ToolCall", args: { name: "Inspect", argumentsJson: JSON.stringify({ path: "file.txt" }, null, 2) } }, thoughtSignature: "fixture-signature" };
  const tools = bodies[0]!.tools;
  const history = (index: number) => (anthropic ? bodies[index]!.messages : bodies[index]!.contents)!;
  if (anthropic) {
    assert.ok(tools.some(tool => (tool as {name: string}).name === "Inspect" && (tool as {defer_loading?: boolean}).defer_loading === true));
    assert.match(JSON.stringify(history(2).at(-1)), /"type":"tool_reference","tool_name":"Inspect"/);
  } else {
    assert.match(JSON.stringify(tools), /"name":"ToolCall"/);
    assert.match(JSON.stringify(tools), /"argumentsJson"/);
    assert.doesNotMatch(JSON.stringify(tools), /"name":"Inspect"/);
    assert.match(JSON.stringify(history(2).at(-1)), /deferredTools/);
    const parts = (history(3) as Array<{ parts: unknown[] }>).flatMap(message => message.parts);
    assert.deepEqual(parts.find(part => (part as typeof signedCall).functionCall?.id === "c3"), signedCall);
  }
  await session.close();
  session = create(new SessionRecorder(root));
  await session.initialize();
  await session.resume(recorder.sessionId);
  const resumed = await session.runTask("Repeat", options);
  assert.equal(resumed.status, "completed", resumed.error);
  assert.deepEqual(executions, ["file.txt", "file.txt"]);
  assert.equal(bodies.length, 6);
  if (!anthropic) {
    const parts = (history(4) as Array<{ parts: unknown[] }>).flatMap(message => message.parts);
    assert.deepEqual(parts.find(part => (part as typeof signedCall).functionCall?.id === "c3"), signedCall);
  }
  for (const body of bodies.slice(1)) assert.deepEqual(body.tools, tools);
  assert.ok(history(4).some(item => JSON.stringify(item) === JSON.stringify(history(2).at(-1))));
});
