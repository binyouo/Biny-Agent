import assert from "node:assert/strict";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpToolHost } from "../src/extensions/mcp.js";

const limit = 64 * 1024;
const uri = "memo://fixture";
const pipelines = ["direct", "envelope-regular", "envelope-script"] as const;
type Pipeline = typeof pipelines[number];
type Projection = { content?: Array<{ type: string; resource?: { uri: string; text?: string; truncated?: boolean; [key: string]: unknown }; [key: string]: unknown }>; parts?: Array<{ type: string; text?: string; truncated?: boolean; [key: string]: unknown }>; error?: boolean };
function part(value: unknown) {
  const projected = value as Projection;
  return projected.content?.[0]?.resource ?? projected.parts?.[0];
}
function textResult(text: string): CallToolResult {
  return { content: [{ type: "resource", resource: { uri, mimeType: "text/plain", text } }] };
}
async function fixture(response: CallToolResult, run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture(response);
  try { await run(f); } finally { await f.host.close(); await f.server.close(); }
}
async function createFixture(response: CallToolResult) {
  let calls = 0;
  const original = structuredClone(response);
  const server = new Server({ name: "embedded-resource-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => { calls += 1; return structuredClone(response); });
  const host = new McpToolHost();
  await host.attachLocalServer("fixture", "endpoint", undefined, async () => {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: () => server.close() };
  });
  const proxy = host.createTools()[0]!;
  const execution = await proxy.resolveExecution({});
  assert.ok("execute" in execution); assert.ok(execution.interpretResult);
  const interpret = execution.interpretResult;
  return {
    host, server, interpret,
    get calls() { return calls; },
    async invoke(pipeline: Pipeline) {
      const output = await execution.execute({ toolCallId: "call", operationId: "operation", mcpResultMode: pipeline === "direct" ? undefined : "envelope" });
      const interpreted = interpret(output, { script: pipeline === "envelope-script" });
      assert.deepEqual(response, original, "the remote source response is not rewritten");
      return { output, interpreted };
    }
  };
}

for (const pipeline of pipelines) {
  for (const [name, source, prefix] of [
    ["ASCII", "A".repeat(limit) + "IMPORTANT END", "A".repeat(limit)],
    ["Unicode residual bytes", "中".repeat(21846), "中".repeat(21845)]
  ] as const) {
    test(`${pipeline}: discloses clipped ${name} in execution and interpretation`, async () => fixture(textResult(source), async f => {
      const { output, interpreted } = await f.invoke(pipeline);
      assert.equal(part(output)!.text, prefix); assert.equal(part(interpreted.result)!.text, prefix);
      assert.equal(part(output)!.truncated, true); assert.equal(part(interpreted.result)!.truncated, true);
      assert.equal(part(JSON.parse(JSON.stringify(interpreted.result)))!.truncated, true);
      assert.equal(f.calls, 1);
    }));
  }
  for (const [name, text] of [["short", "complete"], ["empty", ""], ["exact Unicode budget", "😀".repeat(limit / 4)]] as const) {
    test(`${pipeline}: keeps ${name} content and prior shape`, async () => fixture(textResult(text), async f => {
      const { output, interpreted } = await f.invoke(pipeline);
      const normal = { parts: [{ type: "resource", uri, mimeType: "text/plain", text }] };
      const envelope = textResult(text);
      assert.deepEqual(output, pipeline === "direct" ? normal : envelope);
      assert.deepEqual(interpreted.result, pipeline === "envelope-script" ? envelope : normal);
      assert.equal(f.calls, 1);
    }));
  }
}

test("regular interpretation preserves an already established clipping flag without clipping again", async () => fixture(textResult("short prefix"), async f => {
  const { output } = await f.invoke("envelope-script");
  // Explicit intermediate-projection control: this flag is staged locally,
  // not represented as evidence of a remote server sending this metadata.
  const staged = structuredClone(output) as Projection;
  staged.content![0]!.resource!.truncated = true;
  const original = structuredClone(staged);
  const interpreted = f.interpret(staged, { script: false });
  assert.equal(part(interpreted.result)!.text, "short prefix"); assert.equal(part(interpreted.result)!.truncated, true);
  assert.deepEqual(staged, original); assert.equal(f.calls, 1);
}));

test("binary resource omission stays unchanged", async () => fixture({ content: [{ type: "resource", resource: { uri, mimeType: "application/octet-stream", blob: "QUJD" } }] }, async f => {
  const { output, interpreted } = await f.invoke("envelope-script");
  const expected = { content: [{ type: "resource", resource: { uri, mimeType: "application/octet-stream", bytes: 3, note: "binary content omitted" } }] };
  assert.deepEqual(output, expected); assert.deepEqual(interpreted.result, expected); assert.equal(f.calls, 1);
}));

test("mixed contents flag only the clipped resource and keep ordinary text intact", async () => {
  const response: CallToolResult = { content: [
    { type: "text", text: "heading" },
    { type: "resource", resource: { uri, text: "X".repeat(limit + 1) } },
    { type: "resource", resource: { uri: "memo://short", text: "short" } }
  ] };
  await fixture(response, async f => {
    const { output, interpreted } = await f.invoke("envelope-regular");
    assert.deepEqual((output as Projection).content![0], response.content[0]);
    assert.equal((output as Projection).content![1]!.resource!.truncated, true);
    assert.equal((output as Projection).content![2]!.resource!.truncated, undefined);
    assert.deepEqual(interpreted.result, { parts: [{ type: "text", text: "heading" },
      { type: "resource", uri, mimeType: undefined, text: "X".repeat(limit), truncated: true },
      { type: "resource", uri: "memo://short", mimeType: undefined, text: "short" }] });
    assert.equal(f.calls, 1);
  });
});

test("error envelopes retain error status as well as clipped resource evidence", async () => fixture({ ...textResult("E".repeat(limit + 1)), isError: true }, async f => {
  const { interpreted } = await f.invoke("envelope-regular");
  assert.equal((interpreted.result as Projection).error, true); assert.equal(part(interpreted.result)!.truncated, true);
  assert.equal(interpreted.errorMessage, "MCP tool returned isError."); assert.equal(f.calls, 1);
}));

test("structured content keeps its existing ordinary-result precedence", async () => fixture({ ...textResult("S".repeat(limit + 1)), structuredContent: { value: "business result" } }, async f => {
  const { interpreted } = await f.invoke("envelope-regular");
  assert.deepEqual(interpreted.result, { value: "business result" }); assert.equal(f.calls, 1);
}));

test("false intermediate flag cannot hide newly clipped text", async () => fixture(textResult("short"), async f => {
  const { output } = await f.invoke("envelope-script");
  const staged = structuredClone(output) as Projection;
  staged.content![0]!.resource!.text = "F".repeat(limit + 1);
  staged.content![0]!.resource!.truncated = false;
  const interpreted = f.interpret(staged, { script: false });
  assert.equal(part(interpreted.result)!.text, "F".repeat(limit)); assert.equal(part(interpreted.result)!.truncated, true);
  assert.equal(f.calls, 1);
}));

test("ordinary text parts are not subjected to the embedded-resource budget", async () => {
  const text = "T".repeat(limit + 1);
  await fixture({ content: [{ type: "text", text }] }, async f => {
    const { output, interpreted } = await f.invoke("envelope-regular");
    assert.deepEqual(output, { content: [{ type: "text", text }] }); assert.equal(interpreted.result, text); assert.equal(f.calls, 1);
  });
});
