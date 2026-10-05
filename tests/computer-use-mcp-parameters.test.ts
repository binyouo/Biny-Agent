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
test("product action accepts complete click routing and screen coordinates", () => {
  const parsed = computerActionSchema.safeParse({ pid: 12, windowId: "42", captureId: "c", action: "click", x: 900, y: 500, button: "middle", clickCount: 3, strategy: "physical", coordinateSpace: "screen" });
  assert.equal(parsed.success, true);
  assert.equal(computerActionSchema.safeParse({ pid: 12, windowId: "42", captureId: "c", action: "click", elementToken: "e", clickCount: 4 }).success, false);
});
