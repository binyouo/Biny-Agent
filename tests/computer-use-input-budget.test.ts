import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { startComputerUseHttpServer } from "../src/computer/httpMcpServer.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { computerSequenceSchema } from "../src/computer/protocol.js";

const budgetError = /arguments contain more than the maximum of 256 elements/u;
const textOf = (result: { content?: unknown }): string =>
  (result.content as { type: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text).join("\n");

// Exercise the production factory with the real SDK. The test-only schema probe
// observes validation entry, not an SDK mock or a resource-exhaustion attempt.
for (const [label, payload] of [
  ["array", (size: number) => ({ payload: Array(size - 1).fill(null) })],
  ["record", (size: number) => ({ payload: Object.fromEntries(Array.from({ length: size - 1 }, (_, index) => [`k${index}`, null])) })],
  ["nested", (size: number) => ({ payload: { groups: [{ values: Array(size - 4).fill(null) }] } })]
] as const) {
  test(`computer MCP bounds ${label} elements before tool schema validation`, { timeout: 10_000 }, async () => {
    const driver = new NativeProcessDriver(() => undefined);
    const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "input-budget-probe", version: "1" });
    let validated = 0;
    let dispatched = 0;
    server.registerTool("budget_probe", {
      inputSchema: { payload: z.preprocess(value => { validated++; return value; }, z.unknown()) }
    }, async () => { dispatched++; return { content: [{ type: "text", text: "accepted" }] }; });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const oversized = payload(257);
      assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < 4_096, "keep the regression small and bounded");
      const rejected = await client.callTool({ name: "budget_probe", arguments: oversized });
      assert.equal(validated, 0, "reject before entering the tool's Zod schema");
      assert.equal(dispatched, 0, "reject before dispatching the tool callback");
      assert.equal(rejected.isError, true);
      assert.match(textOf(rejected), budgetError);
      for (const size of [255, 256]) {
        const accepted = await client.callTool({ name: "budget_probe", arguments: payload(size) });
        assert.notEqual(accepted.isError, true, textOf(accepted));
        assert.equal(textOf(accepted), "accepted");
      }
      assert.equal(validated, 2);
      assert.equal(dispatched, 2, "the session remains usable after rejection");
    } finally {
      await client.close();
      await server.close();
      await driver.dispose();
    }
  });
}

test("authenticated HTTP MCP rejects small over-budget arguments while preserving real tool calls", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-input-budget-"));
  const policyCalls: string[] = [];
  const nativeCalls: string[] = [];
  class Driver extends NativeProcessDriver {
    override async observeRaw() { nativeCalls.push("observe"); return { data: { pid: 42, elements: [] }, images: [] }; }
    override async actRaw(action: string) { nativeCalls.push(action); return { data: { effect: "completed" }, images: [] }; }
    override async capturePreview() { return { data: {}, images: [] }; }
    override detach() { /* No native process is started by this fixture. */ }
  }
  const server = await startComputerUseHttpServer({
    tokenPath: path.join(directory, "token"),
    createDriver: () => new Driver(() => undefined),
    createPolicy: () => ({ run: async (tool, _args, operation) => { policyCalls.push(tool); return await operation(); } })
  });
  const client = new Client({ name: "http-input-budget", version: "1" });
  const headers = { Authorization: `Bearer ${await readFile(server.tokenPath, "utf8")}` };
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === "sequence"));
    const target = { pid: 42, windowId: "7", captureId: "fixture-observation" };
    for (const arguments_ of [
      { ...target, actions: Array(256).fill({}) },
      { ...target, actions: [{ action: "type_text", text: "safe", extra: { nested: Array(256).fill(null) } }] },
      { ...target, actions: [{ action: "press_key", key: "Return", extra: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`k${index}`, null])) }] }
    ]) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sequence", arguments: arguments_ } });
      assert.ok(Buffer.byteLength(body) < 4_096, "the existing 1 MiB body limit cannot explain this rejection");
      const rejected = await client.callTool({ name: "sequence", arguments: arguments_ });
      assert.equal(rejected.isError, true);
      assert.match(textOf(rejected), budgetError);
      assert.deepEqual(policyCalls, [], "over-budget input must not reach policy or dispatch");
      assert.deepEqual(nativeCalls, []);
    }

    // Element count does not replace schema validation for a small invalid call.
    const invalid = await client.callTool({ name: "sequence", arguments: { ...target, actions: Array(6).fill({ action: "press_key", key: "Return" }) } });
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /Too big: expected array to have <=5 items at actions/u);
    assert.doesNotMatch(textOf(invalid), budgetError);
    assert.deepEqual(policyCalls, []);
    assert.deepEqual(nativeCalls, [], "invalid sequence must not reach native dispatch");

    // All declared sequence fields fit: 4 root keys + 5 array entries +
    // 5 * 26 scalar action fields = 139, including mutually exclusive fields.
    const shape = computerSequenceSchema.shape;
    assert.equal(Object.keys(shape).length + 5 + 5 * Object.keys(shape.actions.element.shape).length, 139);
    const step = {
      action: "type_text", showCursor: false, inputMethod: "physical", button: "left", clickCount: 1,
      strategy: "auto", coordinateSpace: "screenshot", x: 1, y: 1, text: "x".repeat(4_000), key: "Return",
      direction: "down", pages: 1, x1: 1, y1: 1, x2: 2, y2: 2, value: "x", location: 0, length: 1
    };
    const sequence = { ...target, actions: [
      { ...step, action: "click", elementToken: "fixture-element" }, ...Array.from({ length: 4 }, () => ({ ...step }))
    ] };
    assert.equal(Object.keys(sequence).length + sequence.actions.length + sequence.actions.reduce((count, action) => count + Object.keys(action).length, 0), 110);
    assert.equal(computerSequenceSchema.safeParse(sequence).success, true);
    const sequenceReply = await client.callTool({ name: "sequence", arguments: sequence });
    assert.equal(sequenceReply.isError, true);
    assert.match(textOf(sequenceReply), /computer_desktop_required/u, "legitimate five-step input reaches the existing handler refusal");
    assert.deepEqual(policyCalls, ["sequence"]);
    assert.deepEqual(nativeCalls, []);

    const observed = await client.callTool({ name: "get_app_state", arguments: {
      pid: 42, bundle: "test.inert", window_id: 7, maxElements: 1_000, content: "full",
      waitFor: { text: "ready", timeoutMs: 10_000 }, depth: 20, screenshotMaxWidth: 1_280,
      interactiveOnly: true, autoLaunch: false
    } });
    assert.notEqual(observed.isError, true, textOf(observed));
    const typed = await client.callTool({ name: "type_text", arguments: { pid: 42, window_id: 7, text: "x".repeat(4_000) } });
    assert.notEqual(typed.isError, true, textOf(typed));
    assert.deepEqual(nativeCalls, ["observe", "type_text"]);
    assert.deepEqual(policyCalls, ["sequence", "get_app_state", "type_text"]);
    await transport.terminateSession();
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
