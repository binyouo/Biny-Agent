import assert from "node:assert/strict";
import { test } from "node:test";
import { computerActionSchema, computerIpc, computerSequenceSchema } from "../src/computer/protocol.js";
import { ComputerUseController, type ComputerDriver } from "../src/computer/controller.js";
import { createComputerUseTools } from "../src/tools/computerUse.js";

const target = { pid: 42, windowId: "900", captureId: "capture" };

test("model actions and sequences expose no foreground delivery option", () => {
  const action = { ...target, action: "press_key", key: "Return" };
  const sequence = { ...target, actions: [{ action: "press_key", key: "Return" }] };
  assert.equal(computerActionSchema.safeParse(action).success, true);
  assert.equal(computerSequenceSchema.safeParse(sequence).success, true);
  for (const delivery of ["foreground", "background"]) {
    assert.equal(computerActionSchema.safeParse({ ...action, delivery }).success, false);
    assert.equal(computerSequenceSchema.safeParse({ ...sequence, delivery }).success, false);
    assert.equal(computerSequenceSchema.safeParse({ ...sequence, actions: [{ ...sequence.actions[0], delivery }] }).success, false);
  }
  const tools = createComputerUseTools(async () => assert.fail("schema inspection must not dispatch input"));
  for (const name of ["ComputerAction", "ComputerSequence"]) {
    const tool = tools.find(item => item.name === name)!;
    assert.equal(JSON.stringify(tool.parameters).includes('"delivery"'), false);
  }
  assert.equal("foreground" in computerIpc, false);
});

test("foreground proposals are rejected before native input without consuming the valid observation", async () => {
  const inputs: unknown[] = [];
  const driver: ComputerDriver = {
    start: async () => undefined, stop: async () => undefined,
    list: async () => ({ data: { apps: [] }, images: [] }),
    observe: async () => ({ data: { capture_id: "capture", pid: 42, window_id: 900, screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true }, images: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }] }),
    act: async (_session, action) => { inputs.push(action); return { data: { effect: "confirmed" }, images: [] }; }
  };
  const controller = new ComputerUseController(driver, { enabled: true });
  try {
    const observed = await controller.observe("test", { pid: 42, windowId: "900" });
    assert.equal("foregroundAllowed" in observed.data, false);
    assert.equal("foregroundAllowed" in controller.status(), false);
    const proposal = { ...target, action: "press_key" as const, key: "Return", delivery: "foreground" };
    await assert.rejects(async () => controller.act("test", proposal), /[Uu]nrecognized/);
    assert.deepEqual(inputs, []);
    await controller.act("test", { ...target, action: "press_key", key: "Return" });
    assert.equal(inputs.length, 1);
    assert.equal("delivery" in (inputs[0] as object), false);
  } finally { await controller.disable(); }
});
