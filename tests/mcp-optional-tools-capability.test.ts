const { default: assert } = await import("node:assert/strict");
const { mock, test } = await import("node:test");
const { mkdtemp, rm } = await import("node:fs/promises");
const { default: os } = await import("node:os");
const { default: path } = await import("node:path");

type Transport = import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
type Message = import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage;
type Request = import("@modelcontextprotocol/sdk/types.js").JSONRPCRequest;
type Capabilities = import("@modelcontextprotocol/sdk/types.js").ServerCapabilities;
type Host = import("../src/extensions/mcp.js").McpToolHost;

const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-optional-tools-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");

try {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { configSchema, defaultConfig } = await import("../src/config/schema.js");
  const { McpToolHost, createMcpResourceTools } = await import("../src/extensions/mcp.js");
  const { createMcpPromptTools } = await import("../src/extensions/mcpPrompts.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
    fixture: { enabled: true, type: "http", url: "https://mcp-optional-tools.invalid/mcp",
      transportProtocol: "streamable-http", startupTimeoutMs: 1_000, timeoutMs: 1_000 }
  } } });

  // Only the external transport is replaced. Production SDK negotiation and
  // validation, Host lifecycle, registry and generic MCP adapters remain real.
  function fixture(capabilities: Capabilities, rejectTools = false) {
    const requests: Array<{ generation: number; method: string }> = [];
    const generations = new WeakMap<Transport, number>();
    const connections: Transport[] = [];
    const state = { capabilities, closes: 0 };
    const reply = (transport: Transport, request: Request, result: Record<string, unknown>): void => {
      transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
    };
    mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: Transport) {
      connections.push(this);
      generations.set(this, connections.length);
    });
    mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: Transport, message: Message) {
      if (!("method" in message) || !("id" in message)) return;
      const generation = generations.get(this)!;
      requests.push({ generation, method: message.method });
      if (message.method === "initialize") {
        reply(this, message, { protocolVersion: message.params?.protocolVersion, capabilities: state.capabilities,
          serverInfo: { name: "optional-tools-fixture", version: "1" } });
      } else if (message.method === "tools/list" && state.capabilities.tools && !rejectTools) {
        reply(this, message, { tools: [{ name: "echo", inputSchema: { type: "object" } }] });
      } else if (message.method === "tools/call" && state.capabilities.tools && !rejectTools) {
        reply(this, message, { content: [{ type: "text", text: `Tool generation ${generation}` }] });
      } else if (message.method === "resources/list" && state.capabilities.resources) {
        reply(this, message, { resources: [{ uri: `fixture://resource-${generation}`, name: "Fixture resource" }] });
      } else if (message.method === "resources/read" && state.capabilities.resources) {
        reply(this, message, { contents: [{ uri: message.params?.uri, text: `Resource generation ${generation}` }] });
      } else if (message.method === "prompts/list" && state.capabilities.prompts) {
        reply(this, message, { prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }] });
      } else if (message.method === "prompts/get" && state.capabilities.prompts) {
        reply(this, message, { messages: [{ role: "user", content: { type: "text", text: `Prompt generation ${generation}` } }] });
      } else {
        this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      }
    });
    mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: Transport) {
      state.closes += 1;
      this.onclose?.();
    });
    return { state, requests, connections, disconnect: () => connections.at(-1)!.onclose?.() };
  }

  async function executeGeneric(host: Host, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = [...createMcpResourceTools(host), ...createMcpPromptTools(host)].find(entry => entry.name === name);
    assert.ok(tool);
    const execution = await tool.resolveExecution(args);
    assert.ok(!("isError" in execution));
    return await execution.execute({ toolCallId: name, operationId: name });
  }

  async function assertGenericResults(host: Host, capabilities: Capabilities, generation: number): Promise<void> {
    if (capabilities.resources) {
      assert.deepEqual(await executeGeneric(host, "mcp_list_resources", {}), [{
        server: "fixture", uri: `fixture://resource-${generation}`, name: "Fixture resource", description: undefined, mimeType: undefined
      }]);
      assert.deepEqual(await executeGeneric(host, "mcp_read_resource", { server: "fixture", uri: `fixture://resource-${generation}` }), {
        server: "fixture", uri: `fixture://resource-${generation}`,
        contents: [{ uri: `fixture://resource-${generation}`, mimeType: undefined, text: `Resource generation ${generation}` }]
      });
    }
    if (capabilities.prompts) {
      assert.deepEqual(await executeGeneric(host, "mcp_list_prompts", {}), [{
        server: "fixture", prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }]
      }]);
      assert.deepEqual(await executeGeneric(host, "mcp_get_prompt", { server: "fixture", name: "review", arguments: { topic: "fixture" } }), {
        server: "fixture", name: "review", description: undefined,
        messages: [{ role: "user", content: { type: "text", text: `Prompt generation ${generation}` } }], truncated: false
      });
    }
  }

  for (const rejectTools of [false, true]) {
    await test(`advertised MCP tools remain ${rejectTools ? "required when discovery fails" : "discoverable"}`, async () => {
      const fake = fixture({ tools: {}, resources: {}, prompts: {} }, rejectTools);
      const host = new McpToolHost();
      try {
        await host.connectConfiguredServers(root, config);
        const status = host.listServers()[0]!;
        assert.equal(status.connected, !rejectTools);
        assert.equal(fake.requests.filter(entry => entry.method === "tools/list").length, 1);
        assert.deepEqual(status.toolNames, rejectTools ? [] : ["mcp_fixture_echo"]);
        if (rejectTools) {
          assert.match(status.lastError ?? "", /Method not found: tools\/list/u);
          assert.equal(fake.state.closes, 1, "declared tool discovery failure must still close the failed connection");
        } else {
          const tool = host.createTools().find(entry => entry.name === "mcp_fixture_echo");
          assert.ok(tool);
          const execution = await tool.resolveExecution({});
          assert.ok(!("isError" in execution));
          assert.equal(await execution.execute({ toolCallId: "echo-control", operationId: "echo-control" }), "Tool generation 1");
          assert.equal(fake.requests.filter(entry => entry.method === "tools/call").length, 1);
          await assertGenericResults(host, fake.state.capabilities, 1);
        }
      } finally {
        try { await host.close(); } finally { mock.restoreAll(); }
      }
    });
  }

  const variants: Array<{ name: string; capabilities: Capabilities }> = [
    { name: "resources only", capabilities: { resources: {} } },
    { name: "prompts only", capabilities: { prompts: {} } },
    { name: "resources and prompts", capabilities: { resources: {}, prompts: {} } }
  ];
  for (const { name, capabilities } of variants) {
    await test(`MCP server with ${name} works without tools capability, including lazy reconnect`, async () => {
      const fake = fixture(capabilities);
      const host = new McpToolHost();
      const registry = new ToolRegistry();
      try {
        await host.connectConfiguredServers(root, config, registry);
        const status = host.listServers()[0]!;
        assert.equal(status.connected, true, `${name} is a valid negotiated server: ${status.lastError ?? "no error"}`);
        assert.equal(status.hasResources, Boolean(capabilities.resources));
        assert.deepEqual(status.promptNames, capabilities.prompts ? ["review"] : []);
        assert.deepEqual(status.toolNames, []);
        assert.deepEqual(host.createTools(), []);
        assert.deepEqual(registry.list(), []);
        assert.equal(fake.state.closes, 0);
        await assertGenericResults(host, capabilities, 1);
        assert.equal(fake.connections.length, 1, "generic reads reuse the successful startup connection");

        fake.disconnect();
        assert.equal(host.listServers()[0]?.connected, false);
        await assertGenericResults(host, capabilities, 2);
        assert.equal(host.listServers()[0]?.connected, true);
        assert.equal(fake.connections.length, 2, "generic reads lazily reconnect exactly once");
        assert.deepEqual(fake.requests.filter(entry => entry.method === "tools/list"), [], "an unadvertised tools capability must never be requested");
      } finally {
        try { await host.close(); } finally { mock.restoreAll(); }
      }
    });
  }

  await test("MCP reconnect drops a previously cached tool catalog when the new server no longer advertises tools", async () => {
    const fake = fixture({ tools: {}, resources: {} });
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    try {
      await host.connectConfiguredServers(root, config, registry);
      assert.equal(host.listServers()[0]?.connected, true);
      assert.deepEqual(registry.list().map(tool => tool.name), ["mcp_fixture_echo"]);
      fake.state.capabilities = { resources: {} };
      fake.disconnect();
      await assertGenericResults(host, fake.state.capabilities, 2);
      assert.equal(host.listServers()[0]?.connected, true);
      assert.deepEqual(host.listServers()[0]?.toolNames, []);
      assert.deepEqual(host.createTools(), []);
      assert.deepEqual(registry.list(), [], "successful capability negotiation removes stale executable registrations");
      assert.deepEqual(fake.requests.filter(entry => entry.generation === 2 && entry.method === "tools/list"), []);
      assert.equal(fake.connections.length, 2);
    } finally {
      try { await host.close(); } finally { mock.restoreAll(); }
    }
  });
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

export {};
