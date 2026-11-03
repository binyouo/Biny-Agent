import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeImage } from "electron";
import { animateDockStartup } from "../src/desktop/electron/main/dockStartupIcon.js";

const frames = { open: { name: "open" } as unknown as NativeImage, closed: { name: "closed" } as unknown as NativeImage };

test("启动眨眼，结束时恢复睁眼并清理所有后续更新", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: unknown[] = [];
  const finish = animateDockStartup({ setIcon: image => { shown.push(image); } }, frames, () => false);
  try {
    assert.deepEqual(shown, [frames.open]);
    context.mock.timers.tick(450);
    assert.equal(shown.at(-1), frames.closed);
    context.mock.timers.tick(130);
    assert.equal(shown.at(-1), frames.open);
    context.mock.timers.tick(1_600);
    assert.equal(shown.at(-1), frames.closed);
    finish();
    assert.equal(shown.at(-1), frames.open);
    const count = shown.length;
    finish();
    context.mock.timers.tick(60_000);
    assert.equal(shown.length, count, "完成、失败或退出后的重复清理不能留下计时器");
  } finally { finish(); }
});

test("快速启动在第一次眨眼前完成，不补播动画", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: unknown[] = [];
  const finish = animateDockStartup({ setIcon: image => { shown.push(image); } }, frames, () => false);
  finish();
  context.mock.timers.tick(60_000);
  assert.ok(shown.every(image => image === frames.open));
});

for (const initiallyReduced of [true, false]) {
  test(`减少动态效果停止眨眼：启动时已开启=${initiallyReduced}`, context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let reduced = initiallyReduced;
    const shown: unknown[] = [];
    const finish = animateDockStartup({ setIcon: image => { shown.push(image); } }, frames, () => reduced);
    try {
      if (!initiallyReduced) {
        context.mock.timers.tick(450);
        assert.equal(shown.at(-1), frames.closed);
        reduced = true;
        context.mock.timers.tick(130);
      }
      assert.equal(shown.at(-1), frames.open);
      const count = shown.length;
      context.mock.timers.tick(60_000);
      assert.equal(shown.length, count);
    } finally { finish(); }
  });
}
