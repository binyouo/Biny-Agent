import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { computerActionSchema } from "../src/computer/protocol.js";

async function fixture(run: (client: Client, calls: { cmd: string; args: Record<string, unknown> }[]) => Promise<void>) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async (cmd, args = {}) => { calls.push({ cmd, args }); return { data: { apps: [] }, images: [] }; };
  driver.observeRaw = async args => { calls.push({ cmd: "observe", args }); return { data: { pid: 12, bundleId: "com.apple.iWork.Numbers", elements: [] }, images: [] }; };
  driver.actRaw = async (cmd, args, pid) => { calls.push({ cmd, args: { ...args, pid } }); return { data: { ok: true }, images: [] }; };
  driver.captureWindow = async () => ({ data: {}, images: [] });
  driver.capturePreview = async () => ({ data: {}, images: [] });
  const server = createComputerUseMcpServer(driver, { run: async (_name, _args, operation) => await operation() });
  const client = new Client({ name: "parameter-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try { await Promise.all([server.connect(right), client.connect(left)]); await run(client, calls); }
  finally { await client.close(); await server.close(); await driver.dispose(); }
}

test("MCP preserves an exact window and all click routing parameters", async () => fixture(async (client, calls) => {
  const result = await client.callTool({ name: "click", arguments: { pid: 12, window_id: 42, ref: "e1", button: "right", click_count: 2, strategy: "physical", coord_space: "screen" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { cmd: "click", args: { pid: 12, window_id: 42, ref: "e1", button: "right", clicks: 2, strategy: "physical", coord_space: "screen" } });
}));
test("MCP scroll requires an observed element and forwards it", async () => fixture(async (client, calls) => {
  const denied = await client.callTool({ name: "scroll", arguments: { pid: 12, direction: "down" } });
  assert.equal(denied.isError, true); assert.equal(calls.length, 0);
  await client.callTool({ name: "scroll", arguments: { pid: 12, window_id: 42, ref: "e2", direction: "right", pages: 3 } });
  assert.equal(calls[0]?.args.ref, "e2"); assert.equal(calls[0]?.args.window_id, 42);
}));
test("MCP days and observation options reach native commands and application guidance is included", async () => fixture(async (client, calls) => {
  await client.callTool({ name: "list_apps", arguments: { days: 7 } });
  assert.deepEqual(calls[0], { cmd: "list_apps", args: { recent_days: 7 } });
  const observed = await client.callTool({ name: "get_app_state", arguments: { pid: 12, window_id: 42, depth: 4 } });
  assert.equal(calls[1]?.args.window_id, 42);
  assert.match(JSON.stringify(observed.content), /## 编辑单元格/);
  const invalid = await client.callTool({ name: "list_apps", arguments: { days: 91 } });
  assert.equal(invalid.isError, true); assert.equal(calls.length, 2);
}));
test("MCP observation accepts screenshot-only mode and external option names", async () => fixture(async (client, calls) => {
  const result = await client.callTool({ name: "get_app_state", arguments: {
    pid: 12, window_id: 42, depth: 0, interactive_only: false, screenshot_max_width: 640, auto_launch: false
  } });
  assert.notEqual(result.isError, true);
  assert.equal(calls[0]!.args.max_depth, 0);
  assert.equal(calls[0]!.args.interactive_only, false);
  assert.equal(calls[0]!.args.max_width, 640);
  assert.equal(calls[0]!.args.auto_launch, false);
}));
test("MCP defaults full observations to depth six and keeps explicit depth and image-only mode", async () => fixture(async (client, calls) => {
  for (const [options, expected] of [[{}, 6], [{ depth: 9 }, 9], [{ content: "image" }, 0], [{ depth: 0 }, 0]] as const) {
    const result = await client.callTool({ name: "get_app_state", arguments: { pid: 12, window_id: 42, ...options } });
    assert.notEqual(result.isError, true);
    assert.equal(calls.at(-1)?.args.max_depth, expected);
  }
}));
test("MCP accepts input_method alongside the existing spelling and rejects duplicates before input", async () => fixture(async (client, calls) => {
  const tools = await client.listTools();
  const typeTool = tools.tools.find(tool => tool.name === "type_text")!;
  assert.ok(typeTool.inputSchema.properties?.input_method);
  assert.ok(typeTool.inputSchema.properties?.inputMethod);
  for (const method of ["auto", "physical", "unicode", "ax"] as const) {
    const result = await client.callTool({ name: "type_text", arguments: { pid: 12, window_id: 42, ref: "e1", text: "hello", input_method: method } });
    assert.notEqual(result.isError, true);
    assert.equal(calls.at(-1)?.args.input_method, method);
  }
  const before = calls.length;
  const duplicate = await client.callTool({ name: "type_text", arguments: { ref: "e1", text: "hello", input_method: "ax", inputMethod: "unicode" } });
  assert.equal(duplicate.isError, true);
  const missingRef = await client.callTool({ name: "type_text", arguments: { text: "hello", input_method: "ax" } });
  assert.equal(missingRef.isError, true);
  assert.equal(calls.length, before);
  const previous = await client.callTool({ name: "type_text", arguments: { text: "hello", inputMethod: "unicode" } });
  assert.notEqual(previous.isError, true);
  assert.equal(calls.at(-1)?.args.input_method, "unicode");
}));
test("MCP selects matching text or places the cursor without replacing the field", async () => fixture(async (client, calls) => {
  for (const selectionType of ["text", "cursor_before", "cursor_after"] as const) {
    const result = await client.callTool({ name: "select_text", arguments: {
      pid: 12, window_id: 42, ref: "e1", text: "目标", prefix: "前", suffix: "后", selection_type: selectionType
    } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
      cmd: "select_text", args: { pid: 12, window_id: 42, ref: "e1", match_text: "目标", prefix: "前", suffix: "后", selection_type: selectionType }
    });
  }
  const defaultResult = await client.callTool({ name: "select_text", arguments: { ref: "e1", text: "目标" } });
  assert.notEqual(defaultResult.isError, true);
  assert.equal(calls.at(-1)!.args.match_text, "目标");
  assert.equal(calls.at(-1)!.args.text, undefined);
}));
test("MCP drag accepts start and end coordinates and forwards its mouse button", async () => fixture(async (client, calls) => {
  const result = await client.callTool({ name: "drag", arguments: {
    pid: 12, window_id: 42, start_x: 1, start_y: 2, end_x: 30, end_y: 40, button: "right", coord_space: "screenshot"
  } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
    cmd: "drag", args: { pid: 12, window_id: 42, x1: 1, y1: 2, x2: 30, y2: 40, button: "right", coord_space: "screenshot" }
  });
  const previous = await client.callTool({ name: "drag", arguments: { x1: 1, y1: 2, x2: 30, y2: 40 } });
  assert.notEqual(previous.isError, true);
  assert.equal(calls.at(-1)!.args.x2, 30);
}));
test("product action accepts complete click routing and screen coordinates", () => {
  const parsed = computerActionSchema.safeParse({ pid: 12, windowId: "42", captureId: "c", action: "click", x: 900, y: 500, button: "middle", clickCount: 3, strategy: "physical", coordinateSpace: "screen" });
  assert.equal(parsed.success, true);
  assert.equal(computerActionSchema.safeParse({ pid: 12, windowId: "42", captureId: "c", action: "click", elementToken: "e", clickCount: 4 }).success, false);
});

for (const [name, args] of [
  ["set_value", { ref: "e", value: "x".repeat(4001) }],
  ["set_value", { ref: "e".repeat(257), value: false }],
  ["click", { ref: "e", x: 1 }],
  ["perform_secondary_action", { x: 1, y: 2, secondary_action: "AXPress" }],
  ["select_text", { ref: "e", matchText: "match", text: "replace" }],
  ["select_text", { ref: "e", text: "match", selection_type: "invalid" }],
  ["select_text", { ref: "e", location: 0, selection_type: "cursor_after" }],
  ["drag", { start_x: 1, start_y: 2, end_x: 3 }],
  ["drag", { start_x: 1, x1: 1, start_y: 2, end_x: 3, end_y: 4 }],
  ["press_key", { key: "Return", typo: true }],
  ["get_app_state", { content: "image", waitFor: { text: "ready" } }],
  ["get_app_state", { depth: 0, content: "full" }],
  ["get_app_state", { auto_launch: false, autoLaunch: true }],
  ["get_app_state", { interactive_only: false, interactiveOnly: true }]
] as const) test(`MCP rejects invalid shared input before dispatch: ${name} ${Object.keys(args)}`, async () => fixture(async (client, calls) => {
  const result = await client.callTool({ name, arguments: { pid: 12, window_id: 42, ...args } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
}));

test("MCP tools/list and built-in tools expose bounded shared fields", async () => fixture(async (client) => {
  const { createComputerUseTools } = await import("../src/tools/computerUse.js");
  const tools = (await client.listTools()).tools;
  const value = tools.find(tool => tool.name === "set_value")!.inputSchema.properties!.value as { anyOf: { maxLength?: number }[] };
  assert.equal(value.anyOf[0]!.maxLength, 4000);
  const ref = tools.find(tool => tool.name === "click")!.inputSchema.properties!.ref as { maxLength: number };
  assert.equal(ref.maxLength, 256);
  const action = createComputerUseTools(async () => ({ data: {}, images: [] })).find(tool => tool.name === "ComputerAction")!;
  assert.equal((action.parameters.properties!.elementToken as { maxLength?: number }).maxLength, 256);
  assert.equal((action.parameters.properties!.value as { anyOf: { maxLength?: number }[] }).anyOf[0]!.maxLength, 4000);
}));

test("MCP accepts the value/ref limits and preserves false/zero/empty text", async () => fixture(async (client, calls) => {
  for (const value of ["x".repeat(4000), false, 0, ""]) {
    const reply = await client.callTool({ name: "set_value", arguments: { ref: "e".repeat(256), value } });
    assert.notEqual(reply.isError, true);
    assert.equal(calls.at(-1)!.args.value, value);
    assert.equal(calls.at(-1)!.args.ref, "e".repeat(256));
  }
  const reply = await client.callTool({ name: "type_text", arguments: { text: "" } });
  assert.notEqual(reply.isError, true);
  assert.equal(calls.at(-1)!.args.text, "");
}));
