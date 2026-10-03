import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createMcpResourceTools, McpToolHost } from "../src/extensions/mcp.js";
import { createMcpPromptTools } from "../src/extensions/mcpPrompts.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-exposure-"));
const accesses: string[] = [];
let listVersion = 0;
const reply = (response: ServerResponse, id: number, result: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
const server = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 204 : 405).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } };
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  const name = request.url?.slice(1) ?? "unknown";
  const id = message.id;
  if (message.method === "initialize") {
    reply(response, id, { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name, version: "1" }, instructions: name === "long" ? "文".repeat(5_000) : `${name} server instructions` });
  } else if (message.method === "tools/list") {
    reply(response, id, { tools: ["list", "list_private", "update", "hidden"].map((tool) => ({
      name: tool, description: `Use ${tool}${listVersion ? ` revision ${listVersion}` : ""}`, inputSchema: { type: "object" },
      annotations: { readOnlyHint: listVersion > 0 },
      outputSchema: { type: "object", properties: { records: { type: "array", items: { type: "object" } } } }
    })) });
  } else if (message.method === "resources/list") {
    accesses.push(`${name}/resources`);
    reply(response, id, { resources: [{ uri: `${name}://records`, name: "Records" }] });
  } else if (message.method === "prompts/list") {
    accesses.push(`${name}/prompts`);
    reply(response, id, { prompts: [{ name: "review" }] });
  } else if (message.method === "tools/call") {
    reply(response, id, { content: [
      { type: "text", text: "External error" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "resource", resource: { uri: "binary://records", mimeType: "application/octet-stream", blob: "AAAA" } }
    ], structuredContent: { records: [] }, isError: true });
  } else { reply(response, id, {}); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const serverConfig = (name: string, fields: Record<string, unknown> = {}) => ({ enabled: true, type: "http",
  url: `http://127.0.0.1:${address.port}/${name}`, transportProtocol: "streamable-http", timeoutMs: 5_000, ...fields });
const host = new McpToolHost();
const hiddenHost = new McpToolHost();
try {
  // Given configured exposure overrides; exact original names override wildcard rules.
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
    default: serverConfig("default"),
    policy: serverConfig("policy", { exposure: "codemode", toolExposure: { "list*": "direct", list_private: "hidden", update: "deferred" } }),
    hidden: serverConfig("hidden", { exposure: "hidden" }),
    long: serverConfig("long"),
  } } });
  await host.connectConfiguredServers(workspaceRoot, config);
  const tools = host.createTools();
  const find = (name: string) => { const tool = tools.find((entry) => entry.name === name); assert.ok(tool); return tool; };
  assert.equal(host.createTools().find((tool) => tool.name === "mcp_default_list"), find("mcp_default_list"), "An unchanged catalog must preserve MCP proxy identity");
  assert.equal(find("mcp_default_list").exposure, "deferred");
  assert.equal(find("mcp_policy_list").exposure, "direct");
  assert.equal(find("mcp_policy_list_private").exposure, "hidden");
  assert.equal(find("mcp_policy_update").exposure, "deferred");
  assert.equal(find("mcp_policy_hidden").exposure, "codemode");
  assert.equal(find("mcp_hidden_list").exposure, "hidden");
  assert.equal(find("mcp_policy_list").namespace?.name, "policy");
  assert.equal(find("mcp_policy_list").namespace?.instructions, "policy server instructions");
  assert.ok(Buffer.byteLength(find("mcp_long_list").namespace?.instructions ?? "", "utf8") <= 4_096);
  assert.deepEqual(find("mcp_default_list").outputSchema, { type: "object", properties: { records: { type: "array", items: { type: "object" } } } });
  const schema = find("mcp_default_list").outputSchema;
  assert.ok(schema);
  assert.throws(() => { schema.description = "Caller mutation"; }, TypeError, "Shared schema definitions are immutable");
  assert.equal(host.createTools().find((tool) => tool.name === "mcp_default_list")?.outputSchema?.description, undefined);
  assert.match(host.instructionsPrompt(), /policy server instructions/);
  assert.doesNotMatch(host.instructionsPrompt(), /default server instructions|hidden server instructions/);

  // Given model-facing resource/prompt wrappers; hidden namespaces do not leak through generic calls.
  accesses.length = 0;
  const resources = createMcpResourceTools(host);
  const prompts = createMcpPromptTools(host);
  assert.equal(createMcpResourceTools(host)[0], resources[0]);
  assert.equal(createMcpPromptTools(host)[0], prompts[0]);
  assert.equal(resources[0]?.exposure, "deferred", "A direct tool override does not expose that server's resources");
  assert.equal(resources[0]?.namespace?.name, "mcp:resources");
  assert.equal(prompts[0]?.namespace?.name, "mcp:prompts");
  const resourceList = await resources[0]!.resolveExecution({});
  assert.ok(!("isError" in resourceList));
  const listedResources = await resourceList.execute({ operationId: "resources", toolCallId: "resources" });
  assert.equal(JSON.stringify(listedResources).includes("hidden"), false);
  const promptList = await prompts[0]!.resolveExecution({});
  assert.ok(!("isError" in promptList));
  const listedPrompts = await promptList.execute({ operationId: "prompts", toolCallId: "prompts" });
  assert.equal(JSON.stringify(listedPrompts).includes("hidden"), false);
  for (const [tool, args] of [
    [resources[0]!, { server: "hidden" }], [resources[1]!, { server: "hidden", uri: "hidden://records" }],
    [prompts[0]!, { server: "hidden" }], [prompts[1]!, { server: "hidden", name: "review" }]
  ] as const) {
    const execution = await tool.resolveExecution(args);
    if ("isError" in execution) assert.match(execution.errorMessage, /hidden|not exposed/i);
    else await assert.rejects(execution.execute({ operationId: "hidden", toolCallId: "hidden" }), /hidden|not exposed/i);
  }
  assert.equal(accesses.some((entry) => entry.startsWith("hidden/")), false);

  // Script envelopes retain error and structured content while omitting binary payloads.
  const execution = await find("mcp_policy_list").resolveExecution({});
  assert.ok(!("isError" in execution));
  assert.deepEqual(await execution.execute({ operationId: "script", toolCallId: "script", mcpResultMode: "envelope" }), {
    content: [
      { type: "text", text: "External error" },
      { type: "image", mimeType: "image/png", bytes: 3, note: "binary content omitted" },
      { type: "resource", resource: { uri: "binary://records", mimeType: "application/octet-stream", bytes: 3, note: "binary content omitted" } }
    ], structuredContent: { records: [] }, isError: true
  });

  // An all-hidden configuration hides generic adapters as well as remote tool schemas.
  await hiddenHost.connectConfiguredServers(workspaceRoot, configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions,
    mcp: { hidden: serverConfig("hidden", { exposure: "hidden" }) } } }));
  assert.equal(createMcpResourceTools(hiddenHost).every((tool) => tool.exposure === "hidden"), true);
  assert.equal(createMcpPromptTools(hiddenHost).every((tool) => tool.exposure === "hidden"), true);
  assert.equal(hiddenHost.instructionsPrompt(), "");

  // A new client with unchanged metadata preserves identity; actual definition/policy changes revoke it.
  const original = find("mcp_default_list");
  await host.reconnectServer("default");
  assert.equal(host.createTools().find((tool) => tool.name === original.name), original);
  listVersion += 1;
  await host.reconnectServer("default");
  const changed = host.createTools().find((tool) => tool.name === original.name);
  assert.ok(changed);
  assert.notEqual(changed, original);
  assert.equal(changed.risk, "read");
  assert.match(changed.description, /revision 1/);
  assert.equal(host.createTools().find((tool) => tool.name === "mcp_policy_list"), find("mcp_policy_list"), "Unchanged server definitions retain their identity");
  config.extensions.mcp.default!.exposure = "direct";
  await host.reconnectServer("default");
  const reconfigured = host.createTools().find((tool) => tool.name === original.name);
  assert.notEqual(reconfigured, changed);
  assert.equal(reconfigured?.exposure, "direct");
  assert.notEqual(createMcpResourceTools(host)[0], resources[0]);
  assert.notEqual(createMcpPromptTools(host)[0], prompts[0]);
  assert.equal(createMcpResourceTools(host)[0]?.exposure, "direct");
} finally {
  await Promise.all([host.close(), hiddenHost.close()]);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(workspaceRoot, { recursive: true, force: true });
}
console.log("MCP tool exposure tests passed");
