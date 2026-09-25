/** @ 补全只替换光标所在引用词，保留草稿两侧与中文输入法事件。 */
import assert from "node:assert/strict";
import { findReferenceCompletion, replaceReferenceCompletion, referenceKeyAction } from "../src/desktop/renderer/src/components/composer/referenceCompletion.js";

const value = "先看 @会话:周报 再安排";
const position = value.indexOf(" 再");
assert.deepEqual(findReferenceCompletion(value, position), { start: 3, end: position, query: "周报", kind: "thread", unknownPrefix: undefined });
assert.deepEqual(replaceReferenceCompletion(value, findReferenceCompletion(value, position)!, "周报会话", "biny://thread/t1"),
  { value: "先看 @[周报会话](biny://thread/t1) 再安排", cursor: 28 });
assert.equal(findReferenceCompletion("已有 @[标签](biny://thread/t1)", 6), undefined);
assert.deepEqual(findReferenceCompletion("@未知:词", 5), { start: 0, end: 5, query: "词", kind: undefined, unknownPrefix: "未知" });
assert.equal(referenceKeyAction({ key: "Enter", isComposing: true, keyCode: 229, shiftKey: false }, true, true, 2), "native");
assert.equal(referenceKeyAction({ key: "Enter", isComposing: false, keyCode: 13, shiftKey: false }, false, true, 2), "choose");
assert.equal(referenceKeyAction({ key: "Escape", isComposing: false, keyCode: 27, shiftKey: false }, false, true, 2), "dismiss");
console.log("local reference composer tests passed");
