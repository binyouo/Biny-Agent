import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopMcpService } from "../src/desktop/electron/main/DesktopMcpService.js";
import { McpToolHost } from "../src/extensions/mcp.js";

for (const finish of ["success", "disconnect"] as const) {
  test(`MCP details report the target status after resource pagination ends with ${finish}`, async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-details-status-"));
    const credential = "fixture-only-mcp-credential";
    const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
      target: { enabled: true, type: "http", url: "https://mcp-details.invalid/mcp", transportProtocol: "streamable-http",
        headers: { Authorization: credential }, timeoutMs: 1_000 }
    } } });
    const requests: string[] = [];
    let starts = 0;
    const host = new McpToolHost();
    context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
    context.mock.method(StreamableHTTPClientTransport.prototype, "start", async () => { starts += 1; });
    // 仅替换外部传输；握手、分页、断线通知、请求拒绝与凭据处理均经过真实 SDK 和 Host。
    context.mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
      if (!("id" in message) || !("method" in message)) return;
      requests.push(message.method);
      const reply = (result: Record<string, unknown>): void => {
        this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
      };
      if (message.method === "initialize") reply({ protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } });
      else if (message.method === "tools/list") reply({ tools: [] });
      else if (message.method === "resources/list") {
        if (message.params?.cursor === undefined) reply({ resources: [{ uri: "memory://one", name: ` Entry ${credential} `,
          description: " Kept resource ", mimeType: " text/plain " }], nextCursor: "after-first" });
        else {
          assert.equal(message.params.cursor, "after-first");
          if (finish === "disconnect") this.onclose?.();
          else reply({ resources: [] });
        }
      } else throw new Error(`Unexpected MCP request: ${message.method}`);
    });
    context.mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) { this.onclose?.(); });
    const service = new DesktopMcpService({
      load: async () => config,
      save: async () => { throw new Error("Details cannot save configuration"); },
      loadVersioned: async () => ({ config, revision: "fixture" })
    }, { requireProject: () => ({ path: root }) } as never, {
      mcpDetails: async (_projectId, serverName) => await host.describeServer(serverName),
      mcpReconnect: async () => { throw new Error("Details cannot explicitly reconnect"); },
      mcpStatuses: async () => { throw new Error("Details cannot enumerate unrelated server statuses"); },
      assertNoRunningTasks: () => { throw new Error("Details cannot change task admission"); },
      refreshMcpRuntimes: async () => { throw new Error("Details cannot refresh Runtime connections"); }
    }, async () => { throw new Error("Details cannot fetch the market"); });
    try {
      await host.connectConfiguredServers(root, config);
      const result = await service.details("project", "target");
      assert.equal(result.server.state, finish === "disconnect" ? "disconnected" : "connected");
      assert.equal(result.server.lastError, finish === "disconnect" ? "connection closed" : undefined);
      assert.deepEqual(result.resources, [{ uri: "memory://one", name: "Entry [redacted]", description: "Kept resource", mimeType: "text/plain" }],
        "partial resource results survive; failed-page entries without a URI stay out of Desktop resources");
      assert.doesNotMatch(JSON.stringify(result), new RegExp(credential, "u"));
      assert.deepEqual(result.server.headerNames, ["Authorization"]);
      assert.equal(result.server.hasResources, true);
      assert.deepEqual(requests, ["initialize", "tools/list", "resources/list", "resources/list"]);
      assert.equal(starts, 1, "reading a disconnect result must not start another connection");
    } finally {
      await host.close();
      context.mock.restoreAll();
      await rm(root, { recursive: true, force: true });
    }
  });
}
