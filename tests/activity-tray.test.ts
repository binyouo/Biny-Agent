/** 托盘根据实际采集状态暴露开始/暂停、摘要和设置操作。 */
import assert from "node:assert/strict";
import { activityTrayItems } from "../src/desktop/electron/main/activityTrayMenu.js";

const calls: string[] = [];
const actions = {
  open: () => calls.push("open"),
  toggle: () => calls.push("toggle"),
  summary: () => calls.push("summary"),
  settings: () => calls.push("settings"),
  quit: () => calls.push("quit")
};
const paused = activityTrayItems("paused", actions);
assert.ok(paused.some((item) => item.label === "开始记录 Computer History"));
const stopped = activityTrayItems("stopped", actions);
assert.ok(stopped.some((item) => item.label === "开始记录 Computer History"));
const running = activityTrayItems("running", actions);
assert.ok(running.some((item) => item.label === "暂停记录 Computer History"));
assert.ok(running.some((item) => item.label === "生成今日摘要"));
assert.ok(running.some((item) => item.label === "Computer History 设置…"));
for (const label of ["打开 Biny", "暂停记录 Computer History", "生成今日摘要", "Computer History 设置…", "退出 Biny"]) {
  const item = running.find((candidate) => candidate.label === label);
  assert.ok(item?.click, `${label} 必须可操作`);
  item.click({} as never, {} as never, {} as never);
}
assert.deepEqual(calls, ["open", "toggle", "summary", "settings", "quit"]);
