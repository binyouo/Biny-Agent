import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createMcpResourceTools, McpToolHost } from "../src/extensions/mcp.js";
import { createMcpPromptTools } from "../src/extensions/mcpPrompts.js";
import { ToolRegistry } from "../src/tools/registry.js";

function fixture(names: string[]) {
  const tools: McpTool[] = names.map(name => ({ name, inputSchema: { type: "object", properties: {} } }));
  const calls: string[] = [];
  const connections: StreamableHTTPClientTransport[] = [];
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function(this: StreamableHTTPClientTransport) { connections.push(this); });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function(this: StreamableHTTPClientTransport) { this.onclose?.(); });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function(this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    const reply = (result: Record<string, unknown>) => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") reply({ protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: { listChanged: true } }, serverInfo: { name: "names", version: "1" } });
    else if (message.method === "tools/list") reply({ tools: structuredClone(tools) });
    else if (message.method === "tools/call") {
      assert.ok(typeof message.params?.name === "string");
      calls.push(message.params.name);
      reply({ content: [{ type: "text", text: message.params.name }] });
    } else throw new Error(`Unexpected request ${message.method}`);
  });
  return { tools, calls, connections };
}
const config = (servers: string[]) => configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions,
  mcp: Object.fromEntries(servers.map(server => [server, { url: "https://tool-names.invalid/mcp", transportProtocol: "streamable-http" }]))
} });

// 原实现将长名称截断、将不同分隔符替换成下划线，现有短名称用例发现不了目录丢项。
await test("long and lossy MCP names remain distinct, stable and callable after catalog reordering", async () => {
  const names = [`${"x".repeat(42)}_read`, `${"x".repeat(42)}_write`, "path/read", "path read", "normal_read", "inner_normal_read"];
  const fake = fixture(names);
  const host = new McpToolHost();
  const servers = ["fixture", "fixture_inner", `${"server".repeat(8)}_one`, `${"server".repeat(8)}_two`];
  try {
    await host.connectConfiguredServers(process.cwd(), config(servers));
    const tools = host.createTools();
    assert.equal(new Set(tools.map(tool => tool.name)).size, names.length * servers.length, "each remote server/tool pair needs its own callable name");
    assert.ok(tools.every(tool => /^[A-Za-z0-9_-]{1,64}$/u.test(tool.name)), "model-visible names fit the function-name limit");
    assert.ok(tools.some(tool => tool.name === "mcp_fixture_normal_read"), "ordinary short names stay unchanged");
    const registry = new ToolRegistry();
    for (const tool of tools) registry.registerMcpTool(tool);
    for (const tool of registry.list()) {
      const execution = await tool.resolveExecution({});
      assert.ok(!("isError" in execution));
      await execution.execute({ toolCallId: tool.name, operationId: tool.name });
    }
    assert.deepEqual(fake.calls, servers.flatMap(() => names), "mapped calls must send the original remote tool name");
    fake.tools.reverse();
    for (const server of servers) await host.reconnectServer(server);
    assert.deepEqual(host.createTools().map(tool => tool.name).toSorted(), tools.map(tool => tool.name).toSorted(), "names cannot depend on discovery order");
  } finally { await host.close(); mock.restoreAll(); }
});

// 普通短名称也可能撞上内置资源或模板工具，不能只检查远端工具彼此重名。
await test("remote short names cannot shadow generic MCP resource and prompt tools", async () => {
  fixture(["resources", "resource", "prompts", "prompt"]);
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config(["list", "read", "get"]));
    const registry = new ToolRegistry();
    const generic = [...createMcpResourceTools(host), ...createMcpPromptTools(host)];
    for (const tool of generic) registry.registerMcpTool(tool);
    for (const tool of host.createTools()) registry.registerMcpTool(tool);
    assert.equal(registry.list().length, 12 + generic.length, "every generic and remote tool must remain independently callable");
  } finally { await host.close(); mock.restoreAll(); }
});

// 重复的远端原名无法区分调用目标；共享 Host 也必须去重并报告，不能依赖可选 Registry。
for (const attachRegistry of [false, true]) {
  await test(`duplicate remote definitions are excluded and reported (${attachRegistry ? "attached registry" : "shared host"})`, async () => {
    const fake = fixture(["echo", "echo"]);
    const host = new McpToolHost();
    const registry = attachRegistry ? new ToolRegistry() : undefined;
    try {
      await host.connectConfiguredServers(process.cwd(), config(["fixture"]), registry);
      assert.equal(host.createTools().length, 1, "only accepted definitions enter the discoverable catalog");
      assert.deepEqual(host.listServers()[0]!.toolNames, ["mcp_fixture_echo"]);
      assert.match(host.listServers()[0]!.lastError ?? "", /duplicate|already registered/iu);
      fake.tools.pop();
      fake.connections[0]!.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(host.listServers()[0]!.lastError, undefined, "a valid refreshed catalog clears the collision warning");
      assert.equal(host.createTools().length, 1);
    } finally { await host.close(); mock.restoreAll(); }
  });
}
