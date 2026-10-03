/** 真实 Runtime/HTTP 辅助模型切换与 session 落盘，不使用用户配置或远端 API。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import type { ToolSearchResult } from "../src/tools/toolSearch.js";

await testAutomaticToolModelFallback(false);
await testAutomaticToolModelFallback(true);
console.log("tool model runtime e2e tests passed");

async function testAutomaticToolModelFallback(hasHealthyCandidate: boolean): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-model-runtime-"));
  const oldAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  let runtime: CommandRuntime | undefined;
  const auxiliaryRequests: string[] = [];
  const mainRequests: Record<string, unknown>[] = [];
  const provider = await startProviderServer(async (request, response) => {
    const body = await requestJson(request);
    if (body.model === "chat-model" && Array.isArray(body.tools)) {
      mainRequests.push(body);
      assert.ok(mainRequests.length <= 3, "tool discovery must not cause an unbounded main-model loop");
      if (mainRequests.length === 1) {
        sendToolCall(response, "discover-notes", "ToolSearch", { query: "inspect the contents of a local note" });
      } else if (mainRequests.length === 2) {
        const tools = body.tools as Array<{ function?: { name?: string } }>;
        assert.ok(tools.some((tool) => tool.function?.name === "Read"), "successful discovery must disclose the registered tool");
        sendToolCall(response, "inspect-note", "Read", { path: "note.txt" });
      } else {
        assert.match(JSON.stringify(body.messages), /fixture-note-content/u, "main-model continuation must receive the actual tool output");
        sendText(response, "The local note was inspected.");
      }
      return;
    }
    if (body.model === "exhausted-aux") {
      auxiliaryRequests.push(String(body.model));
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "insufficient_balance", message: "Insufficient Balance" } }));
      return;
    }
    sendText(response, "[]");
  });
  const healthyProvider = await startProviderServer(async (request, response) => {
    const body = await requestJson(request);
    auxiliaryRequests.push(String(body.model));
    assert.equal(body.model, "healthy-aux");
    sendText(response, JSON.stringify({ tools: ["Read"] }));
  });
  const controller = new AbortController();
  // A hard deadline cancels the actual Runtime request, including provider and tool work.
  const timer = setTimeout(() => controller.abort(new Error("Runtime tool-model fallback test timed out.")), 15_000);
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "note.txt"), "fixture-note-content\n");
    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "chat",
      toolModel: undefined,
      providers: {
        exhausted: { type: "openai-compatible", baseUrl: provider.endpoint, requiresApiKey: false, retry: { maxAttempts: 1 } },
        healthy: { type: "openai-compatible", baseUrl: healthyProvider.endpoint, requiresApiKey: false, retry: { maxAttempts: 1 } }
      },
      models: {
        exhaustedAux: { provider: "exhausted", model: "exhausted-aux", capabilities: { tools: false, reasoning: false, streaming: true } },
        ...(hasHealthyCandidate ? { healthyAux: { provider: "healthy", model: "healthy-aux", capabilities: { tools: false, reasoning: false, streaming: true } } } : {}),
        chat: { provider: "exhausted", model: "chat-model", capabilities: { tools: true, reasoning: false, streaming: true } }
      },
      thinking: { ...defaultConfig.thinking, enabled: false },
      permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
      extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      checkpoints: { enabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    runtime = await createCommandRuntime(workspace, { configStore: { load: async () => config, save: async () => undefined } });
    const sessionFile = runtime.agent.getInfo().sessionFile;
    const outcome = await runtime.agent.runTask("Inspect the local note using a discovered capability", {
      abortSignal: controller.signal,
      capabilitySelection: { tools: ["ToolSearch"], skills: "none" },
      emotionAnalysis: false
    });
    assert.equal(outcome.status, hasHealthyCandidate ? "completed" : "blocked", JSON.stringify(outcome));
    assert.deepEqual(auxiliaryRequests, hasHealthyCandidate ? ["exhausted-aux", "healthy-aux"] : ["exhausted-aux"]);
    assert.equal(mainRequests.length, hasHealthyCandidate ? 3 : 1, "candidate exhaustion must stop before another main-model request");
    await runtime.close();
    runtime = undefined;
    const events = await readSessionEvents(sessionFile);
    const searchResults = events.filter((event) => event.type === "tool_result" && event.tool === "ToolSearch");
    assert.equal(searchResults.length, 1, "model fallback must preserve one stable tool_result for discovery");
    const searchResult = searchResults[0];
    assert.ok(searchResult && searchResult.type === "tool_result");
    const result = searchResult.result as ToolSearchResult;
    const exhaustedAttempt = { provider: "openai-compatible", providerAlias: "exhausted", modelId: "exhausted-aux", status: "failed" };
    const healthyModel = { provider: "openai-compatible", providerAlias: "healthy", modelId: "healthy-aux" };
    assert.deepEqual(result.modelAttempts, hasHealthyCandidate ? [exhaustedAttempt, { ...healthyModel, status: "completed" }] : [exhaustedAttempt], "candidate attempts must remain durable without replaying discovery");
    assert.deepEqual(result.model, hasHealthyCandidate ? healthyModel : undefined, "persisted discovery must identify the model that actually succeeded");
    assert.ok(events.some((event) => event.type === "turn_status" && event.status === (hasHealthyCandidate ? "completed" : "blocked")));
    const reads = events.filter((event) => event.type === "tool_call" && event.tool === "Read");
    assert.equal(reads.length, hasHealthyCandidate ? 1 : 0, "fallback must not replay or execute optional tools after failure");
    assert.match(JSON.stringify(searchResults[0]), hasHealthyCandidate ? /"status":"completed"/u : /"retryable":false/u);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await runtime?.close();
    await provider.close();
    await healthyProvider.close();
    if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function startProviderServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendToolCall(response: ServerResponse, id: string, name: string, args: Record<string, unknown>): void {
  sendParts(response, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}

function sendText(response: ServerResponse, content: string): void {
  sendParts(response, [
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]);
}

function sendParts(response: ServerResponse, parts: Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([...parts.map((part) => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n");
}
