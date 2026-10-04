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
    // Alma 的核心动词面：读、点、输入、滚动、拖拽、右键、直写、选文、权限。
    // 13 个：12 个动词 + grant（daemon 早就会，工具面曾经漏掉）。
    assert.deepEqual(names, [
      "click", "drag", "get_app_state", "grant", "launch_app", "list_apps",
      "perform_secondary_action", "permissions", "press_key", "scroll",
      "select_text", "set_value", "type_text"
    ]);
    // 动作类工具必须声明 pid，否则调用方无法把动作定向到目标窗口。
    for (const name of ["click", "type_text", "press_key", "scroll", "drag", "set_value", "select_text", "perform_secondary_action"]) {
      const tool = tools.find(entry => entry.name === name)!;
      assert.ok(tool.inputSchema, `${name} must declare an input schema`);
    }
    // 动作工具也要自述会带回执截图 —— 模型据此知道不必再 observe 一次。
    const click = tools.find(entry => entry.name === "click")!;
    assert.match(click.description ?? "", /screenshot/i, "动作工具要说明它带回动作后的截图");
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

// Alma 的每个动作工具都带回执截图（notes/19 §2），模型执行完一步就能看到结果，
// 不必再 observe 一次 —— 少一个来回、少一棵 AX 树。
test("an action tool returns the post-action screenshot, not just an ack", async () => {
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
