import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import type { DriverReply } from "../src/computer/controller.js";

for (const [label, screenshot, expected] of [
  ["missing image", async () => ({ data: {}, images: [] }), "post_action_screenshot_unavailable"],
  ["native capture error", async () => ({ data: { screenshot_error: "capture_permission_denied" }, images: [] }), "capture_permission_denied"],
  ["driver refusal", async () => ({ data: {}, images: [], errorCode: "capture_target_missing" }), "capture_target_missing"],
  ["transport failure", async () => { throw new Error("driver_process_disconnected"); }, "driver_process_disconnected"]
] satisfies Array<[string, () => Promise<DriverReply>, string]>) {
  test(`post-action screenshot feedback preserves the dispatched action after ${label}`, async () => {
    const driver = new NativeProcessDriver(() => undefined);
    let actions = 0, shots = 0;
    driver.actRaw = async () => { actions++; return { data: { effect: "confirmed", via: "ax" }, images: [] }; };
    driver.capturePreview = async target => { shots++; assert.deepEqual(target, { pid: 12, windowId: "9" }); return await screenshot(); };
    const server = createComputerUseMcpServer(driver, { run: async (_name, _args, operation) => await operation() });
    const client = new Client({ name: "post-action-feedback", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(right), client.connect(left)]);
      const result = await client.callTool({ name: "click", arguments: { pid: 12, window_id: 9, ref: "e1" } });
      assert.notEqual(result.isError, true, "capture failure must not turn the dispatched action into a refused call");
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.effect, "confirmed");
      assert.equal(structured.observationRequired, true);
      assert.equal(structured.doNotRepeat, true);
      assert.equal(structured.screenshot_error, expected);
      const content = result.content as Array<{ type: string; text?: string }>;
      assert.ok(content.some(part => part.type === "text" && part.text?.includes(expected)), "text-only clients must receive the capture diagnostic");
      assert.equal(content.some(part => part.type === "image"), false);
      assert.equal(actions, 1); assert.equal(shots, 1);
    } finally { await client.close(); await server.close(); await driver.dispose(); }
  });
}

test("a refused action does not request a post-action screenshot", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  driver.actRaw = async () => ({ data: { effect: "refused" }, images: [], errorCode: "element_action_unsupported" });
  driver.capturePreview = async () => assert.fail("a refused action must not capture again");
  const server = createComputerUseMcpServer(driver, { run: async (_name, _args, operation) => await operation() });
  const client = new Client({ name: "post-action-refused", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const result = await client.callTool({ name: "click", arguments: { pid: 12, window_id: 9, ref: "e1" } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown>).screenshot_error, undefined);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});

for (const [label, screenshot, expected] of [
  ["missing image", async () => ({ data: { screenshot_error: "screenshot_read_failed" }, images: [] }), "screenshot_read_failed"],
  ["transport failure", async () => { throw new Error("driver_process_disconnected"); }, "driver_process_disconnected"]
] satisfies Array<[string, () => Promise<DriverReply>, string]>) {
  test(`sky reports the fallback screenshot's ${label} without changing the completed action`, async () => {
    const driver = new NativeProcessDriver(() => undefined);
    let observations = 0, actions = 0, shots = 0;
    driver.daemonCommand = async () => ({ data: { apps: [{ bundleId: "test.app", name: "Fixture", pid: 12, running: true }] }, images: [] });
    driver.observeRaw = async () => {
      if (++observations > 1) throw new Error("accessibility_timeout");
      return { data: { pid: 12, window_id: 9, bundleId: "test.app", elements: [{ element_token: "e1", role: "AXButton", title: "Play" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] };
    };
    driver.actRaw = async () => { actions++; return { data: { effect: "confirmed" }, images: [] }; };
    driver.capturePreview = async () => { shots++; return await screenshot(); };
    const server = createComputerUseMcpServer(driver, { run: async (_name, _args, operation) => await operation() });
    const client = new Client({ name: "sky-post-action-feedback", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(right), client.connect(left)]);
      assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } })).isError, true);
      const result = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
      assert.notEqual(result.isError, true);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.effect, "confirmed");
      assert.equal(structured.observationRequired, true);
      assert.equal(structured.observationRefreshFailed, true);
      assert.equal(structured.doNotRepeat, true);
      assert.equal(structured.screenshot_error, expected);
      assert.ok((result.content as Array<{ type: string; text?: string }>).some(part => part.text?.includes(expected)));
      assert.equal(actions, 1); assert.equal(shots, 1);
      const stale = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
      assert.equal(stale.isError, true); assert.equal(actions, 1);
    } finally { await client.close(); await server.close(); await driver.dispose(); }
  });
}
