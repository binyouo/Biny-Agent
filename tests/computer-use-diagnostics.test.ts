import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUseController, type ComputerDriver } from "../src/computer/controller.js";

const target = { pid: 42, windowId: "900" };
test("opt-in action audit retains only bounded metadata and clears on stop or opt-out", async () => {
  const driver: ComputerDriver = {
    start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: {}, images: [] }),
    observe: async () => ({ data: { ...target, window_id: 900, capture_id: "c1", screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true, elements: [{ element_token: "private-token" }] }, images: [{ mimeType: "image/png", dataBase64: "cHJpdmF0ZS1mcmFtZQ==" }] }),
    act: async () => ({ data: { effect: "confirmed", rawText: "private-response" }, images: [] })
  };
  const controller = new ComputerUseController(driver);
  await controller.enable();
  controller.setLogging(true);
  for (let index = 0; index < 52; index++) {
    await controller.observe("s", target);
    await controller.act("s", { ...target, action: "type_text", text: "private-input", elementToken: "private-token", captureId: "c1" });
  }
  const entries = controller.audit();
  assert.equal(entries.length, 50);
  assert.deepEqual(Object.keys(entries[0]!).sort(), ["action", "at", "bundleId", "durationMs", "errorCode", "outcome", "target"]);
  // 参数绝不进审计：那是用户输入和私有令牌。
  assert.equal("args" in entries[0]!, false, "审计不得保留动作参数");
  assert.doesNotMatch(JSON.stringify(entries), /private|capture|image|token/);
  entries[0]!.target.pid = 999;
  assert.equal(controller.audit()[0]!.target.pid, 42, "caller cannot mutate retained audit");
  controller.setLogging(false); assert.equal(controller.audit().length, 0);
  controller.setLogging(true); await controller.disable(); assert.equal(controller.audit().length, 0);
});
