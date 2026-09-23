/** 无界面计算回归：换行/滚动不产生斜向拖尾，技能删除不吞正文。 */
import assert from "node:assert/strict";
import { promptCaretMotion, promptCaretPosition, promptCaretOffset, promptSkillDeletion, promptSkillTokens } from "../src/desktop/renderer/src/components/composer/promptDecorations.js";

const input = { left: 30, top: 100, width: 200, height: 64 };
const host = { left: 20, top: 90 };
const mirror = { left: -10000, top: 0 };
const caret = promptCaretPosition(input, host, mirror, { left: -9960, top: 22, height: 20 }, { left: 5, top: 10 });
assert.deepEqual(caret, { x: 45, y: 22, height: 20 });
for (const measured of [{ left: -10001, top: 0, height: 20 }, { left: -9790, top: 0, height: 20 }, { left: -9990, top: 80, height: 20 }, { left: -9990, top: 0, height: 0 }]) {
  assert.equal(promptCaretPosition(input, host, mirror, measured, { left: 0, top: 0 }), undefined);
}
assert.equal(promptCaretPosition(input, host, mirror, { left: -9990, top: 0, height: 20 }, { left: 0, top: 22 }), undefined);
const first = { x: 10, y: 0, height: 18 };
assert.deepEqual(promptCaretMotion(undefined, first), { snap: true });
assert.deepEqual(promptCaretMotion(first, { ...first, x: 20 }), { snap: false, trail: { left: 10, width: 10, direction: "right" } });
assert.deepEqual(promptCaretMotion(first, { ...first, x: 120 }), { snap: false, trail: { left: 24, width: 96, direction: "right" } });
assert.deepEqual(promptCaretMotion(first, { ...first, x: 0 }), { snap: false, trail: { left: 0, width: 10, direction: "left" } });
assert.deepEqual(promptCaretMotion(first, { ...first, x: 0, y: 22 }), { snap: true });
assert.deepEqual(promptCaretMotion(first, first), { snap: false });
assert.deepEqual(promptCaretMotion(first, { ...first, y: 0.5 }), { snap: true });
assert.deepEqual(promptCaretMotion(first, { ...first, x: 11.5 }), { snap: false });

// Given 拼音组合区暂时是非折叠选区；When 确认成更短的汉字；Then 从拼音尾端向左过渡，而不是首次定位。
assert.equal(promptCaretOffset(0, 6, true), 6);
assert.equal(promptCaretOffset(2, 2, false), 2);
assert.equal(promptCaretOffset(0, 6, false), undefined);
const pinyin = { x: 54, y: 22, height: 18 };
const chinese = { x: 30, y: 22, height: 18 };
assert.deepEqual(promptCaretMotion(pinyin, chinese), { snap: false, trail: { left: 30, width: 24, direction: "left" } });
// 取消候选同样保留回退过渡；真正换行或失焦后重新开始才瞬移。
assert.equal(promptCaretMotion(pinyin, { ...pinyin, x: 0 }).snap, false);
assert.equal(promptCaretMotion(pinyin, { ...chinese, y: 44 }).snap, true);
assert.equal(promptCaretMotion(undefined, chinese).snap, true);

const value = "先看 /skills:diagram 再解释\n/skills:review";
const tokens = promptSkillTokens(value, [{ name: "diagram" }, { name: "review" }]);
assert.deepEqual(tokens, [{ start: 3, end: 18, name: "diagram" }, { start: 23, end: 37, name: "review" }]);
assert.deepEqual(promptSkillTokens("https://a/skills:diagram /skills:unknown", [{ name: "diagram" }]), []);
assert.deepEqual(promptSkillDeletion(value, 19, 19, "Backspace", tokens), { start: 3, end: 19 });
assert.deepEqual(promptSkillDeletion(value, 18, 18, "Backspace", tokens), { start: 3, end: 18 });
assert.deepEqual(promptSkillDeletion(value, 3, 3, "Delete", tokens), { start: 3, end: 19 });
assert.equal(promptSkillDeletion(value, 4, 4, "Backspace", tokens), undefined);
assert.equal(promptSkillDeletion(value, 3, 19, "Backspace", tokens), undefined);
assert.equal(promptSkillDeletion(value, 19, 19, " ", tokens), undefined);
console.log("prompt decoration calculations passed; visual and IME acceptance remains manual");
