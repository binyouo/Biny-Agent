import assert from "node:assert/strict";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadResourceRequestSchema, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { McpToolHost, createMcpResourceTools } from "../src/extensions/mcp.js";

const limit = 64 * 1024;
const uri = "memo://fixture";
type ReadProjection = { server: string; uri: string; contents: Array<{ uri: string; mimeType?: string; text?: string; truncated?: boolean; bytes?: number; note?: string }> };
async function fixture(contents: ReadResourceResult["contents"], run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture(contents);
  try { await run(f); } finally { await f.host.close(); await f.server.close(); }
}
async function createFixture(contents: ReadResourceResult["contents"]) {
  let reads = 0;
  let fail = false;
  const original = structuredClone(contents);
  const server = new Server({ name: "resource-text-fixture", version: "1" }, { capabilities: { resources: {} } });
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    assert.equal(request.params.uri, uri);
    reads += 1;
    if (fail) throw new Error("resource read failed");
    return { contents: structuredClone(contents) };
  });
  const host = new McpToolHost();
  await host.attachLocalServer("fixture", "endpoint", undefined, async () => {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: () => server.close() };
  });
  const tool = createMcpResourceTools(host).find(item => item.name === "mcp_read_resource")!;
  const execution = await tool.resolveExecution({ server: "fixture", uri });
  assert.ok("execute" in execution);
  return {
    host, server, tool,
    get reads() { return reads; }, set fail(value: boolean) { fail = value; },
    async read(signal?: AbortSignal): Promise<ReadProjection> {
      const result = await execution.execute({ toolCallId: "call", operationId: "operation", signal });
      assert.deepEqual(contents, original, "projection must not mutate the server's source data");
      return result as ReadProjection;
    }
  };
}

for (const [name, source, expected] of [
  ["ASCII over limit", "A".repeat(limit) + "IMPORTANT END", "A".repeat(limit)],
  ["CJK with residual byte", "中".repeat(21846), "中".repeat(21845)],
  ["astral character crossing boundary", "A".repeat(limit - 1) + "😀", "A".repeat(limit - 1)],
  ["astral prefix at boundary", "😀".repeat(limit / 4) + "END", "😀".repeat(limit / 4)]
] as const) {
  test(`resource read discloses ${name} clipping`, async () => fixture([{ uri, mimeType: "text/plain", text: source }], async f => {
    const result = await f.read();
    assert.equal(result.server, "fixture"); assert.equal(result.uri, uri);
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0]!.text, expected);
    assert.ok(Buffer.byteLength(expected) <= limit);
    assert.equal(result.contents[0]!.truncated, true);
    assert.equal(JSON.parse(JSON.stringify(result)).contents[0].truncated, true, "flag survives ordinary tool-result serialization");
    assert.equal(f.reads, 1);
  }));
}

for (const [name, text] of [
  ["short", "resource data"], ["empty", ""], ["exact ASCII limit", "A".repeat(limit)],
  ["exact Unicode limit", "😀".repeat(limit / 4)], ["CJK below limit", "中".repeat(21845)]
] as const) {
  test(`resource read preserves ${name} shape and text`, async () => fixture([{ uri, mimeType: "text/plain", text }], async f => {
    assert.deepEqual(await f.read(), { server: "fixture", uri, contents: [{ uri, mimeType: "text/plain", text }] });
    assert.equal(f.reads, 1);
  }));
}

test("multiple resources report only the actually clipped text item", async () => {
  const contents = [{ uri, text: "short" }, { uri: "memo://long", text: "B".repeat(limit + 1) }, { uri: "memo://empty", text: "" }];
  await fixture(contents, async f => {
    const result = await f.read();
    assert.deepEqual(result.contents, [{ uri, text: "short", mimeType: undefined },
      { uri: "memo://long", text: "B".repeat(limit), mimeType: undefined, truncated: true },
      { uri: "memo://empty", text: "", mimeType: undefined }]);
    assert.equal(f.reads, 1);
  });
});

test("binary omission retains the existing note and byte estimate", async () => fixture([{ uri, mimeType: "application/octet-stream", blob: "QUJD" }], async f => {
  assert.deepEqual(await f.read(), { server: "fixture", uri, contents: [{ uri, mimeType: "application/octet-stream", bytes: 3, note: "binary content omitted" }] });
}));

test("no-content resource stays empty rather than reporting clipping", async () => fixture([], async f => {
  assert.deepEqual(await f.read(), { server: "fixture", uri, contents: [] });
}));

test("pre-aborted reads still make no resource RPC", async () => fixture([{ uri, text: "A".repeat(limit + 1) }], async f => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.read(controller.signal), { name: "AbortError" }); assert.equal(f.reads, 0);
}));

test("server failure remains an error, not a fabricated clipped resource", async () => fixture([{ uri, text: "A".repeat(limit + 1) }], async f => {
  f.fail = true;
  await assert.rejects(f.read(), /resource read failed/u); assert.equal(f.reads, 1);
}));

test("detached server cannot be read through a previously resolved resource tool", async () => fixture([{ uri, text: "A".repeat(limit + 1) }], async f => {
  await f.host.detachLocalServer("fixture");
  await assert.rejects(f.read()); assert.equal(f.reads, 0);
}));
