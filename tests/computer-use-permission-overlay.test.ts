import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PERMISSION_OVERLAY_HEIGHT,
  PERMISSION_OVERLAY_WIDTH,
  findTargetRow,
  overlayBounds,
  parseOcrLines
} from "../src/desktop/electron/main/computerPermissionGeometry.js";

const workArea = { x: 0, y: 0, width: 1512, height: 982 };

// 浮层存在的理由：辅助功能只能在系统设置里开，而那一页是一长串应用，
// 用户不知道该点哪一行。它算错位置就完全失去意义。
test("the guide floats under its target and never off the screen", () => {
  const target = { x: 400, y: 300, width: 200, height: 30 };
  const placed = overlayBounds(target, workArea);
  assert.equal(placed.width, PERMISSION_OVERLAY_WIDTH);
  assert.equal(placed.height, PERMISSION_OVERLAY_HEIGHT);
  // 目标下方居中
  assert.equal(placed.x, 400 + 100 - PERMISSION_OVERLAY_WIDTH / 2);
  assert.ok(placed.y > target.y + target.height, "要落在目标下方，不能压住它");

  // 贴左边缘：不能探出屏幕
  assert.ok(overlayBounds({ x: 0, y: 10, width: 40, height: 20 }, workArea).x >= 0);
  // 贴右边缘同理
  const right = overlayBounds({ x: 1500, y: 10, width: 20, height: 20 }, workArea);
  assert.ok(right.x + right.width <= workArea.width, "右侧不能越界");
  // 目标贴着屏幕底部时，浮层要收在可见区内
  const bottom = overlayBounds({ x: 400, y: 970, width: 200, height: 10 }, workArea);
  assert.ok(bottom.y + bottom.height <= workArea.height, "底部不能越界");
});

test("ocr lines parse into rects, and malformed rows are dropped", () => {
  const lines = parseOcrLines("52,15,55,15\tGhostty\n1157,310,48,18\t辅助功能\nnot-a-line\n1,2,3\tmissing-column\n9,9,9,9\t\n");
  assert.equal(lines.length, 2, "只保留四列齐全且非空文本的行");
  assert.deepEqual(lines[0], { text: "Ghostty", rect: { x: 52, y: 15, width: 55, height: 15 } });
  assert.equal(lines[1]?.text, "辅助功能");
});

test("the target row prefers the app that asked for the grant", () => {
  const lines = parseOcrLines([
    "100,40,60,18\t辅助功能",
    "100,300,40,16\tSafari",
    "100,420,120,16\tBiny Computer Use",
    "100,520,60,16\tGhostty"
  ].join("\n"));

  const hit = findTargetRow(lines, "Biny Computer Use");
  assert.ok(hit, "必须找到申请权限的那一行");
  // 框住的必须是那一行，不是标题也不是别的应用
  assert.ok(hit.y >= 400 && hit.y < 520, `应命中 Biny 那一行，实际 y=${hit.y}`);
  assert.ok(hit.height > 16, "要扩成整行高度，否则只框住文字、指不到右侧开关");

  // 列表里还没有它时退到页面标题，至少把人带到对的页面
  const fallback = findTargetRow(lines, "Not Installed Yet");
  assert.ok(fallback, "找不到应用行时退回标题");
  assert.ok(fallback.y < 100, "标题在页面顶部");

  // 两样都没有 = 这一页不认识，调用方应收起浮层而不是随便指
  assert.equal(findTargetRow(parseOcrLines("1,1,1,1\tSomething Else"), "Biny"), undefined);
});

// 窗口契约在 Electron 之外测不了（模块 import electron），用源码断言钉住。
test("the guide window is an unfocusable floating panel", async () => {
  const source = await readFile(new URL("../src/desktop/electron/main/ComputerPermissionOverlay.ts", import.meta.url), "utf8");
  assert.match(source, /PERMISSION_OVERLAY_WIDTH as WIDTH/, "尺寸要来自几何模块，别两处各写一份");
  assert.match(source, /focusable: false/, "引导窗绝不能抢焦点——用户正要去操作系统设置");
  assert.match(source, /alwaysOnTop: true/);
  assert.match(source, /type: "panel"/, "mac 上要取 floating 层级");
  assert.match(source, /setOpacity\(0\.9\)/, "Alma 的引导窗是 0.9 透明度");
  assert.match(source, /showInactive\(\)/, "显示时不能激活自己");
  assert.match(source, /TRACK_INTERVAL_MS = 250/, "Alma 的跟踪节奏是 250ms");
  // locate 比 tick 间隔慢时（截屏+OCR 要一秒），没有重入保护就会堆成请求风暴。
  assert.match(source, /let running = false/, "跟踪必须防重入");
  assert.match(source, /辅助功能/);
});
