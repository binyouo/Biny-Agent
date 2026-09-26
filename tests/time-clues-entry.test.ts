/** 侧栏入口的静态展示契约；悬浮与视觉效果由客户端人工验收。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("时间线索仅显示图标，并提供用途提示和弹窗语义", async () => {
  const source = await readFile(new URL("../src/desktop/renderer/src/components/Sidebar.tsx", import.meta.url), "utf8");
  const button = source.match(/<button aria-label="时间线索"[\s\S]*?<\/button>/u)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /<span|title=/u);
  assert.match(button, /aria-haspopup="dialog"/u);
  assert.match(button, /onClick=\{onTimeClues\}/u);
  assert.match(source, /<Tooltip content="时间线索" delay=\{150\}/u);
  assert.doesNotMatch(source, /时间线索：查看对话中提到的日期/u);
});
