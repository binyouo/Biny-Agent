import assert from "node:assert/strict";
import test from "node:test";
import { canReuseSettingsSnapshot } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const base = { cachedKey: "p1::s1", currentKey: "p1::s1", loadAttempt: 0, lastLoadAttempt: 0, hasSnapshot: true };

test("同一项目再次打开设置时复用缓存快照", () => {
  assert.equal(canReuseSettingsSnapshot(base), true);
});

test("没有缓存过就不复用", () => {
  assert.equal(canReuseSettingsSnapshot({ ...base, cachedKey: undefined }), false);
});

test("切换项目后不复用（防止把上个项目的设置显示出来）", () => {
  assert.equal(canReuseSettingsSnapshot({ ...base, currentKey: "p2::s1" }), false);
});

test("切换会话后不复用", () => {
  assert.equal(canReuseSettingsSnapshot({ ...base, currentKey: "p1::s2" }), false);
});

test("缓存里没有快照本体时不复用", () => {
  assert.equal(canReuseSettingsSnapshot({ ...base, hasSnapshot: false }), false);
});

test("用户主动重试后不复用，必须重新读一次", () => {
  // loadAttempt 递增代表用户点了"重新加载"；此时应当清空重来而不是继续用旧内容。
  assert.equal(canReuseSettingsSnapshot({ ...base, loadAttempt: 1, lastLoadAttempt: 0 }), false);
});
