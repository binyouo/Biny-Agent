import assert from "node:assert/strict";
import { desktopWorktreeView } from "../src/desktop/renderer/src/worktreePresentation.js";
import { formatTuiWorktreeError, tuiWorktreeActionDescription, tuiWorktreeActionLabel, tuiWorktreeView } from "../src/tui/worktreePresentation.js";

const active = desktopWorktreeView({
  sessionId: "session-active",
  status: "active",
  exists: true,
  dirty: false,
  mergedIntoBase: false
});
assert.equal(active.label, "可合并");
assert.equal(active.canMerge, true);
assert.equal(active.canRemove, true);
assert.equal(active.deleteBranchOnRemove, false);

const dirty = desktopWorktreeView({
  sessionId: "session-dirty",
  status: "active",
  exists: true,
  dirty: true,
  mergedIntoBase: false
});
assert.equal(dirty.canMerge, false);
assert.equal(dirty.canRemove, false);
assert.match(dirty.detail, /保留/);

const merged = desktopWorktreeView({
  sessionId: "session-merged",
  status: "merged",
  exists: true,
  dirty: false,
  mergedIntoBase: true
});
assert.equal(merged.label, "已合并");
assert.equal(merged.canMerge, false);
assert.equal(merged.deleteBranchOnRemove, true);

const changedAfterMerge = { sessionId: "session-new-commits", status: "merged" as const, exists: true, dirty: false, mergedIntoBase: false };
assert.equal(desktopWorktreeView(changedAfterMerge).deleteBranchOnRemove, false);
assert.deepEqual(tuiWorktreeView(changedAfterMerge).actions, ["merge", "remove-worktree"]);

const orphaned = desktopWorktreeView({
  sessionId: "session-orphaned",
  status: "orphaned",
  exists: true,
  dirty: false,
  mergedIntoBase: false
});
assert.equal(orphaned.canRemove, false);
assert.match(orphaned.detail, /不会自动删除/);

const tuiActive = tuiWorktreeView({
  sessionId: "session-active",
  status: "active",
  exists: true,
  dirty: false,
  mergedIntoBase: false
});
assert.deepEqual(tuiActive.actions, ["merge", "remove-worktree"]);
assert.match(tuiWorktreeActionLabel("remove-worktree"), /keep branch/u);
assert.match(tuiWorktreeActionDescription("merge"), /project base/u);

const tuiDirty = tuiWorktreeView({
  sessionId: "session-dirty",
  status: "active",
  exists: true,
  dirty: true,
  mergedIntoBase: false
});
assert.deepEqual(tuiDirty.actions, [], "脏 worktree 不提供清理入口");

const tuiMerged = tuiWorktreeView({
  sessionId: "session-merged",
  status: "merged",
  exists: true,
  dirty: false,
  mergedIntoBase: true
});
assert.deepEqual(tuiMerged.actions, ["remove-branch"]);
assert.doesNotMatch(
  formatTuiWorktreeError(new Error("Worktree /private/project/.biny/worktrees/wt-session contains uncommitted changes; it was kept.")),
  /\.biny|wt-session/u,
  "TUI worktree error 不得泄漏路径"
);

console.log("worktree presentation tests passed");
