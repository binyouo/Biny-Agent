import assert from "node:assert/strict";
import test from "node:test";
import { captureRegion } from "../src/desktop/windowCapture.js";

test("capture exports only the chosen visible region with integer pixel boundaries", () => {
  assert.deepEqual(captureRegion({ x: 240.2, y: 60.8, width: 600.1, height: 500.1 }, { width: 1000, height: 700 }), { x: 240, y: 60, width: 601, height: 501 });
  assert.deepEqual(captureRegion({ x: -20, y: 600, width: 200, height: 300 }, { width: 1000, height: 700 }), { x: 0, y: 600, width: 180, height: 100 });
  assert.throws(() => captureRegion({ x: 1001, y: 0, width: 200, height: 50 }, { width: 1000, height: 700 }), /visible/);
});

test("invalid and empty selections cannot leak a full-window capture", () => {
  for (const rect of [{ x: NaN, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 0, height: 5 }, { x: -50, y: 0, width: 10, height: 5 }]) {
    assert.throws(() => captureRegion(rect, { width: 800, height: 600 }));
  }
});
