import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { readSessionEvents } from "../src/session/events.js";
import { readToolResultArchive } from "../src/session/toolResultArchive.js";
import { ToolRegistry } from "../src/tools/registry.js";

// Given an authenticated local server with opaque business values and reflected credentials.
const credential = "fixture-actual-connection-credential";
const bearer = "fixture-actual-bearer-credential";
const cookie = "fixture-actual-cookie-credential";
const basicPassword = "fixture-basic-password";
const queryCredential = "fixture-query-credential";
const cursor = "eyJhbGciOiJIUzI1NiJ9.eyJwYWdlIjoyfQ.fixtureSignature";
const payload = {
  nextPageToken: cursor,
  records: [{ token: "business-token", nextPageToken: cursor, password: "password field documentation" }],
  metadata: { accessToken: "business-access-value", apiKey: "apiKey field documentation" },
  text: "token=ordinary-example; Bearer ordinary-example; sk-ordinaryExample12345",
  reflected: `received ${credential} ${bearer} ${cookie} ${basicPassword} ${queryCredential}`,
  [`reflected-${credential}`]: credential
};
const expected = {
  ...payload, reflected: "received [redacted] [redacted] [redacted] [redacted] [redacted]", [`reflected-${credential}`]: undefined,
  "reflected-[redacted]": "[redacted]"
};
delete expected[`reflected-${credential}`];
function assertPage(value: Record<string, unknown>): void {
  const body = { ...value };
  delete body.durationMs;
  delete body.truncated;
  assert.deepEqual(body, expected);
}
let calls = 0;
const reply = (response: ServerResponse, id: unknown, result: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
const server = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 204 : 405).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { name?: string; protocolVersion?: string; arguments?: { pageToken?: string } } };
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  assert.equal(request.headers["x-api-key"], credential);
  if (message.method === "initialize") reply(response, message.id, {
    protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "privacy-fixture", version: "1" }
  });
  else if (message.method === "tools/list") reply(response, message.id, { tools: [{ name: "list", inputSchema: { type: "object", properties: { pageToken: { type: "string" } } } }] });
  else if (message.method === "tools/call") {
    if (message.params?.name === "fail") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `failed ${credential} ${bearer}`, data: { cause: cookie } } }));
      return;
    }
    calls += 1;
    if (message.params?.arguments?.pageToken) assert.equal(message.params.arguments.pageToken, cursor);
    reply(response, message.id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
  } else if (message.method === "resources/read") reply(response, message.id, { contents: [{ uri: "fixture://result", text: JSON.stringify(payload) }] });
  else if (message.method === "prompts/get") reply(response, message.id, { messages: [{ role: "user", content: { type: "text", text: JSON.stringify(payload) } }] });
  else if (message.method === "resources/list") reply(response, message.id, { resources: [] });
  else if (message.method === "prompts/list") reply(response, message.id, { prompts: [] });
  else reply(response, message.id, {});
});
const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-result-privacy-"));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access" },
  extensions: { ...defaultConfig.extensions, mcp: { fixture: { enabled: true, exposure: "direct", type: "http",
    url: `http://127.0.0.1:${address.port}/mcp?api_key=${queryCredential}`, transportProtocol: "streamable-http",
    headers: { "X-Api-Key": credential, Authorization: `Bearer ${bearer}`, Cookie: `session=${cookie}`,
      "Proxy-Authorization": `Basic ${Buffer.from(`fixture:${basicPassword}`).toString("base64")}` }, timeoutMs: 2_000 } } }
});
const host = new McpToolHost();
let authority: RuntimeEventAuthority | undefined;
let capabilities: CapabilityStore | undefined;
try {
  await host.connectConfiguredServers(root, config);
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  capabilities = await CapabilityStore.open(root, authority);
  for (const ledger of [false, true]) for (const script of [false, true]) {
    const registry = new ToolRegistry();
    for (const tool of host.createTools()) registry.registerMcpTool(tool);
    const recorder = new SessionRecorder(root, `privacy-${String(ledger)}-${String(script)}`);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
      capabilities: ledger ? capabilities : undefined }, new PermissionManager(config.permission), () => undefined);
    try {
      const tool = coordinator.createAgentTools(undefined, { script }).find((entry) => entry.name === "mcp_fixture_list");
      assert.ok(tool);
      const first = await tool.execute("first", {});
      const text = first.content.find((part) => part.type === "text");
      assert.ok(text?.type === "text");
      const result = JSON.parse(text.text);
      const page = script ? result.structuredContent : result;
      // Then business fields survive transport, ledger, model serialization and replay.
      assertPage(page);
      if (script) assert.deepEqual(JSON.parse(result.content[0].text), expected);
      await tool.execute("second", { pageToken: page.records[0].nextPageToken });
      const events = await readSessionEvents(recorder.filePath);
      assert.ok(events.some((event) => event.type === "tool_call"));
      const restored = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.find((message) => message.role === "toolResult" && message.toolCallId === "first");
      assert.ok(restored?.role === "toolResult");
      const restoredText = restored.content.find((part) => part.type === "text");
      assert.ok(restoredText?.type === "text");
      const restoredResult = JSON.parse(restoredText.text);
      assertPage(script ? restoredResult.structuredContent : restoredResult);
      assert.ok(!(await readFile(recorder.filePath, "utf8")).includes(credential));
    } finally { await coordinator.waitForIdle(); await recorder.close(); }
  }
  const archiveConfig = structuredClone(config);
  archiveConfig.context.maxTurnToolResultBytes = 1;
  const registry = new ToolRegistry();
  for (const tool of host.createTools()) registry.registerMcpTool(tool);
  const recorder = new SessionRecorder(root, "privacy-archive");
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config: archiveConfig, recorder, toolRegistry: registry, capabilities },
    new PermissionManager(config.permission), () => undefined);
  try {
    const tool = coordinator.createAgentTools().find((entry) => entry.name === "mcp_fixture_list");
    assert.ok(tool);
    const result = await tool.execute("archive", {});
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text?.type === "text");
    const envelope = JSON.parse(text.text);
    assert.equal(envelope.archived, true);
    assertPage(JSON.parse((await readToolResultArchive(root, envelope.archivePath)).output));
  } finally { await coordinator.waitForIdle(); await recorder.close(); }
  assert.equal(calls, 9);
  const resource = await host.readServerResource("fixture", "fixture://result") as { contents: Array<{ text: string }> };
  assertPage(JSON.parse(resource.contents[0]!.text));
  const prompt = await host.getServerPrompt("fixture", "fixture") as { messages: Array<{ content: { text: string } }> };
  assertPage(JSON.parse(prompt.messages[0]!.content.text));
  await assert.rejects(host.callServerTool("fixture", "fail", {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /failed \[redacted\] \[redacted\]/u);
    assert.ok(!JSON.stringify(error).includes(credential));
    assert.ok(!JSON.stringify(error).includes(cookie));
    assert.equal(error.cause, undefined);
    return true;
  });

  // A real stdio server echoes env, referenced env and flag credentials.
  const fixturePath = path.join(root, "stdio-fixture.mjs");
  await writeFile(fixturePath, `import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
    : { content: [{ type: "text", text: JSON.stringify({ token: "business-value", body: [process.env.API_KEY, process.env.VALUE, process.argv.at(-1)].join(" ") }) }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});`);
  const stdioConfig = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { fixture: {
    command: process.execPath, args: [fixturePath, "--token", "fixture-arg-credential"], cwd: ".",
    env: { API_KEY: "fixture-env-credential", VALUE: "fixture-referenced-credential", NODE_ENV: "test" },
    credentialRefs: { env: { VALUE: "fixture-account" } }, timeoutMs: 2_000
  } } } });
  const stdioHost = new McpToolHost();
  try {
    await stdioHost.connectConfiguredServers(root, stdioConfig);
    assert.deepEqual(JSON.parse(await stdioHost.callServerTool("fixture", "echo", {}) as string), { token: "business-value", body: "[redacted] [redacted] [redacted]" });
  } finally { await stdioHost.close(); }
} finally {
  capabilities?.close(); authority?.close(); await host.close(); server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
console.log("MCP result privacy tests passed (real HTTP, direct/script, ledger, replay and archive)");
