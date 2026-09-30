import assert from "node:assert/strict";
import { test } from "node:test";
import { planMacOsScroll, parseNaturalScrolling, type ScrollObservation } from "../src/computer/macOsScroll.js";
import { computerActionSchema, type ComputerAction } from "../src/computer/protocol.js";

const target = { pid: 42, windowId: "900" };
const observation: ScrollObservation = { session: "s", target, captureId: "capture-real", snapshotId: "snapshot-real", capturedAt: 10, elements: [{ token: "snapshot-real:1", role: "AXGroup", web: true }] };
const scroll = (direction: NonNullable<ComputerAction["direction"]>, delivery: ComputerAction["delivery"] = "foreground"): ComputerAction => ({ ...target, action: "scroll", captureId: "capture-real", elementToken: "snapshot-real:1", delivery, direction, amount: 1 });

test("natural-scrolling conversion occurs once at the macOS web-wheel boundary for all axes", () => {
  const opposites = { up: "down", down: "up", left: "right", right: "left" } as const;
  for (const direction of ["up", "down", "left", "right"] as const) {
    const plan = planMacOsScroll("s", scroll(direction), observation, true, 20);
    assert.equal(plan.refusal, undefined);
    assert.equal(plan.args?.direction, opposites[direction]);
    assert.equal(plan.args?.by, "line");
    assert.equal(plan.args?.amount, 1);
    assert.equal(plan.args?.element_token, "snapshot-real:1");
    assert.equal(plan.args?.snapshot_id, "snapshot-real");
    assert.equal(plan.args?.window_id, 900);
    assert.equal(planMacOsScroll("s", scroll(direction), observation, false, 20).args?.direction, direction);
  }
  // Native failure fixture: SDK Up + natural scrolling produced DOM scrollTop 50 -> 133.
  assert.equal(planMacOsScroll("s", scroll("up"), observation, true, 20).args?.direction, "down");
});

test("background web refusal keeps the official SDK delivery path and cannot activate a foreground fallback", () => {
  const plan = planMacOsScroll("s", scroll("down", "background"), observation, true, 20);
  assert.equal(plan.refusal, undefined);
  assert.equal(plan.args?.delivery_mode, "background");
  assert.equal(plan.args?.direction, "up");
});

test("unknown preference, native semantic routes and stale or mismatched observations refuse before OS input", () => {
  for (const [capture, preference, session, action, now, expected] of [
    [observation, undefined, "s", scroll("up"), 20, "scroll_direction_setting_unavailable"],
    [{ ...observation, elements: [{ token: "snapshot-real:1", role: "AXTextArea", web: false }] }, true, "s", scroll("down"), 20, "scroll_route_unverified"],
    [{ ...observation, elements: [{ token: "snapshot-real:1", role: "AXTextArea", web: true }] }, true, "s", scroll("down"), 20, "scroll_route_unverified"],
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

test("zero/negative amounts never become SDK default wheel notches and missing amounts mean one notch", () => {
  for (const amount of [0, -1, 0.5, 11]) assert.equal(computerActionSchema.safeParse({ ...scroll("down"), amount }).success, false);
  assert.equal(planMacOsScroll("s", { ...scroll("down"), amount: undefined }, observation, true, 20).args?.amount, 1);
  assert.equal(planMacOsScroll("s", { ...scroll("down"), amount: 10 }, observation, true, 20).args?.amount, 10);
  assert.equal(parseNaturalScrolling("1\n"), true);
  assert.equal(parseNaturalScrolling("0\n"), false);
  assert.equal(parseNaturalScrolling("unknown"), undefined);
  assert.equal(parseNaturalScrolling(""), undefined);
});
