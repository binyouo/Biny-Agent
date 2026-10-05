/** `biny cu` 的公开动词与参数须能从帮助文本直接发现 —— 它是人和脚本的控制面。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const entry = path.resolve("src/cli/index.ts");
const runHelp = (...args: string[]): string => {
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, "cu", ...args, "--help"], {
    cwd: path.resolve("."), encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const cu = runHelp();
// 对 Alma 的 cu：命令行层独有的动词必须在（模型侧那 13 个工具里没有它们）
for (const verb of ["status", "doctor", "grant", "list_apps", "apps", "windows", "snap", "shot",
                    "click", "type", "type_text", "press", "press_key", "scroll", "drag", "menu",
                    "set_value", "launch_app", "raise", "lens", "intent", "shutdown"]) {
  assert.match(cu, new RegExp(`^\\s+${verb}\\b`, "mu"), `cu 缺动词 ${verb}`);
}
// 13 个模型工具里没有 raise/shutdown/status —— 它们是命令行层的，不该混进工具表
assert.doesNotMatch(runHelp("status"), /--pid/u);

// 每个动词的关键参数要就地可发现，不必二段查询
assert.match(runHelp("windows"), /<bundle\|pid>/u);
assert.match(runHelp("snap"), /--window\s+<id>/u);
assert.match(runHelp("snap"), /--out\s+<path>/u);
assert.match(runHelp("snap"), /--depth\s+<n>/u);
assert.match(runHelp("snap"), /--no-shot/u);
assert.match(runHelp("launch_app"), /--activates/u);
assert.match(runHelp("list_apps"), /--days\s+<n>/u);
assert.match(runHelp("type_text"), /--pid\s+<n>/u);
assert.match(runHelp("press_key"), /--pid\s+<n>/u);
// scroll 现在两种用法都认：参照式 `scroll <ref> <direction>` 与原式 `scroll <direction> --pid`。
// 断言契约（两种形式都出现在 usage 里），不是断言某一个措辞。
// 参照 CLI 的动词名本身就是给 agent 的契约（它的 help 写着
// "start every turn with `alma cu get_app_state <bundle>`"）。
// 本实现原先这两个能力叫 `snap` / `menu` —— 能力在、名字不对，而 agent 是按名字找的。
assert.match(runHelp("get_app_state"), /bundle\|pid/u);
assert.match(runHelp("perform_secondary_action"), /pixel/u);
// 原名保留，避免已有调用断掉
assert.ok(runHelp("snap").length > 0, "snap 作为原名仍应可用");
assert.ok(runHelp("menu").length > 0, "menu 作为原名仍应可用");

assert.match(runHelp("scroll"), /refOrDirection/u);
assert.match(runHelp("scroll"), /\[direction\]/u);
assert.match(runHelp("scroll"), /--pages\s+<n>/u);
assert.match(runHelp("drag"), /<x1>\s+<y1>\s+<x2>\s+<y2>/u);
assert.match(runHelp("raise"), /--window\s+<id>/u);
assert.match(runHelp("lens"), /\[mode\]/u);
assert.match(runHelp("lens"), /on \| off \| toggle/u);
assert.match(runHelp("click"), /--pixel\s+<x>\s+<y\.\.\.>/u);
assert.match(runHelp("click"), /--strategy\s+<name>/u);
assert.match(runHelp("click"), /--button\s+<name>/u);
assert.match(runHelp("click"), /--clicks\s+<n>/u);
// 元素级输入与全局输入是两对动词，别混：type 改 AXValue，type_text 发按键
assert.match(runHelp("type"), /--append/u);
assert.match(runHelp("type"), /<ref>/u);
assert.match(runHelp("press"), /Increment/u);

// `press_key` 的 `global` 必须就地可发现：系统级快捷键表达不出 "投给某个进程"，
// 只能走全局 HID 流 —— 而它此前只存在于守护进程里，四个调用层一处都没传
// （「能力在、路不通」）。补一个反向断言：`type_text` 没有这个语义，
// 别把开关顺手挂到不相干的动词上。
assert.match(runHelp("press_key"), /--global/u);
assert.doesNotMatch(runHelp("type_text"), /--global/u);
// ref 反查 pid 这条路（`cu click e12` 不带 --pid）在帮助文本里要看得出来：
// 不给 pid 是**正常用法**，不是漏参。
assert.match(runHelp("click"), /\[ref\]/u);
assert.doesNotMatch(runHelp("click"), /--pid\s+<n>\s+target pid \(required\)/u);
