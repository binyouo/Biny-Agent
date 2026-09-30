import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeWindowObservation } from "../src/computer/windowScope.js";

test("exact window observation excludes SDK app menu roots and duplicate raw tree text", () => {
  const raw = { pid: 42, window_id: 9, capture_id: "c1", snapshot_id: "s1", screenshot_width: 1280, screenshot_height: 960, screenshot_frame_valid: true,
    tree_markdown: "private recent documents", _note: "unbounded raw tree", tree_meta: { menu: "private" }, elements: [
      { element_index: 0, depth: 0, role: "AXWindow", label: "fixture" },
      { element_index: 1, parent_index: 0, role: "AXWebArea", element_token: "s1:1" },
      { element_index: 2, parent_index: 1, role: "AXButton", label: "synthetic", element_token: "s1:2" },
      { element_index: 3, depth: 0, role: "AXMenuBar", label: "private" },
      { element_index: 4, parent_index: 3, role: "AXMenuItem", value: "private recent documents", element_token: "s1:4" }
    ] };
  const scoped = scopeWindowObservation(raw);
  assert.deepEqual((scoped.elements as Array<{ element_index: number }>).map(element => element.element_index), [0, 1, 2]);
  assert.equal(scoped.capture_id, "c1");
  assert.equal(scoped.snapshot_id, "s1");
  assert.equal(scoped.element_count, 3);
  assert.equal(JSON.stringify(scoped).includes("private"), false);
  assert.equal(raw.elements.length, 5);
});

test("missing or ambiguous window root fails closed instead of exposing app scope", () => {
  assert.throws(() => scopeWindowObservation({ elements: [{ element_index: 0, role: "AXMenuBar" }] }), /window_scope/);
  assert.throws(() => scopeWindowObservation({ elements: [{ element_index: 0, depth: 0, role: "AXWindow" }, { element_index: 1, depth: 0, role: "AXWindow" }] }), /window_scope/);
});
