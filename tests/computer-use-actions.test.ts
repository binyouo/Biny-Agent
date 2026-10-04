import { test } from "node:test";
import assert from "node:assert/strict";
import { computerActionSchema } from "../src/computer/protocol.js";

// daemon 和 MCP 出口都有这 8 个动词，产品内工具必须一样宽——
// 否则内置 agent 拖不了、右键不了、直写不了值、选不了文本，底下明明能做。
const base = { pid: 1, windowId: "10104", captureId: "c1" };

function valid(action: Record<string, unknown>): boolean {
  return computerActionSchema.safeParse({ ...base, ...action }).success;
}

test("the in-product action surface matches the daemon's verbs", () => {
  assert.ok(valid({ action: "click", x: 1, y: 2 }));
  assert.ok(valid({ action: "type_text", elementToken: "e1", text: "hi" }));
  assert.ok(valid({ action: "press_key", key: "cmd+s" }));
  assert.ok(valid({ action: "scroll", elementToken: "e1", direction: "down" }));
  assert.ok(valid({ action: "drag", x1: 1, y1: 2, x2: 30, y2: 40 }));
  assert.ok(valid({ action: "perform_secondary_action", elementToken: "e1" }));
  assert.ok(valid({ action: "perform_secondary_action", x: 5, y: 6 }));
  assert.ok(valid({ action: "set_value", elementToken: "e1", value: 0.5 }));
  assert.ok(valid({ action: "set_value", elementToken: "e1", value: "text" }));
  assert.ok(valid({ action: "select_text", elementToken: "e1", text: "run" }));
  assert.ok(valid({ action: "select_text", elementToken: "e1", location: 3 }));
});

test("each new verb rejects the arguments it cannot act on", () => {
  // 缺一半坐标的拖拽会变成一次点击，必须挡在派发之前。
  assert.equal(valid({ action: "drag", x1: 1, y1: 2, x2: 30 }), false);
  // 右键既没有 ref 也没有坐标就无处可点。
  assert.equal(valid({ action: "perform_secondary_action" }), false);
  // 写值没有值、选文没有目标范围，都是空动作。
  assert.equal(valid({ action: "set_value", elementToken: "e1" }), false);
  assert.equal(valid({ action: "set_value", value: 1 }), false);
  assert.equal(valid({ action: "select_text", elementToken: "e1" }), false);
});
