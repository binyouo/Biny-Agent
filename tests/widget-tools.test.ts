import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";

// Given a normal workspace, When the model requests a widget, Then the same
// validated artifact is returned without filesystem or command side effects.
test("内置可视化工具提供指南与完整交互产物，拒绝空内容和过量输入", async () => {
  const registry = createToolRegistry({ workspaceRoot: process.cwd(), ignore: [] });
  const renderer = registry.listEntries().find(entry => entry.tool.name === "WidgetRenderer")?.tool;
  const readme = registry.listEntries().find(entry => entry.tool.name === "WidgetReadme")?.tool;
  assert.ok(renderer, "应注册通用交互式可视化工具");
  assert.ok(readme, "应注册可视化设计指南工具");
  assert.equal(renderer.risk, "read");
  const args = { title: "平方", description: "拖动滑块", html: '<input type="range"><output>4</output><script>document.querySelector("output").textContent=9</script>' };
  const execution = await renderer.resolveExecution(renderer.schema.parse(args));
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ toolCallId: "widget", operationId: "operation" });
  assert.deepEqual(result, { kind: "widget", ...args });
  assert.equal(renderer.schema.safeParse({ ...args, html: " " }).success, false);
  assert.equal(renderer.schema.safeParse({ ...args, html: "x".repeat(512_001) }).success, false);
  const guidance = await readme.resolveExecution(readme.schema.parse({}));
  assert.ok(!("isError" in guidance));
  assert.match(JSON.stringify(await guidance.execute({ toolCallId: "guide", operationId: "guide-op" })), /--primary/);
});
