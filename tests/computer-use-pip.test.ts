import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Alma 把 PiP 定义为「3fps 的连续画面，目的是可注视而非流畅」。
// 这里断言窗口的对外契约：连续刷新 + 用户随时能夺回控制权。
test("preview window presents a live 3fps surface with takeover controls", async () => {
  const source = await readFile(new URL("../src/desktop/electron/main/ComputerPreviewWindow.ts", import.meta.url), "utf8");
  assert.match(source, /3fps/, "预览窗必须说明它是连续画面，而不是只在动作后刷新一帧");
  assert.doesNotMatch(source, /动作后更新/, "旧的「动作后更新」语义与 3fps 帧泵矛盾");
  for (const control of ["pause", "takeover", "stop"]) {
    assert.match(source, new RegExp(`biny-computer:${control}`), `预览窗必须保留 ${control} 出口，用户随时能夺回控制权`);
  }
  assert.match(source, /img id="frame"/, "帧位必须存在，否则帧泵无处落图");
  assert.match(source, /Activity 暂停截图/, "预览开启时 Activity 必须让出截图通道");
  // 支持键盘操作，初次呈现通过 showInactive 保留前台焦点。
  assert.match(source, /focusable: true/, "浮窗须支持用户主动聚焦后的键盘操作");
  // Alma 的 PiP 是 vibrancy 材质的 hud 小窗：窗口要声明材质，页面不能再铺实色底。
  assert.match(source, /vibrancy: "hud"/, "预览窗要用 HUD 材质");
  assert.match(source, /backgroundColor: "#00000000"/, "窗口底色必须透明，否则材质透不出来");
  assert.doesNotMatch(source, /body\{margin:0;background:#2/, "页面不能铺不透明底色，那会把材质盖掉");
});
