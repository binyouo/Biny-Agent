import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GetPromptResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";

// Real Host/SDK request and result validation, with inert public transport methods.
// No external server, shell tool, provider, credential or user data is used.
const config = configSchema.parse({ ...defaultConfig, computer: { ...defaultConfig.computer, enabled: false }, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://inert-output-boundary.invalid/mcp", transportProtocol: "streamable-http", exposure: "direct" }
} } });
const sample = "a".repeat(65_533) + "😀" + "tail";
const instruction = "a".repeat(4_093) + "😀" + "tail";
const wellFormed = (value: string) => !/[\ud800-\udfff]/u.test(value);

async function withHost(run: (host: McpToolHost) => Promise<void>, text = sample, prompt?: GetPromptResult) {
  const host = new McpToolHost();
  const calls: Array<{ id: unknown; method: string }> = [];
  mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  mock.method(StreamableHTTPClientTransport.prototype, "start", async () => {});
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    assert.ok("method" in message);
    if (!("id" in message)) { assert.equal(message.method, "notifications/initialized"); return; }
    calls.push({ id: message.id, method: message.method });
    let result: Record<string, unknown>;
    if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "inert", version: "1" }, instructions: instruction };
    else if (message.method === "tools/list") result = { tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
    else if (message.method === "prompts/list") result = { prompts: [{ name: "sample" }] };
    else if (message.method === "resources/read") result = { contents: [{ uri: "fixture://resource", mimeType: "text/plain", text }] };
    else if (message.method === "prompts/get") result = prompt ?? { messages: [{ role: "user", content: { type: "text", text } }] };
    else if (message.method === "tools/call") result = { content: [{ type: "resource", resource: { uri: "fixture://resource", mimeType: "text/plain", text } }], isError: false };
    else throw new Error(`Unexpected request: ${message.method}`);
    this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) { this.onclose?.(); });
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    assert.equal(host.listServers()[0]?.connected, true);
    await run(host);
    assert.equal(new Set(calls.map(c => c.id)).size, calls.length, "request IDs stay unique");
  } finally { await host.close(); mock.restoreAll(); }
}

for (const mode of ["resource", "prompt", "direct-tool", "envelope-tool", "instructions"] as const) {
  await test(`MCP ${mode} clipping preserves Unicode scalar boundaries`, async () => {
    await withHost(async host => {
      let text: string;
      if (mode === "resource") {
        const result = await host.readServerResource("fixture", "fixture://resource") as { contents: Array<{ text: string }> };
        text = result.contents[0]!.text;
      } else if (mode === "prompt") {
        const result = await host.getServerPrompt("fixture", "sample") as { messages: Array<{ content: { text: string } }>; truncated: boolean };
        assert.equal(result.truncated, true);
        text = result.messages[0]!.content.text;
      } else if (mode === "direct-tool") {
        const result = await host.callServerTool("fixture", "read", {}) as { parts: Array<{ text: string }> };
        text = result.parts[0]!.text;
      } else if (mode === "envelope-tool") {
        const tool = host.createTools()[0]!;
        const plan = await tool.resolveExecution({});
        assert.ok("execute" in plan && plan.execute);
        const result = await plan.execute({ mcpResultMode: "envelope", toolCallId: "envelope-check", operationId: "envelope-operation" }) as { content: Array<{ resource: { text: string } }> };
        text = result.content[0]!.resource.text;
      } else text = host.createTools()[0]!.namespace!.instructions!;
      const budget = mode === "instructions" ? 4_096 : 65_536;
      assert.ok(Buffer.byteLength(text, "utf8") <= budget);
      assert.ok(!text.includes("tail"));
      assert.equal(text, "a".repeat(budget - 3), "omit the entire valid pair, not its high surrogate");
      assert.ok(wellFormed(text), `clipping created a lone surrogate: ${JSON.stringify(text.slice(-8))}`);
      assert.equal(Buffer.from(text).toString("utf8"), text, "UTF-8 conversion is lossless");
    });
  });
}

await test("MCP exact-boundary complete emoji, CJK and short-result controls", async () => {
  for (const source of ["a".repeat(65_532) + "😀", "中".repeat(21_845) + "a", "short 😀"]) {
    await withHost(async host => {
      const result = await host.readServerResource("fixture", "fixture://resource") as { contents: Array<{ text: string }> };
      assert.equal(result.contents[0]!.text, source);
      assert.ok(wellFormed(result.contents[0]!.text));
    }, source);
  }
});

await test("MCP preserves existing unpaired source units without introducing new ones", async () => {
  for (const source of ["a\ud800b", "a\udc00b", "a".repeat(65_533) + "\ud800tail", "a".repeat(65_533) + "\udc00tail"]) {
    await withHost(async host => {
      const result = await host.readServerResource("fixture", "fixture://resource") as { contents: Array<{ text: string }> };
      const expected = source.length < 65_533 ? source : source.slice(0, 65_534);
      assert.equal(result.contents[0]!.text, expected);
    }, source);
  }
});

await test("prompt clipping leaves unused UTF-8 bytes available to later messages", async () => {
  await withHost(async host => {
    const result = await host.getServerPrompt("fixture", "sample") as GetPromptResult & { truncated: boolean };
    assert.equal(result.description, "a".repeat(65_533));
    assert.deepEqual(result.messages, [
      { role: "user", content: { type: "text", text: "" } },
      { role: "assistant", content: { type: "text", text: "abc" } },
      { role: "user", content: { type: "text", text: "" } }
    ]);
    assert.equal(result.truncated, true);
  }, "unused", { description: "a".repeat(65_533), messages: [
    { role: "user", content: { type: "text", text: "😀" } },
    { role: "assistant", content: { type: "text", text: "abc" } },
    { role: "user", content: { type: "text", text: "later" } }
  ] });
});
