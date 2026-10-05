import assert from "node:assert/strict";
import { test } from "node:test";
import { planMacOsScroll, parseNaturalScrolling, type ScrollObservation } from "../src/computer/macOsScroll.js";
import { computerActionSchema, type ComputerAction } from "../src/computer/protocol.js";

const target = { pid: 42, windowId: "900" };
const observation: ScrollObservation = { session: "s", target, captureId: "capture-real", snapshotId: "snapshot-real", capturedAt: 10, elements: [{ token: "snapshot-real:1", role: "AXGroup", web: true }] };
const scroll = (direction: NonNullable<ComputerAction["direction"]>, delivery: ComputerAction["delivery"] = "foreground"): ComputerAction => ({ ...target, action: "scroll", captureId: "capture-real", elementToken: "snapshot-real:1", delivery, direction, pages: 1 });

test("natural-scrolling conversion occurs once at the macOS web-wheel boundary for all axes", () => {
  const opposites = { up: "down", down: "up", left: "right", right: "left" } as const;
  for (const direction of ["up", "down", "left", "right"] as const) {
    const plan = planMacOsScroll("s", scroll(direction), observation, true, 20);
    assert.equal(plan.refusal, undefined);
    assert.equal(plan.args?.wheel_direction, opposites[direction], "自然滚动的方向转换只作用于滚轮路由");
    assert.equal(plan.args?.direction, direction, "语义方向原样保留给 AX 路由");
    assert.equal(plan.args?.by, "line");
    assert.equal(plan.args?.pages, 1);
    assert.equal(plan.args?.element_token, "snapshot-real:1");
    assert.equal(plan.args?.snapshot_id, "snapshot-real");
    assert.equal(plan.args?.window_id, 900);
    assert.equal(planMacOsScroll("s", scroll(direction), observation, false, 20).args?.direction, direction);
  }
  // Native failure fixture: SDK Up + natural scrolling produced DOM scrollTop 50 -> 133.
  // 转换后的方向是**滚轮路由**要的；语义方向原样留着给 AX 路由。
  const converted = planMacOsScroll("s", scroll("up"), observation, true, 20).args;
  assert.equal(converted?.wheel_direction, "down");
  assert.equal(converted?.direction, "up");
});

test("background web refusal keeps the official SDK delivery path and cannot activate a foreground fallback", () => {
  const plan = planMacOsScroll("s", scroll("down", "background"), observation, true, 20);
  assert.equal(plan.refusal, undefined);
  assert.equal(plan.args?.delivery_mode, "background");
  assert.equal(plan.args?.wheel_direction, "up");
});

test("unknown preference, stale or mismatched observations refuse before OS input", () => {
  for (const [capture, preference, session, action, now, expected] of [
    [observation, undefined, "s", scroll("up"), 20, "scroll_direction_setting_unavailable"],
    [observation, true, "other", scroll("up"), 20, "capture_target_mismatch_or_missing"],
    [observation, true, "s", { ...scroll("up"), windowId: "901" }, 20, "capture_target_mismatch_or_missing"],
    [observation, true, "s", { ...scroll("up"), captureId: "old" }, 20, "capture_target_mismatch_or_missing"],
    [observation, true, "s", scroll("up"), 60010, "capture_expired"],
    [undefined, true, "s", scroll("up"), 20, "capture_target_mismatch_or_missing"]
  ] as const) {
    const plan = planMacOsScroll(session, action, capture, preference, now);
    assert.equal(plan.args, undefined);
    assert.equal(plan.refusal?.errorCode, expected);
    assert.equal(plan.refusal?.data.dispatched, false);
  }
});

// 单位是**页**（量出来的），不是行（估的）。零和负数在派发前就被拒，别让它们
// 变成 SDK 的默认滚轮行数 —— 那会变成"没要求却滚了一下"。
test("zero or negative pages never become SDK default wheel notches, and a missing count means one page", () => {
  for (const pages of [0, -1, 21]) assert.equal(computerActionSchema.safeParse({ ...scroll("down"), pages }).success, false);
  assert.equal(planMacOsScroll("s", { ...scroll("down"), pages: undefined }, observation, true, 20).args?.pages, 1);
  assert.equal(planMacOsScroll("s", { ...scroll("down"), pages: 5 }, observation, true, 20).args?.pages, 5);
  assert.equal(parseNaturalScrolling("1\n"), true);
  assert.equal(parseNaturalScrolling("0\n"), false);
  assert.equal(parseNaturalScrolling("unknown"), undefined);
  assert.equal(parseNaturalScrolling(""), undefined);
});

// 以前原生目标被拒（scroll_route_unverified），因为没法事前证明该走哪条路。
// 守护进程现在两条都有，并且按目标**暴露了什么**来选，所以这个理由不成立了。
// 实测：原生滚动区暴露 AXScrollBar，网页内容不暴露（浏览器自绘）。
test("native scroll targets are allowed now that the daemon can pick the AX route", () => {
  for (const web of [false, true]) {
    const capture = { ...observation, elements: [{ token: "snapshot-real:1", role: "AXTextArea", web }] };
    const plan = planMacOsScroll("s", scroll("down"), capture, true, 20);
    assert.equal(plan.refusal, undefined, "原生滚动区不该再被拒");
    assert.equal(plan.args?.direction, "down");
    // AX 路由按语义方向：写滚动条位置不需要自然滚动转换，否则原生目标会滚反。
    assert.equal(plan.args?.wheel_direction, "up");
  }
});
