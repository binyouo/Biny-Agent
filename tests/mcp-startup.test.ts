import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-startup-"));
const registry = new RuntimeHostResourceRegistry();
const held: Array<() => void> = [];
let initializationCount = 0;
let callCount = 0;
let releaseConnections = false;
let initialized!: () => void;
const firstInitialize = new Promise<void>((resolve) => { initialized = resolve; });
async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MCP startup test exceeded 5 seconds")), 5_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const reply = (response: ServerResponse, id: number, result: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(request.method === "DELETE" ? 204 : 405).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString()) as {
    id?: number; method: string; params?: { protocolVersion?: string };
  };
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const id = message.id;
  if (message.method === "initialize") {
    initializationCount += 1;
    const finish = (): void => reply(response, id, {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "startup-test", version: "1" }
    });
    if (releaseConnections) finish();
    else held.push(finish);
    initialized();
  } else if (message.method === "tools/list") {
    reply(response, id, { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
  } else if (message.method === "tools/call") {
    callCount += 1;
    reply(response, id, { content: [{ type: "text", text: "connected" }] });
  } else {
    reply(response, id, {});
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const config = configSchema.parse({
  ...defaultConfig,
  extensions: { ...defaultConfig.extensions, mcp: {
    slow: { enabled: true, type: "http", url: `http://127.0.0.1:${address.port}/mcp`, transportProtocol: "streamable-http", timeoutMs: 2_000 },
    broken: { enabled: true, command: path.join(workspaceRoot, "missing-command"), args: [], cwd: ".", stderr: "ignore" }
  } }
});

try {
  const scope = registry.acquire(workspaceRoot, config);
  const otherSession = registry.acquire(workspaceRoot, config);
  assert.equal(scope, otherSession);
  const startup = scope.start();
  const failed = new Promise<void>((resolve) => {
    const unsubscribe = scope.subscribe((snapshot) => {
      if (!snapshot.mcp.servers.find((entry) => entry.name === "broken")?.lastError) return;
      unsubscribe();
      resolve();
    });
  });
  await withinDeadline(Promise.all([firstInitialize, failed, scope.refreshSkills()]));
  assert.equal(scope.snapshot().state, "degraded", "一个服务失败不能被另一个服务仍在首连掩盖");
  assert.equal(scope.snapshot().mcp.pending, true);
  assert.equal(scope.createTools().length, 0);
  const reconnect = scope.mcp.reconnectServer("slow");
  releaseConnections = true;
  for (const finish of held.splice(0)) finish();
  await withinDeadline(startup);
  assert.equal((await withinDeadline(reconnect)).connected, true);
  assert.equal(initializationCount, 1, "首连期间主动重连必须加入原连接，不能再派发 initialize");
  assert.equal(scope.snapshot().mcp.pending, false);
  assert.equal(scope.snapshot().state, "degraded", "慢服务成功后仍保留另一服务的失败");
  assert.equal(scope.createTools()[0]?.name, "mcp_slow_echo");
  assert.equal(otherSession.createTools()[0]?.name, "mcp_slow_echo");
  const otherWorkspace = registry.acquire(path.join(workspaceRoot, "nested"), config);
  assert.notEqual(otherWorkspace, scope, "连接不能跨工作目录共享");
  await registry.release(otherWorkspace);
  await registry.release(scope);
  assert.equal(otherSession.mcp.listServers().find((entry) => entry.name === "slow")?.connected, true);
  assert.equal(await withinDeadline(otherSession.mcp.callServerTool("slow", "echo", {})), "connected");
  assert.equal(callCount, 1);
  await registry.release(otherSession);
} finally {
  releaseConnections = true;
  for (const finish of held.splice(0)) finish();
  await registry.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("MCP startup tests passed");
