import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { DesktopMcpService, MCP_CATALOG_URL } from "../src/desktop/electron/main/DesktopMcpService.js";
import type { McpServerStatus } from "../src/extensions/mcp.js";

async function fixture(context: TestContext, name = "target") {
  const config = configSchema.parse({
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: {
      target: { enabled: true, type: "http", url: "https://user:password@example.invalid/mcp?token=secret", headers: { Authorization: "secret-header" }, env: { TOKEN: "secret-env" } }
    } }
  });
  const status: McpServerStatus = {
    name, command: "unused-runtime-endpoint", transport: name === "computer-use" ? "in-process" : "http",
    enabled: true, connected: false, connecting: true, toolNames: ["target_tool"], promptNames: ["target_prompt"],
    hasResources: true, lastError: "connection pending", authRequired: true
  };
  const reads = { allStatuses: 0, unrelatedConfigs: 0, catalogClones: 0, config: 0 };
  const operations: Array<[string, string, string]> = [];
  for (let index = 0; index < 200; index += 1) {
    Object.defineProperty(config.extensions.mcp, `unrelated-${index}`, {
      enumerable: true,
      get: () => {
        reads.unrelatedConfigs += 1;
        return { enabled: true, command: "unrelated-server", args: [], cwd: ".", stderr: "ignore" };
      }
    });
  }
  const resources = [
    { uri: "memory://one", name: " One ", description: " Description ", mimeType: " text/plain ", extra: "excluded" },
    { uri: "memory://two", name: 42, description: " ", mimeType: null },
    { uri: 3, name: "invalid" }, { name: "missing URI" }
  ];
  const store: AgentConfigStore = {
    load: async () => config,
    save: async () => { throw new Error("Target reads cannot save configuration"); },
    loadVersioned: async workspaceRoot => {
      assert.equal(workspaceRoot, "/synthetic/mcp-project");
      reads.config += 1;
      return { config, revision: "sha256:target" };
    }
  };
  const service = new DesktopMcpService(store, {
    requireProject: (projectId: string) => {
      assert.equal(projectId, "project");
      return { path: "/synthetic/mcp-project" };
    }
  } as never, {
    assertNoRunningTasks: () => { throw new Error("Target reads cannot change task admission"); },
    refreshMcpRuntimes: async () => { throw new Error("Target reads cannot refresh all Runtimes"); },
    mcpStatuses: async () => { reads.allStatuses += 1; return [status]; },
    mcpReconnect: async (projectId, serverName) => {
      operations.push(["reconnect", projectId, serverName]);
      return status;
    },
    mcpDetails: async (projectId, serverName) => {
      operations.push(["details", projectId, serverName]);
      return { status, resources };
    }
  }, async () => new Response(JSON.stringify({ servers: Array.from({ length: 300 }, (_, index) => ({
    id: `market-${index}`, name: `Market ${index}`, installations: [{ name: "stdio", config: { command: "market-server" } }]
  })) })));
  await service.refreshCatalog();
  const clone = globalThis.structuredClone;
  context.mock.method(globalThis, "structuredClone", (value: unknown, options?: StructuredSerializeOptions) => {
    if (typeof value === "object" && value !== null && "source" in value && value.source === MCP_CATALOG_URL) reads.catalogClones += 1;
    return clone(value, options);
  });
  return { service, config, store, status, reads, operations };
}

for (const operation of ["details", "reconnect"] as const) {
  test(`${operation} projects only the target server and preserves redaction and resource fields`, async context => {
    const h = await fixture(context);
    const result = await h.service[operation]("project", " target ");
    const server = "server" in result ? result.server : result;
    assert.equal(server.name, "target");
    assert.equal(server.state, "connecting");
    assert.equal(server.transport, "remote");
    assert.deepEqual(server.toolNames, ["target_tool"]);
    assert.deepEqual(server.promptNames, ["target_prompt"]);
    assert.equal(server.hasResources, true);
    assert.equal(server.lastError, "connection pending");
    assert.equal(server.authRequired, true);
    assert.deepEqual(server.headerNames, ["Authorization"]);
    assert.deepEqual(server.environmentKeys, ["TOKEN"]);
    const endpoint = new URL(server.commandOrUrl);
    assert.equal(endpoint.username, "");
    assert.equal(endpoint.password, "");
    assert.equal(endpoint.searchParams.get("token"), "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(server), /secret-header|secret-env/u);
    if ("resources" in result) assert.deepEqual(result.resources, [
      { uri: "memory://one", name: "One", description: "Description", mimeType: "text/plain" },
      { uri: "memory://two", name: undefined, description: undefined, mimeType: undefined }
    ]);
    assert.deepEqual(h.operations, [[operation, "project", "target"]]);
    assert.deepEqual(h.reads, { allStatuses: 0, unrelatedConfigs: 0, catalogClones: 0, config: 1 });
  });

  test(`${operation} keeps built-in Computer Use and explicit same-name configuration semantics`, async context => {
    const h = await fixture(context, "computer-use");
    const result = await h.service[operation]("project", "computer-use");
    const server = "server" in result ? result.server : result;
    assert.equal(server.builtin, true);
    assert.equal(server.transport, "in-process");
    assert.equal(server.state, "connecting");
    assert.deepEqual(server.toolNames, ["target_tool"]);
    assert.deepEqual(server.promptNames, []);
    assert.equal(server.hasResources, false);
    h.config.extensions.mcp["computer-use"] = { ...h.config.extensions.mcp.target!, enabled: false };
    const overridden = await h.service[operation]("project", "computer-use");
    const configured = "server" in overridden ? overridden.server : overridden;
    assert.equal(configured.builtin, undefined);
    assert.equal(configured.transport, "remote");
    assert.equal(configured.state, "disabled");
    assert.deepEqual(h.reads, { allStatuses: 0, unrelatedConfigs: 0, catalogClones: 0, config: 2 });
  });

  test(`${operation} rejects a missing target configuration without reading unrelated state`, async context => {
    const h = await fixture(context);
    delete h.config.extensions.mcp.target;
    for (const name of ["target", "toString", "constructor", "__proto__"]) {
      h.status.name = name;
      await assert.rejects(h.service[operation]("project", name), { message: `MCP 服务器状态不存在：${name}` });
    }
    assert.deepEqual(h.operations, ["target", "toString", "constructor", "__proto__"].map(name => [operation, "project", name]));
    assert.deepEqual(h.reads, { allStatuses: 0, unrelatedConfigs: 0, catalogClones: 0, config: 4 });
  });
}
