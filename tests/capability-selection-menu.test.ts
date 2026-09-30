import assert from "node:assert/strict";
import test from "node:test";
import { applyCapabilityNames, toggleCapabilityName } from "../src/desktop/renderer/src/components/composer/capabilitySelectionLogic.js";
import { shouldShowToolInCapabilityMenu } from "../src/desktop/renderer/src/components/composer/capabilityVisibility.js";

const tools = ["Read", "Write", "WebSearch"];

test("runtime discovery and recall helpers are not user-selectable capabilities", () => {
  for (const name of ["ToolSearch", "search_history", "save_memory", "recall_memory", "read_checkpoint_evidence", "skill_lookup"]) {
    assert.equal(shouldShowToolInCapabilityMenu({ name, source: "builtin" }), false, name);
  }
  for (const name of ["Glob", "Grep", "Read", "Bash", "WebSearch"]) {
    assert.equal(shouldShowToolInCapabilityMenu({ name, source: "builtin" }), true, name);
  }
});

test("取消显式选择的最后一个能力回到自动选择", () => {
  assert.equal(toggleCapabilityName(["Read"], "Read", tools), "auto");
  assert.equal(toggleCapabilityName("all", "Read", ["Read"]), "auto");
  assert.equal(applyCapabilityNames(["Read"], ["Read"], tools, false), "auto");
});

test("显式点击不使用仍保留关闭语义，重新选择后可恢复逐项选择", () => {
  assert.deepEqual(applyCapabilityNames("none", ["Read"], tools, true), ["Read"]);
  assert.deepEqual(applyCapabilityNames(["Read", "Write"], ["Read"], tools, false), ["Write"]);
});
