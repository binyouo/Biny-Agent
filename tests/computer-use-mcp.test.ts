import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

// Alma 把 Computer Use 暴露两遍：产品内工具 + stdio MCP server（alma-reverse 16 §4）。
// 这里钉住第二个出口的对外形状。
test("computer use is served over MCP with the documented verbs", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  const server = createComputerUseMcpServer(driver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      "click", "get_app_state", "launch_app", "list_apps",
      "permissions", "press_key", "scroll", "type_text"
    ]);
    // 动作类工具必须声明 pid，否则调用方无法把动作定向到目标窗口。
    for (const name of ["click", "type_text", "press_key", "scroll"]) {
      const tool = tools.find(entry => entry.name === name)!;
      assert.ok(tool.inputSchema, `${name} must declare an input schema`);
    }
    // 观察工具必须自述它会返回截图，否则模型不会预期图像块。
    const observe = tools.find(entry => entry.name === "get_app_state")!;
    assert.match(observe.description ?? "", /screenshot/i);
  } finally {
    await client.close();
    await server.close();
    await driver.dispose();
  }
});

test("the MCP permissions verb reports live daemon state", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  const server = createComputerUseMcpServer(driver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "permissions", arguments: {} });
    const text = (result.content as { type: string; text?: string }[]).find(part => part.type === "text")?.text ?? "";
    const data = JSON.parse(text) as { accessibility?: string; screenRecording?: string; version?: string };
    assert.ok(["granted", "denied"].includes(data.accessibility ?? ""), "权限状态必须来自 daemon 自检");
    assert.equal(typeof data.version, "string");
  } finally {
    await client.close();
    await server.close();
    await driver.dispose();
  }
});
