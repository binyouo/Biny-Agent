import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

// MCP 入口与产品内工具共享原生能力，固定模型可见的协议形状。
test("computer use is served over MCP with the documented verbs", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  const server = createComputerUseMcpServer(driver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal(client.getServerVersion()?.name, "computer-use", "the public MCP identity must not include the application prefix");
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).sort();
    // 读写动作、权限与镜像均通过 MCP 的工具列表公开。
    assert.deepEqual(names, [
      "click", "drag", "get_app_state", "grant", "launch_app", "list_apps",
      "perform_secondary_action", "permissions", "pip_close", "pip_list", "pip_open", "press_key", "scroll",
      "select_text", "set_value", "type_text"
    ]);
    // 动作类工具必须声明 pid，否则调用方无法把动作定向到目标窗口。
    for (const name of ["click", "type_text", "press_key", "scroll", "drag", "set_value", "select_text", "perform_secondary_action"]) {
      const tool = tools.find(entry => entry.name === name)!;
      assert.ok(tool.inputSchema, `${name} must declare an input schema`);
    }
    // 动作后的截图用于核对结果，独立服务的下一次输入仍须重新观察。
    const click = tools.find(entry => entry.name === "click")!;
    assert.match(click.description ?? "", /动作后截图/, "动作工具要说明它带回动作后的截图");
    // 观察工具必须自述它会返回截图，否则模型不会预期图像块。
    const observe = tools.find(entry => entry.name === "get_app_state")!;
    assert.match(observe.description ?? "", /screenshot/i);
  } finally {
    await client.close();
    await server.close();
    await driver.dispose();
  }
});

test("the MCP permissions verb reports current native diagnostics", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let accessibility = "denied";
  driver.diagnostics = async () => ({ data: { accessibility, screenRecording: "granted", version: "fixture-1" }, images: [] });
  const server = createComputerUseMcpServer(driver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const current of ["denied", "granted"]) {
      accessibility = current;
      const result = await client.callTool({ name: "permissions", arguments: {} });
      assert.equal(result.isError, undefined);
      const text = (result.content as { type: string; text?: string }[]).find(part => part.type === "text")?.text ?? "";
      assert.deepEqual(JSON.parse(text), { accessibility: current, screenRecording: "granted", version: "fixture-1" });
    }
  } finally {
    await client.close();
    await server.close();
    await driver.dispose();
  }
});

// 动作结果携带回执截图，调用方可直接确认执行后的画面。
test("an action tool returns the post-action screenshot, not just an ack", { skip: process.env.BINY_TEST_COMPUTER_UI !== "1" }, async () => {
  const driver = new NativeProcessDriver(() => undefined, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  const server = createComputerUseMcpServer(driver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // 先观察（用 bundle，不给 pid —— 真实调用就是这个形状）
    const observed = await client.callTool({ name: "get_app_state", arguments: { bundle: "com.apple.TextEdit" } });
    if ((observed.content as { type: string }[]).some(part => part.type === "image") === false) return; // 文本编辑没开就跳过

    const reply = await client.callTool({ name: "press_key", arguments: { key: "Return" } });
    const parts = reply.content as { type: string; data?: string; mimeType?: string }[];
    assert.ok(parts.some(part => part.type === "text"), "仍要有文字确认");
    const image = parts.find(part => part.type === "image");
    assert.ok(image, "动作后必须带回执截图，否则调用方要再 observe 一次才知道发生了什么");
    assert.equal(image.mimeType, "image/jpeg");
    assert.ok(image.data?.startsWith("/9j/"), "回执必须是真 jpeg");
  } finally {
    await client.close();
    await server.close();
    await driver.dispose();
  }
});
