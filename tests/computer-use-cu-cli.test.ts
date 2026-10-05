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
                    "set_value", "launch_app", "raise", "lens", "shutdown"]) {
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
assert.match(runHelp("scroll"), /<direction>/u);
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
