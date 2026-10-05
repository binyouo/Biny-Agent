import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { ComputerUseController, type ComputerDriver, type DriverReply } from "../src/computer/controller.js";

test("in-product mirrors enforce app approval and close a late open after takeover", async () => {
  const calls: { operation: string; args: Record<string, unknown> }[] = [];
  let finish: (value: DriverReply) => void = () => undefined;
  let opened: () => void = () => undefined;
  const dispatched = new Promise<void>(resolve => { opened = resolve; });
  const driver: ComputerDriver = {
    start: async () => undefined, stop: async () => undefined,
    list: async () => { throw new Error("unused"); }, observe: async () => { throw new Error("unused"); }, act: async () => { throw new Error("unused"); },
    mirror: async (operation, args) => {
      calls.push({ operation, args });
      if (operation === "open") { opened(); return await new Promise<DriverReply>(resolve => { finish = resolve; }); }
      return { data: { closed: 1 }, images: [] };
    }
  };
  let approved = false;
  const controller = new ComputerUseController(driver, { enabled: true, authorize: async () => {
    if (!approved) throw new Error("approval_required"); return "com.example.editor";
  } });
  const request = { operation: "open" as const, pid: 12, windowId: "42", onMinimize: true };
  await assert.rejects(controller.mirror("session", request), /approval_required/);
  assert.equal(calls.length, 0);
  approved = true;
  const opening = controller.mirror("session", request);
  await dispatched;
  controller.control("takeover");
  finish({ data: { window_id: 42, pid: 12 }, images: [] });
  await assert.rejects(opening, /computer_mirror_invalidated/);
  assert.ok(calls.some(call => call.operation === "close" && call.args.window_id === 42 && call.args.request_id === calls[0]!.args.request_id));
});

test("the real daemon exposes mirror state and rejects invalid targets without opening a window", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-mirror-"));
  const driver = new NativeProcessDriver(() => undefined, { socketDir: directory });
  try {
    assert.deepEqual((await driver.daemonCommand("pip_list")).data, { sessions: [], armed: [] });
    await assert.rejects(driver.daemonCommand("pip_open", { window_id: 0 }), /pip_invalid_window_id/);
    await assert.rejects(driver.daemonCommand("pip_close", {}), /pip_close_requires_target/);
    assert.equal((await driver.daemonCommand("pip_close", { all: true })).data.closed, 0);
    assert.equal((await driver.daemonCommand("appshot_status")).data.tapDisablesRecovered, 0);
    // 600 个不同字符超过四种修饰键 × 128 键码的映射容量，任何布局都必然在派发前拒绝。
    const unmappable = Array.from({ length: 600 }, (_, index) => String.fromCharCode(0xe000 + index)).join("");
    await assert.rejects(driver.daemonCommand("type_text", { pid: process.pid, text: unmappable, input_method: "physical" }), /input_method_(unmappable_character|layout_required|layout_unavailable)/);
  } finally { await driver.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("MCP mirror tools carry exact window identity and minimize arming to the driver", async () => {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  class Driver extends NativeProcessDriver {
    override async daemonCommand(cmd: string, args: Record<string, unknown> = {}) {
      calls.push({ cmd, args });
      return { data: { window_id: args.window_id, sessions: [] }, images: [] };
    }
  }
  const driver = new Driver(() => undefined);
  const server = createComputerUseMcpServer(driver, { run: async (_name, _args, operation) => await operation() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mirror-test", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    for (const name of ["pip_open", "pip_close", "pip_list"]) assert.ok(tools.some(tool => tool.name === name), name);
    await client.callTool({ name: "pip_open", arguments: { window_id: 42, pid: 12, on_minimize: true } });
    await client.callTool({ name: "pip_list", arguments: {} });
    await client.callTool({ name: "pip_close", arguments: { window_id: 42 } });
    assert.deepEqual(calls, [
      { cmd: "pip_open", args: { window_id: 42, pid: 12, on_minimize: true } },
      { cmd: "pip_list", args: {} },
      { cmd: "pip_close", args: { window_id: 42, all: undefined } }
    ]);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});
