/** 真实命令 Runtime、localhost 模型与 MCP 协议，验证背景连接和回合内工具发现。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentTurnOutcome } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeHostResourceScope } from "../src/runtime/host/resources.js";
import { readSessionEvents } from "../src/session/events.js";
import type { ToolSearchResult } from "../src/tools/toolSearch.js";

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MCP runtime test exceeded 8 seconds")), 8_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
function sendParts(response: ServerResponse, parts: Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([...parts.map((part) => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n");
}
function sendText(response: ServerResponse, content: string): void {
  sendParts(response, [
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]);
}
function sendToolCall(response: ServerResponse, id: string, name: string, args: Record<string, unknown>): void {
  sendParts(response, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-discovery-runtime-"));
const oldAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "global");
const workspaceRoot = path.join(root, "workspace");
await mkdir(workspaceRoot);
const mainRequests: Record<string, unknown>[] = [];
let initializeCount = 0;
let callCount = 0;
let initializeEntered!: () => void;
const initializing = new Promise<void>((resolve) => { initializeEntered = resolve; });
let releaseInitialize: (() => void) | undefined;
const inputSchema = { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["limit"], additionalProperties: false };
const outputSchema = { type: "object", properties: { records: { type: "array", items: { type: "object" } } }, required: ["records"] };
const mcp = createServer((request, response) => {
  void (async () => {
    if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 204 : 405).end(); return; }
    const message = await requestJson(request);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const reply = (result: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      initializeCount += 1;
      releaseInitialize = () => reply({
        protocolVersion: (message.params as { protocolVersion?: string })?.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "records-fixture", version: "1" },
        instructions: "Read notes by explicit query."
      });
      initializeEntered();
    } else if (message.method === "tools/list") {
      reply({ tools: [{ name: "list", description: "Read note records", inputSchema, outputSchema, annotations: { readOnlyHint: true } }] });
    } else if (message.method === "tools/call") {
      callCount += 1;
      const params = message.params as { name?: string; arguments?: unknown };
      assert.equal(params.name, "list");
      assert.deepEqual(params.arguments, { limit: 2 });
      reply({ content: [{ type: "text", text: "A record was retrieved" }], structuredContent: { records: [{ id: 1, title: "fixture-record" }] }, isError: false });
    } else reply({});
  })().catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  });
});
const mcpOrigin = await listen(mcp);
const provider = createServer((request, response) => {
  void (async () => {
    const body = await requestJson(request);
    assert.equal(body.model, "fixture-model");
    mainRequests.push(body);
    assert.ok(mainRequests.length <= 4, "Discovery and continuation must remain bounded");
    const names = (body.tools as Array<{ function?: { name?: string; parameters?: unknown } }>).map((tool) => tool.function?.name);
    if (mainRequests.length === 1) {
      assert.equal(initializeCount, 1);
      assert.equal(names.includes("mcp_notes_list"), false);
      assert.doesNotMatch(JSON.stringify(body.messages), /Read notes by explicit query/);
      sendText(response, "Ordinary message completed.");
    } else if (mainRequests.length === 2) {
      assert.equal(names.includes("mcp_notes_list"), false);
      sendToolCall(response, "discover-records", "ToolSearch", { query: "mcp_notes_list", type: "mcp" });
    } else if (mainRequests.length === 3) {
      assert.ok(names.includes("mcp_notes_list"), "The same turn must receive the freshly discovered MCP schema");
      const discovered = (body.tools as Array<{ function?: { name?: string; parameters?: unknown } }>).find((tool) => tool.function?.name === "mcp_notes_list");
      assert.deepEqual(discovered?.function?.parameters, inputSchema);
      sendToolCall(response, "read-records", "mcp_notes_list", { limit: 2 });
    } else {
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      assert.match(JSON.stringify(messages.filter((message) => message.role === "tool")), /fixture-record/);
      sendText(response, "The MCP record was retrieved.");
    }
  })().catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  });
});
const providerOrigin = await listen(provider);
const config = configSchema.parse({
  ...defaultConfig, defaultModel: "fixture", toolModel: undefined,
  providers: { fixture: { type: "openai-compatible", baseUrl: `${providerOrigin}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
  models: { fixture: { provider: "fixture", model: "fixture-model", capabilities: { tools: true, reasoning: false, streaming: true } } },
  thinking: { ...defaultConfig.thinking, enabled: false },
  permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
  extensions: { ...defaultConfig.extensions, skills: [], plugins: [], globalPlugins: [],
    subagent: { ...defaultConfig.extensions.subagent, enabled: false },
    mcp: { notes: { enabled: true, type: "http", url: `${mcpOrigin}/mcp`, transportProtocol: "streamable-http", timeoutMs: 5_000 } } },
  checkpoints: { enabled: false },
  context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
  crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
});
const scope = new RuntimeHostResourceScope(workspaceRoot, config);
const controller = new AbortController();
const abortTimer = setTimeout(() => controller.abort(new Error("MCP discovery runtime deadline exceeded")), 15_000);
let runtime: CommandRuntime | undefined;
let creating: Promise<CommandRuntime> | undefined;
try {
  // Given an injected resource scope with a blocked real handshake, ordinary tasks start without MCP.
  creating = createCommandRuntime(workspaceRoot, { resourceScope: scope, configStore: { load: async () => config, save: async () => undefined } });
  await withinDeadline(initializing);
  runtime = await withinDeadline(creating);
  assert.equal(scope.mcp.listServers()[0]?.connecting, true);
  const sessionFile = runtime.agent.getInfo().sessionFile;
  const options = { abortSignal: controller.signal, emotionAnalysis: false,
    capabilitySelection: { tools: ["ToolSearch"], skills: "none" as const } };
  const ordinary = await withinDeadline(runtime.agent.runTask("Reply to an ordinary message", options));
  assert.equal(ordinary.status, "completed", JSON.stringify(ordinary));
  assert.equal(scope.mcp.listServers()[0]?.connecting, true);
  assert.equal(callCount, 0);

  // ToolSearch joins the active handshake; its callback refreshes the registry in the current turn.
  let discoveryStarted = false;
  let outcome: AgentTurnOutcome | undefined;
  const discovering = (async () => {
    for await (const event of runtime!.agent.prompt("Discover and read note records", options)) {
      if (event.type === "tool.started" && event.tool === "ToolSearch") {
        discoveryStarted = true;
        assert.equal(scope.mcp.listServers()[0]?.connecting, true);
        assert.equal(runtime!.listTools().some((tool) => tool.name === "mcp_notes_list"), false);
        assert.ok(releaseInitialize);
        releaseInitialize();
        releaseInitialize = undefined;
      }
      if (event.type === "done") outcome = event.outcome;
    }
  })();
  await withinDeadline(discovering);
  assert.equal(discoveryStarted, true);
  assert.equal(outcome?.status, "completed", JSON.stringify(outcome));
  assert.equal(initializeCount, 1, "Discovery reuses the existing MCP connection attempt");
  assert.equal(callCount, 1);
  assert.equal(mainRequests.length, 4);
  const catalog = runtime.listTools().find((tool) => tool.name === "mcp_notes_list");
  assert.ok(catalog);
  assert.equal(catalog.exposure, "deferred");
  assert.equal(catalog.namespace?.name, "notes");
  assert.equal(catalog.namespace?.instructions, "Read notes by explicit query.");
  assert.deepEqual(catalog.parameters, inputSchema);
  assert.deepEqual(catalog.outputSchema, outputSchema);
  await runtime.close();
  runtime = undefined;
  const events = await readSessionEvents(sessionFile);
  const searches = events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch");
  assert.equal(searches.length, 1);
  const search = searches[0];
  assert.ok(search && search.type === "tool_result");
  assert.deepEqual((search.result as ToolSearchResult).tools.map((tool) => tool.name), ["mcp_notes_list"]);
  const calls = events.filter((event) => event.type === "tool_call" && event.tool === "mcp_notes_list");
  const results = events.filter((event) => event.type === "tool_result" && event.tool === "mcp_notes_list");
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  const result = results[0];
  assert.ok(result && result.type === "tool_result");
  const stored = result.result as { records: unknown; truncated?: boolean; durationMs?: number };
  assert.deepEqual(stored.records, [{ id: 1, title: "fixture-record" }]);
  assert.equal(stored.truncated, false);
  assert.equal(typeof stored.durationMs, "number");
  assert.equal(result.executionStatus, "succeeded");
  assert.ok(result.operationId);
  assert.equal(events.filter((event) => event.type === "turn_status" && event.status === "completed").length, 2);
} finally {
  clearTimeout(abortTimer);
  controller.abort();
  releaseInitialize?.();
  await (runtime ?? await creating?.catch(() => undefined))?.close();
  await scope.close();
  await closeServer(provider);
  await closeServer(mcp);
  if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("MCP discovery runtime tests passed");
