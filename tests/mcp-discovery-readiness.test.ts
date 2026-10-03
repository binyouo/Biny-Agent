import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { RuntimeHostResourceRegistry, RuntimeHostResourceScope } from "../src/runtime/host/resources.js";

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MCP discovery test exceeded 5 seconds")), 5_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-discovery-"));
const registry = new RuntimeHostResourceRegistry();
const held = new Map<string, () => void>();
const initializations = new Map<string, number>();
const entered = new Map<string, () => void>();
const waitForInitialize = (name: string): Promise<void> => new Promise((resolve) => { entered.set(name, resolve); });
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
  const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } };
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  const id = message.id;
  const name = request.url?.slice(1) ?? "unknown";
  if (message.method === "initialize") {
    initializations.set(name, (initializations.get(name) ?? 0) + 1);
    held.set(name, () => reply(response, id, {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name, version: "1" }, instructions: `Read ${name} records`
    }));
    entered.get(name)?.();
  } else if (message.method === "tools/list") {
    reply(response, id, { tools: [{ name: "list", description: "List records", inputSchema: { type: "object" } }] });
  } else if (message.method === "tools/call") {
    reply(response, id, {
      content: [{ type: "text", text: "Two records" }, { type: "resource_link", uri: "records://all", name: "Records" }],
      structuredContent: { records: [{ id: 1 }, { id: 2 }] }, isError: false
    });
  } else { reply(response, id, {}); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const mcpConfig = (names: string[]) => configSchema.parse({
  ...defaultConfig,
  extensions: { ...defaultConfig.extensions, mcp: Object.fromEntries(names.map((name) => [name, {
    enabled: true, type: "http", url: `http://127.0.0.1:${address.port}/${name}`, transportProtocol: "streamable-http", timeoutMs: 5_000
  }])) }
});

try {
  // Given shared startup with two pending servers; exact tool discovery waits only its namespace.
  const issuesEntered = waitForInitialize("issue-tracker");
  const docsEntered = waitForInitialize("docs");
  const config = mcpConfig(["issue-tracker", "docs"]);
  const scope = registry.acquire(workspaceRoot, config);
  const otherSession = registry.acquire(workspaceRoot, config);
  assert.equal(scope, otherSession);
  const cold = await withinDeadline(scope.waitForMcpDiscovery({ query: "mcp_issue-tracker_list" }));
  assert.deepEqual(cold.servers, [], "Discovery alone must not start connections");
  assert.equal(initializations.size, 0);
  const startup = scope.start();
  await withinDeadline(Promise.all([issuesEntered, docsEntered, scope.refreshSkills()]));
  assert.equal(scope.snapshot().state, "ready", "Ordinary readiness remains independent of MCP startup");
  const discovery = scope.waitForMcpDiscovery({ query: "mcp_issue-tracker_list" });
  held.get("issue-tracker")?.();
  held.delete("issue-tracker");
  const discovered = await withinDeadline(discovery);
  assert.deepEqual(discovered.servers.map((entry) => [entry.name, entry.connected]), [["issue-tracker", true]]);
  assert.deepEqual(discovered.pending, []);
  assert.equal(discovered.timedOut, false);
  assert.equal(scope.mcp.listServers().find((entry) => entry.name === "docs")?.connecting, true);
  assert.equal(scope.createTools().some((tool) => tool.name === "mcp_issue-tracker_list"), true, "Caller can refresh newly discovered schemas");
  assert.equal(initializations.get("issue-tracker"), 1, "Discovery must join the shared connection");
  const discoveredTool = scope.createTools().find((tool) => tool.name === "mcp_issue-tracker_list");
  assert.ok(discoveredTool);
  assert.equal(discoveredTool.exposure, "deferred");
  assert.equal(discoveredTool.namespace?.name, "issue-tracker");
  assert.equal(discoveredTool.namespace?.instructions, "Read issue-tracker records");
  const directExecution = await discoveredTool.resolveExecution({});
  assert.ok(!("isError" in directExecution));
  assert.deepEqual(await directExecution.execute({ operationId: "op_direct", toolCallId: "direct" }), { records: [{ id: 1 }, { id: 2 }] });
  const scriptExecution = await discoveredTool.resolveExecution({});
  assert.ok(!("isError" in scriptExecution));
  assert.deepEqual(await scriptExecution.execute({ operationId: "op_script", toolCallId: "script", mcpResultMode: "envelope" }), {
    content: [{ type: "text", text: "Two records" }, { type: "resource_link", uri: "records://all", name: "Records" }],
    structuredContent: { records: [{ id: 1 }, { id: 2 }] }, isError: false
  }, "Script callers need structured data and resource links in the same MCP envelope");

  // Given pending shared connection; cancelling one discovery does not cancel another session's startup.
  const abort = new AbortController();
  const cancelled = assert.rejects(scope.waitForMcpDiscovery({ query: "docs", signal: abort.signal }), { name: "AbortError" });
  abort.abort();
  await withinDeadline(cancelled);
  assert.equal(scope.mcp.listServers().find((entry) => entry.name === "docs")?.connecting, true);
  const broad = otherSession.waitForMcpDiscovery({ query: "Search notes and issues" });
  held.get("docs")?.();
  held.delete("docs");
  const all = await withinDeadline(broad);
  assert.equal(all.servers.length, 2);
  assert.equal(all.servers.every((entry) => entry.connected), true);
  assert.equal(initializations.get("docs"), 1);
  await withinDeadline(startup);
  await registry.release(scope);
  await registry.release(otherSession);

  // A failed real connection publishes its error before discovery reports it settled.
  const rejected = registry.acquire(workspaceRoot, configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions,
    mcp: { rejected: { enabled: true, command: path.join(workspaceRoot, "missing-command"), args: [], cwd: ".", stderr: "ignore" } }
  } }));
  const rejectedStartup = rejected.start();
  const rejectedDiscovery = await withinDeadline(rejected.waitForMcpDiscovery({ query: "rejected" }));
  assert.equal(rejectedDiscovery.servers[0]?.connected, false);
  assert.match(rejectedDiscovery.servers[0]?.lastError ?? "", /missing-command|ENOENT/);
  assert.deepEqual(rejectedDiscovery.pending, []);
  await withinDeadline(rejectedStartup);
  await registry.release(rejected);

  // Given one pending server; closure wakes its discovery before the shared handshake completes.
  const closingEntered = waitForInitialize("closing");
  const closing = registry.acquire(workspaceRoot, mcpConfig(["closing"]));
  const closingStartup = closing.start();
  await withinDeadline(closingEntered);
  const closedWait = assert.rejects(closing.waitForMcpDiscovery({ query: "closing.*" }), /resource scope.*closed/i);
  await withinDeadline(closing.close());
  await withinDeadline(closedWait);
  held.get("closing")?.();
  held.delete("closing");
  await withinDeadline(closingStartup);
  await registry.release(closing);

  // Given pending startup; the discovery hard cap returns useful status without cancelling it.
  const slow = new RuntimeHostResourceScope(workspaceRoot, mcpConfig(["slow"]));
  let finishConnection!: () => void;
  slow.mcp.connectConfiguredServers = () => new Promise<void>((resolve) => { finishConnection = resolve; });
  slow.mcp.listServers = () => [{ name: "slow", command: "unused", transport: "stdio", enabled: true,
    connected: false, connecting: true, toolNames: [], promptNames: [], hasResources: false }];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const starting = slow.start();
    const bounded = slow.waitForMcpDiscovery({ query: "mcp:slow" });
    mock.timers.tick(10_000);
    const expired = await bounded;
    assert.equal(expired.timedOut, true);
    assert.deepEqual(expired.pending, ["slow"]);
    assert.equal(expired.servers[0]?.connecting, true);
    assert.equal(slow.snapshot().mcp.pending, true);
    finishConnection();
    await starting;
  } finally {
    mock.timers.reset();
    await slow.close();
  }

  // Failed and disabled servers are already settled; discovery does not reconnect them.
  const settled = new RuntimeHostResourceScope(workspaceRoot, defaultConfig);
  settled.mcp.listServers = () => [
    { name: "failed", command: "unused", transport: "stdio", enabled: true, connected: false, connecting: false,
      toolNames: [], promptNames: [], hasResources: false, lastError: "connection rejected" },
    { name: "disabled", command: "unused", transport: "stdio", enabled: false, connected: false, connecting: false,
      toolNames: [], promptNames: [], hasResources: false }
  ];
  const failed = await withinDeadline(settled.waitForMcpDiscovery({ query: "failed" }));
  assert.equal(failed.servers[0]?.lastError, "connection rejected");
  assert.deepEqual(failed.pending, []);
  assert.equal(failed.timedOut, false);
  const disabled = await withinDeadline(settled.waitForMcpDiscovery({ query: "disabled" }));
  assert.equal(disabled.servers[0]?.enabled, false);
  assert.deepEqual(disabled.pending, []);
  await settled.close();

  // Fully hidden servers do not hold semantic discovery; a visible tool override still does.
  const filtered = new RuntimeHostResourceScope(workspaceRoot, configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions,
    mcp: {
      hidden: { enabled: true, command: "unused", exposure: "hidden" },
      visible: { enabled: true, command: "unused", exposure: "hidden", toolExposure: { list: "deferred" } }
    }
  } }));
  filtered.mcp.listServers = () => ["hidden", "visible"].map((name) => ({ name, command: "unused", transport: "stdio", enabled: true,
    connected: false, connecting: true, toolNames: [], promptNames: [], hasResources: false }));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hiddenWait = filtered.waitForMcpDiscovery({ query: "hidden" });
    mock.timers.tick(10_000);
    assert.deepEqual((await hiddenWait).servers, [], "An explicit hidden namespace must not wait for unrelated visible servers");
    const wait = filtered.waitForMcpDiscovery({ query: "Search available records" });
    mock.timers.tick(10_000);
    const result = await wait;
    assert.deepEqual(result.pending, ["visible"]);
    assert.deepEqual(result.servers.map((entry) => entry.name), ["visible"]);
  } finally {
    mock.timers.reset();
    await filtered.close();
  }

  // Prefer the longest normalized server prefix, keeping normalization collisions visible.
  const prefixes = new RuntimeHostResourceScope(workspaceRoot, defaultConfig);
  prefixes.mcp.listServers = () => ["records", "records_db", "alpha++beta", "alpha beta"].map((name) => ({ name, command: "unused", transport: "stdio",
    enabled: true, connected: true, connecting: false, toolNames: [], promptNames: [], hasResources: false }));
  assert.deepEqual((await prefixes.waitForMcpDiscovery({ query: "mcp_records_db_list" })).servers.map((entry) => entry.name), ["records_db"]);
  assert.deepEqual((await prefixes.waitForMcpDiscovery({ query: "mcp_alpha_beta_list" })).servers.map((entry) => entry.name), ["alpha++beta", "alpha beta"]);
  await prefixes.close();
} finally {
  for (const finish of held.values()) finish();
  held.clear();
  mock.timers.reset();
  await registry.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(workspaceRoot, { recursive: true, force: true });
}
console.log("MCP discovery readiness tests passed");
