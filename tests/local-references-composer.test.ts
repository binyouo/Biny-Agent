/** @ 补全只替换光标所在引用词，保留草稿两侧与中文输入法事件。 */
import assert from "node:assert/strict";
import { findReferenceCompletion, insertDraftReference, referenceKeyAction, referenceKindLabel, referenceResultSubtitle } from "../src/desktop/renderer/src/components/composer/referenceCompletion.js";

const value = "先看 @会话:周报 再安排";
const position = value.indexOf(" 再");
assert.deepEqual(findReferenceCompletion(value, position), { start: 3, end: position, query: "周报", kind: "thread", unknownPrefix: undefined });
assert.deepEqual(insertDraftReference(value, findReferenceCompletion(value, position)!,
  { kind: "thread", label: "周报会话", uri: "biny://thread/t1" }, []),
  { value: "先看 @周报会话 再安排", cursor: 8,
    tokens: [{ start: 3, end: 8, label: "周报会话", uri: "biny://thread/t1", kind: "thread" }] });
assert.equal(findReferenceCompletion("已有 @[标签](biny://thread/t1)", 6), undefined);
assert.deepEqual(findReferenceCompletion("@未知:词", 5), { start: 0, end: 5, query: "词", kind: undefined, unknownPrefix: "未知" });
assert.equal(findReferenceCompletion("@子代理:reviewer", 13)?.kind, "agent");
assert.equal(referenceKindLabel("thread"), "会话");
assert.equal(referenceResultSubtitle({ kind: "date", label: "今天", uri: "biny://date/2026-09-25/2026-09-26/Asia%2FShanghai",
  content: JSON.stringify({ startDate: "2026-09-25", endDate: "2026-09-26", timeZone: "Asia/Shanghai" }) }),
  "2026-09-25 → 2026-09-26（结束日不含） · Asia/Shanghai");
assert.equal(referenceKeyAction({ key: "Enter", isComposing: true, keyCode: 229, shiftKey: false }, true, true, 2), "native");
assert.equal(referenceKeyAction({ key: "Enter", isComposing: false, keyCode: 13, shiftKey: false }, false, true, 2), "choose");
assert.equal(referenceKeyAction({ key: "Escape", isComposing: false, keyCode: 27, shiftKey: false }, false, true, 2), "dismiss");
console.log("local reference composer tests passed");
