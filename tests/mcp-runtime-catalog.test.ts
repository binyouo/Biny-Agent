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
function fakeServer() {
  const state = { transport: undefined as StreamableHTTPClientTransport | undefined, starts: 0, lists: 0,
    tools: [definition("echo"), definition("obsolete")], rejectList: false };
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    state.transport = this;
    state.starts += 1;
  });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") reply(this, message, {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "catalog-fixture", version: "1" }
    });
    else if (message.method === "tools/list") {
      state.lists += 1;
      if (state.rejectList) this.onmessage?.({ jsonrpc: "2.0", id: message.id,
        error: { code: -32603, message: "Fixture catalog unavailable" } });
      else reply(this, message, { tools: structuredClone(state.tools) });
    } else throw new Error(`Unexpected MCP request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    this.onclose?.();
  });
  return { state,
    notify: () => state.transport!.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    disconnect: () => state.transport!.onclose?.()
  };
}

for (const change of ["removed tool", "changed schema", "disconnect", "failed reconnect", "rejected live refresh"] as const) {
  await test(`runtime catalog reflects ${change} before the next agent turn`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-runtime-catalog-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    mock.method(os, "homedir", () => path.join(root, "home"));
    const fake = fakeServer();
    let runtime: CommandRuntime | undefined;
    try {
      const providerAlias = `catalog-fixture-${randomUUID()}`;
      const config = configSchema.parse({ ...defaultConfig, defaultModel: providerAlias, toolModel: undefined,
        providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "https://unused-model.invalid/v1", requiresApiKey: false } },
        models: { [providerAlias]: { provider: providerAlias, model: "fixture-model" } },
        extensions: { ...defaultConfig.extensions, skills: [], plugins: [], globalPlugins: [],
          subagent: { ...defaultConfig.extensions.subagent, enabled: false },
          mcp: { fixture: { enabled: true, type: "http", url: "https://mcp-catalog.invalid/mcp",
            transportProtocol: "streamable-http", timeoutMs: 2_000, exposure: "codemode", toolExposure: { echo: "direct" } } } },
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
        crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
        activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
      });
      await saveConfigFile(process.env.BINY_AGENT_DIR, config);
      // macOS 测试也使用无持久化凭据存储，不访问用户的 Keychain。
      const configStore = createFileConfigStore(root, { globalDir: process.env.BINY_AGENT_DIR, credentialStore: new EnvironmentCredentialStore() });
      runtime = await createCommandRuntime(root, { configStore });
      const remoteCatalog = () => runtime!.listTools().filter((tool) => tool.namespace?.name === "fixture");
      const original = remoteCatalog();
      assert.deepEqual(original.map((tool) => tool.name), ["mcp_fixture_echo", "mcp_fixture_obsolete"]);
      const builtinNames = runtime.listTools().filter((tool) => tool.source !== "mcp").map((tool) => tool.name);
      assert.ok(builtinNames.includes("Read"));
      const originalCapabilities = runtime.capabilities.list("host");
      const executionCounts = runtime.extensionStatus().toolCounts;

      if (change === "rejected live refresh") {
        fake.state.rejectList = true;
        fake.notify();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(runtime.mcp.listServers()[0]?.connected, true);
        assert.match(runtime.mcp.listServers()[0]?.lastError ?? "", /tool refresh failed.*Fixture catalog unavailable/);
      } else if (change === "disconnect") fake.disconnect();
      else if (change === "failed reconnect") {
        fake.state.rejectList = true;
        const status = await runtime.mcp.reconnectServer("fixture");
        assert.equal(status.connected, false);
        assert.match(status.lastError ?? "", /Fixture catalog unavailable/);
      } else {
        fake.state.tools = change === "removed tool" ? [definition("echo")] : [definition("echo", "number"), definition("obsolete")];
        fake.notify();
        // The SDK dispatches notifications and request replies in microtasks.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fake.state.lists, 2, "the real host completed the notified discovery");
        assert.equal(runtime.mcp.listServers()[0]?.lastError, undefined);
      }

      if (change === "changed schema") {
        const echo = remoteCatalog().find((tool) => tool.name === "mcp_fixture_echo")!;
        assert.deepEqual(echo.parameters?.properties?.value, { type: "number" });
        assert.deepEqual(echo.outputSchema, { type: "object", properties: { value: { type: "number" } } });
        assert.match(echo.description, /Read a number/);
        assert.equal(echo.risk, "read");
        assert.equal(echo.exposure, "direct");
      } else if (change === "rejected live refresh") assert.deepEqual(remoteCatalog(), original, "a live refresh failure retains its last complete catalog");
      else assert.deepEqual(remoteCatalog().map((tool) => tool.name), change === "removed tool" ? ["mcp_fixture_echo"] : [],
        "the user-facing catalog must not retain detached or removed remote tools");
      assert.deepEqual(runtime.listTools().filter((tool) => tool.source !== "mcp").map((tool) => tool.name), builtinNames);
      assert.equal(fake.state.starts, change === "failed reconnect" ? 2 : 1, "listing cannot initiate a reconnect");
      assert.deepEqual(runtime.capabilities.list("host"), originalCapabilities, "catalog reads cannot update execution capability registrations");
      assert.ok(runtime.listTools().some((tool) => tool.name === "mcp_list_resources"), "generic lazy-reconnect adapters remain available");
      assert.deepEqual(runtime.extensionStatus().toolCounts, executionCounts, "catalog reads leave the execution registry unchanged");
      if (change === "rejected live refresh") {
        assert.match(runtime.extensionStatus().mcp[0]?.lastError ?? "", /tool refresh failed.*Fixture catalog unavailable/,
          "catalog reads must retain the failure shown with the connected server status");
      }

      fake.state.rejectList = false;
      fake.state.tools = [definition("replacement", "number")];
      assert.equal((await runtime.mcp.reconnectServer("fixture")).connected, true);
      assert.deepEqual(remoteCatalog().map((tool) => tool.name), ["mcp_fixture_replacement"], "recovery publishes only the replacement catalog");
      assert.deepEqual(runtime.capabilities.list("host"), originalCapabilities);
      assert.deepEqual(runtime.extensionStatus().toolCounts, executionCounts);
      runtime.refreshExtensionTools!();
      assert.equal(runtime.extensionStatus().toolCounts.mcp, executionCounts.mcp - 1, "only explicit execution refresh replaces the registered remote tools");
    } finally {
      await runtime?.close();
      mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
