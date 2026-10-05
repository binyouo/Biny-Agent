import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUseController, type ComputerDriver } from "../src/computer/controller.js";

const target = { pid: 42, windowId: "900" };
test("opt-in action audit retains only bounded metadata and survives stop and opt-out without retaining input", async () => {
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
  controller.setLogging(false); assert.equal(controller.audit().length, 50);
  controller.setLogging(true); await controller.disable(); assert.equal(controller.audit().length, 50);
});

test("preview preference defaults on without capturing at startup", async () => {
  let captures = 0;
  const controller = new ComputerUseController({ start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: {}, images: [] }), observe: async () => ({ data: {}, images: [] }), act: async () => ({ data: {}, images: [] }) },
    { setPreviewVisible: () => { captures++; } });
  assert.equal(controller.status().preview, true); assert.equal(captures, 0);
  await controller.disable(); assert.equal(controller.status().preview, true); assert.equal(captures, 0);
});

test("input interrupted by stop still leaves an unknown outcome in the durable journal", async () => {
  let dispatched!: () => void, fail!: (reason: Error) => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  const driver: ComputerDriver = {
    start: async () => undefined, stop: async () => undefined, list: async () => ({ data: {}, images: [] }),
    observe: async () => ({ data: { pid: 42, window_id: 900, capture_id: "c", screenshot_width: 100, screenshot_height: 100, screenshot_frame_valid: true }, images: [{ mimeType: "image/png", dataBase64: "eA==" }] }),
    act: async () => { dispatched(); return await new Promise((_resolve, reject) => { fail = reject; }); }
  };
  const controller = new ComputerUseController(driver, { enabled: true, actionLogging: true });
  await controller.observe("s", target); const operation = controller.act("s", { ...target, captureId: "c", action: "press_key", key: "Return" });
  const rejected = assert.rejects(operation, /unknown/); await started; await controller.disable(); fail(new Error("driver_disconnected: private-input")); await rejected;
  assert.equal(controller.audit()[0]?.outcome, "unknown"); assert.equal(controller.audit()[0]?.errorCode, "driver_disconnected");
});

test("dismissing a preview preserves the saved preference and a later action can reopen it", async () => {
  const visibility: boolean[] = [];
  const controller = new ComputerUseController({ start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: {}, images: [] }), observe: async () => ({ data: {}, images: [] }), act: async () => ({ data: {}, images: [] }) },
    { setPreviewVisible: visible => visibility.push(visible) });
  controller.noteActivity(); controller.dismissPreview();
  assert.equal(controller.status().preview, true); assert.deepEqual(visibility, [true, false]);
  controller.noteActivity(); assert.deepEqual(visibility, [true, false, true]); await controller.disable();
});
