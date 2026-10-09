import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { workspaceAgentDir } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Only the SDK transport boundary is replaced, following mcp-connection-lifetimes.
// Production Client, McpToolHost, resource ownership and runtime factory all run.
// No server, socket, child process, provider request or real user state is needed.
function fakeMcpServer(context: TestContext) {
  const toolsListed = deferred();
  const transports = new Map<StreamableHTTPClientTransport, number>();
  const state = { starts: 0, closes: 0, requests: [] as string[] };
  context.mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    state.starts += 1;
    transports.set(this, 0);
  });
  context.mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    state.requests.push(message.method);
    if (message.method === "initialize") {
      this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "startup-cleanup-fixture", version: "1" }
      } });
    } else if (message.method === "tools/list") {
      this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "echo", inputSchema: { type: "object" } }
      ] } });
      toolsListed.resolve();
    } else {
      throw new Error(`Unexpected MCP fixture request: ${message.method}`);
    }
  });
  context.mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    state.closes += 1;
    transports.set(this, (transports.get(this) ?? 0) + 1);
    this.onclose?.();
  });
  return {
    state,
    toolsListed: toolsListed.promise,
    async cleanup(): Promise<void> {
      // The baseline intentionally fails its cleanup assertion. Release only
      // leftover fake transports after observing the production close count.
      for (const [transport, closes] of transports) if (closes === 0) await transport.close();
    }
  };
}

for (const ownership of ["private", "shared registry"] as const) {
  await test(`runtime startup directory failure releases its ${ownership} MCP ownership`, { timeout: 10_000 }, async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-runtime-startup-cleanup-"));
    const workspaceRoot = path.join(root, "workspace");
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    context.mock.method(os, "homedir", () => path.join(root, "home"));
    const fake = fakeMcpServer(context);
    const registry = ownership === "shared registry" ? new RuntimeHostResourceRegistry() : undefined;
    let runtime: CommandRuntime | undefined;
    try {
      await fs.mkdir(workspaceRoot);
      const config = configSchema.parse({
        ...defaultConfig,
        checkpoints: { ...defaultConfig.checkpoints, enabled: false },
        extensions: { ...defaultConfig.extensions, mcp: {
          fixture: { enabled: true, type: "http", url: "https://runtime-startup-cleanup.invalid/mcp",
            transportProtocol: "streamable-http", timeoutMs: 2_000 }
        } }
      });
      const configStore: AgentConfigStore = {
        load: async () => config,
        save: async () => { throw new Error("Startup cleanup test must not save config."); }
      };
      const blockedDirectory = path.join(workspaceAgentDir(workspaceRoot), "processes");
      await fs.mkdir(path.dirname(blockedDirectory), { recursive: true });
      await fs.writeFile(blockedDirectory, "ordinary file, not a runtime directory\n");
      const originalLstat = fs.lstat;
      let delayedDirectoryReads = 0;
      context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === blockedDirectory) {
          delayedDirectoryReads += 1;
          // Keep the real filesystem result and original directory validation;
          // only sequence this failure after the fake MCP handshake/tools list.
          await fake.toolsListed;
        }
        return await originalLstat(...args);
      });
      const legitimateOwner = registry?.acquire(workspaceRoot, config);
      let startupError: unknown;
      await assert.rejects(async () => {
        runtime = await createCommandRuntime(workspaceRoot, { configStore, resourceRegistry: registry });
      }, (error: unknown) => {
        startupError = error;
        return error instanceof Error
          && error.message === "Session storage workspace runtime/processes must be a real directory, not a symbolic link."
          && error.stack?.includes("ensureRealDirectory") === true;
      });
      assert.equal(runtime, undefined, "a rejected factory exposes no runtime for the caller to close");
      assert.equal(delayedDirectoryReads, 1);
      assert.deepEqual(fake.state.requests, ["initialize", "tools/list"]);
      assert.equal(fake.state.starts, 1);
      if (registry && legitimateOwner) {
        await legitimateOwner.start();
        assert.equal(legitimateOwner.mcp.listServers()[0]?.connected, true);
        assert.equal(fake.state.closes, 0, "failed startup must not close another owner's shared connection");
        await registry.release(legitimateOwner);
      }
      context.diagnostic(JSON.stringify({
        ownership,
        startupError: startupError instanceof Error ? startupError.message : String(startupError),
        runtimeReturned: runtime !== undefined,
        delayedDirectoryReads,
        startedTransports: fake.state.starts,
        transportCloseCallsBeforeManualCleanup: fake.state.closes,
        expectedTransportCloseCalls: 1,
        requests: fake.state.requests
      }));
      assert.equal(fake.state.closes, 1, ownership === "private"
        ? "failed runtime startup must close its private MCP connection exactly once"
        : "failed runtime startup must release its retain so the last legitimate owner closes MCP exactly once");
    } finally {
      await runtime?.close();
      await registry?.close();
      await fake.cleanup();
      context.mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
