import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { DesktopMcpService } from "../src/desktop/electron/main/DesktopMcpService.js";
import { parseArguments, parseClipboardConfig, toFieldMutations } from "../src/desktop/renderer/src/mcpFormDraft.js";

const configStore = {
  loadVersioned: async () => ({ config: structuredClone(defaultConfig), revision: "sha256:test" })
} as unknown as AgentConfigStore;

const projects = {
  requireProject: () => ({ id: "project", name: "Project", path: "/tmp/project" })
};

const agents = {
  assertNoRunningTasks: () => undefined,
  refreshMcpRuntimes: async () => undefined,
  mcpStatuses: async () => [],
  mcpReconnect: async () => { throw new Error("not used"); },
  mcpDetails: async () => { throw new Error("not used"); }
};

const service = new DesktopMcpService(
  configStore,
  projects as never,
  agents,
  async () => new Response(JSON.stringify({
    version: "1.0.0",
    servers: [
      {
        id: "filesystem",
        name: "Filesystem",
        description: "Local files",
        category: "files",
        author: "community",
        verified: true,
        featured: true,
        repository: "https://example.com/filesystem",
        tags: ["files", "local"],
        installations: [{
          name: "NPX",
          config: JSON.stringify({ command: "npx", args: ["-y", "filesystem-mcp"] }),
          parameters: [{ name: "Root", key: "ROOT", required: true, placeholder: "/tmp" }],
          transports: ["stdio"]
        }]
      },
      {
        id: "remote",
        name: "Remote service",
        description: "HTTP service",
        installations: [{
          name: "SSE",
          config: { url: "https://example.com/mcp" },
          transports: ["sse"]
        }]
      },
      {
        id: "invalid",
        name: "Invalid",
        installations: [{ name: "broken", config: "not-json" }]
      }
    ]
  }), { status: 200 })
);

const state = await service.refreshCatalog();
assert.equal(state.status, "ready");
assert.deepEqual(state.categories, ["files"]);
assert.equal(state.entries.length, 2);
assert.equal(state.entries[0]?.installations[0]?.transport, "stdio");
assert.equal(state.entries[0]?.installations[0]?.parameters[0]?.key, "ROOT");
assert.equal(state.entries[1]?.installations[0]?.transport, "remote");
assert.equal(state.entries[1]?.installations[0]?.remoteProtocol, "sse");

// 编辑对话框的参数按行各为一个参数：含空格的路径打开-保存一轮后必须原样保留。
assert.deepEqual(parseArguments("-y\n/Users/me/My Documents"), ["-y", "/Users/me/My Documents"]);
assert.deepEqual(parseArguments("\n -y \n\nfilesystem-mcp \n"), ["-y", "filesystem-mcp"]);
// 单行输入保留空格分隔的兼容行为。
assert.deepEqual(parseArguments("-y filesystem-mcp"), ["-y", "filesystem-mcp"]);
assert.deepEqual(parseArguments(""), []);
assert.deepEqual(parseArguments("   \n\n"), []);

// 被删除或改名的持久化 env/headers key 必须显式 clear，否则主进程会保留旧值。
assert.deepEqual(toFieldMutations([], ["OLD_KEY"]), [{ key: "OLD_KEY", action: "clear" }]);
assert.deepEqual(
  toFieldMutations([{ key: "KEEP", value: "", action: "keep" }], ["KEEP", "GONE"]),
  [{ key: "KEEP", action: "keep" }, { key: "GONE", action: "clear" }]
);
assert.deepEqual(
  toFieldMutations([{ key: "RENAMED", value: "v", action: "set" }], ["OLD"]),
  [{ key: "RENAMED", action: "set", value: "v" }, { key: "OLD", action: "clear" }]
);
// 同名 key 重新填值时只发 set，不能同时出现 clear。
assert.deepEqual(
  toFieldMutations([{ key: "KEY", value: "v2", action: "set" }], ["KEY"]),
  [{ key: "KEY", action: "set", value: "v2" }]
);

// 剪贴板导入兼容部分客户端的 "type": "sse" 写法。
const sseByType = parseClipboardConfig({ mcpServers: { remote: { type: "sse", url: "https://example.com/mcp" } } });
assert.equal(sseByType?.transport, "remote");
assert.equal(sseByType?.remoteProtocol, "sse");
const sseByTransportProtocol = parseClipboardConfig({ mcpServers: { remote: { transportProtocol: "sse", url: "https://example.com/mcp" } } });
assert.equal(sseByTransportProtocol?.remoteProtocol, "sse");
const plainRemote = parseClipboardConfig({ mcpServers: { remote: { url: "https://example.com/mcp" } } });
assert.equal(plainRemote?.remoteProtocol, "streamable-http");

const connectingConfig = {
  ...defaultConfig,
  extensions: {
    ...defaultConfig.extensions,
    mcp: {
      delayed: {
        enabled: true,
        command: "delayed-mcp",
        args: [],
        cwd: ".",
        stderr: "ignore" as const
      }
    }
  }
};
const connectingService = new DesktopMcpService(
  { loadVersioned: async () => ({ config: structuredClone(connectingConfig), revision: "sha256:connecting" }) } as unknown as AgentConfigStore,
  projects as never,
  { ...agents, mcpStatuses: async () => [{ name: "delayed", command: "delayed-mcp", transport: "stdio" as const, enabled: true, connected: false, connecting: true, toolNames: [], promptNames: [], hasResources: false }] },
  async () => new Response(null, { status: 204 })
);
assert.equal((await connectingService.snapshot("project")).servers[0]?.state, "connecting");

console.log("desktop MCP service tests passed");
