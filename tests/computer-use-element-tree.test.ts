import assert from "node:assert/strict";
import test from "node:test";
import { renderElementTree } from "../src/computer/elementTree.js";

// 观察是要反复做的，树每次都要过一遍模型。行集比紧凑 JSON 省一半，
// 而 element_token 必须留在行里 —— 动作就是按它引用的。
test("the element tree renders as lines that keep the refs the actions need", () => {
  const line = renderElementTree([
    { element_token: "e7", role: "AXButton", title: "返回", frame: { x: 0, y: 90, w: 40, h: 34 }, enabled: true },
    { element_token: "e8", role: "AXTextField", value: "搜索", focused: true, frame: { x: 10, y: 20, w: 200, h: 30 } },
    { element_token: "e9", role: "AXButton", enabled: false }
  ]).split("\n");
  assert.equal(line[0], '[0] (e7) AXButton "返回" @0,90 40x34');
  assert.match(line[1]!, /\(e8\) AXTextField "搜索" @10,20 200x30 \(focused\)/, "聚焦状态要内联，模型才知道输入落到哪");
  assert.match(line[2]!, /\(disabled\)/);
  // 引用必须活着：摘掉它模型就没法点
  for (const entry of line) assert.match(entry, /\(e\d+\)/);
});

test("the tree stays small enough to be worth the trouble", () => {
  const elements = Array.from({ length: 300 }, (_, i) => ({
    element_token: `e${i}`, role: "AXButton", title: `按钮 ${i}`, frame: { x: i, y: i * 2, w: 80, h: 30 }, enabled: true
  }));
  const rendered = renderElementTree(elements).length;
  const json = JSON.stringify(elements).length;
  assert.ok(rendered < json / 2, `行集应明显小于 JSON：${rendered} vs ${json}`);
});

test("an absent or empty tree renders as nothing, not as a stray newline", () => {
  assert.equal(renderElementTree(undefined), "");
  assert.equal(renderElementTree([]), "");
});

test("labels retain distinguishing text, fall back through nonempty AX fields and do not invent bounds", () => {
  const longLabel = "这是一段用于区分相似控件的完整无障碍标题".repeat(3) + "最终确认按钮";
  const lines = renderElementTree([
    { ref: "a", role: "AXButton", title: `  ${longLabel}  ` },
    { ref: "b", role: "AXButton", title: "  ", description: "  播放音乐  ", value: "other" },
    { ref: "c", role: "AXTextField", title: "", description: "\n", value: "  目标文字  " },
    { ref: "d", role: "AXButton", role_description: "  菜单按钮  " }
  ]).split("\n");
  assert.equal(lines[0], `[0] (a) AXButton ${JSON.stringify(longLabel)}`);
  assert.equal(lines[1], '[1] (b) AXButton "播放音乐" value="other"');
  assert.equal(lines[2], '[2] (c) AXTextField "目标文字"');
  assert.equal(lines[3], '[3] (d) AXButton "菜单按钮"');
});
