import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { saveConfigFile } from "../src/config/loader.js";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";

function definition(name: string, type: "string" | "number" = "string"): Tool {
  return { name, description: `Read a ${type}`, inputSchema: { type: "object", properties: { value: { type } } },
    outputSchema: { type: "object", properties: { value: { type } } }, annotations: { readOnlyHint: type === "number" } };
}

// Only the external transport is replaced; the SDK and runtime own discovery,
// connection state, tool proxies, session registry and the returned catalog.
function fakeServer(tools: Tool[]) {
  let requests = 0;
  mock.method(StreamableHTTPClientTransport.prototype, "start", async () => undefined);
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    requests += 1;
    const request = message as JSONRPCRequest;
    const result = message.method === "initialize"
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "collision-fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: structuredClone(tools) } : undefined;
    assert.ok(result, `Unexpected external request: ${message.method}`);
    this.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) { this.onclose?.(); });
  return () => requests;
}

for (const fixture of [
  { label: "punctuation normalization", names: ["foo.bar", "foo_bar"] },
  { label: "42-character truncation", names: [`${"x".repeat(42)}first`, `${"x".repeat(42)}second`] },
  { label: "reversed punctuation order", names: ["foo_bar", "foo.bar"] },
  { label: "duplicate remote name", names: ["duplicate", "duplicate"] }
]) {
  await test(`runtime catalog preserves distinct definitions and deduplicates identical names for ${fixture.label}`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-collision-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    mock.method(os, "homedir", () => path.join(root, "home"));
    const first = definition(fixture.names[0]!, "number");
    const second = definition(fixture.names[1]!, "string");
    const requestCount = fakeServer([first, second, definition("unrelated")]);
    let runtime: CommandRuntime | undefined;
    try {
      const providerAlias = `collision-fixture-${randomUUID()}`;
      const config = configSchema.parse({ ...defaultConfig, defaultModel: providerAlias, toolModel: undefined,
        providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "https://unused-model.invalid/v1", requiresApiKey: false } },
        models: { [providerAlias]: { provider: providerAlias, model: "fixture-model" } },
        extensions: { ...defaultConfig.extensions, skills: [], plugins: [], globalPlugins: [],
          subagent: { ...defaultConfig.extensions.subagent, enabled: false },
          mcp: { fixture: { enabled: true, type: "http", url: "https://mcp-collision.invalid/mcp",
            transportProtocol: "streamable-http", timeoutMs: 2_000, exposure: "codemode", toolExposure: { [first.name]: "direct" } } } },
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
        crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
        activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
      });
      await saveConfigFile(process.env.BINY_AGENT_DIR, config);
      const configStore = createFileConfigStore(root, { globalDir: process.env.BINY_AGENT_DIR, credentialStore: new EnvironmentCredentialStore() });
      runtime = await createCommandRuntime(root, { configStore });
      const capabilities = runtime.capabilities.list("host");
      const counts = runtime.extensionStatus().toolCounts;
      const requests = requestCount();
      const catalog = runtime.listTools();
      const winners = catalog.filter(tool => tool.description.startsWith(`[MCP fixture/${first.name}]`));
      assert.equal(winners.length, 1, "each original remote name has exactly one catalog entry");
      const winner = winners[0]!;
      assert.equal(winner.source, "mcp");
      assert.match(winner.description, /Read a number/u);
      assert.deepEqual(winner.parameters, first.inputSchema);
      assert.deepEqual(winner.outputSchema, first.outputSchema);
      assert.equal(winner.risk, "read");
      assert.equal(winner.exposure, "direct");
      assert.equal(winner.namespace?.name, "fixture");
      const remote = catalog.filter(tool => tool.namespace?.name === "fixture");
      assert.equal(remote.length, first.name === second.name ? 2 : 3);
      if (first.name !== second.name) {
        const other = remote.find(tool => tool.description.startsWith(`[MCP fixture/${second.name}]`));
        assert.ok(other, "lossy names must retain the second remote definition");
        assert.notEqual(other.name, winner.name);
        assert.deepEqual(other.parameters, second.inputSchema);
        assert.deepEqual(other.outputSchema, second.outputSchema);
        assert.equal(other.risk, "execute");
        assert.equal(other.exposure, "codemode");
      }

      assert.equal(new Set(catalog.map(tool => tool.name)).size, catalog.length);
      assert.ok(catalog.some(tool => tool.name === "mcp_fixture_unrelated"));
      assert.ok(catalog.some(tool => tool.name === "Read" && tool.source === "builtin"));
      assert.ok(catalog.some(tool => tool.name === "mcp_list_resources"));
      assert.deepEqual(runtime.listTools(), catalog, "repeated catalog reads remain stable");
      assert.equal(requestCount(), requests, "catalog projection performs no external requests");
      assert.deepEqual(runtime.capabilities.list("host"), capabilities, "catalog reads cannot update execution capabilities");
      assert.deepEqual(runtime.extensionStatus().toolCounts, counts, "catalog reads cannot update registrations");
    } finally {
      await runtime?.close();
      mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
