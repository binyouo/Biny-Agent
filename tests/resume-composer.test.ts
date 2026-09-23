/** 验证输入语义与按钮的可访问标记，不执行界面交互；视觉仍由用户验收。 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isResumeInput } from "../src/desktop/renderer/src/components/composer/resumeInput.js";
import { SendOrStopButton } from "../src/desktop/renderer/src/components/composer/SendOrStopButton.js";

for (const input of ["", "  ", "继续", "继续任务", "继续上次的任务", "继续。", "/continue"]) {
  assert.equal(isResumeInput(input, 0), true, input);
  assert.equal(isResumeInput(input, 1), false, "附件不能被恢复入口吞掉");
}
for (const input of ["继续优化这个文件", "先改其他任务", "/status"]) assert.equal(isResumeInput(input, 0), false);
const render = (options: Partial<Parameters<typeof SendOrStopButton>[0]>): string => renderToStaticMarkup(createElement(SendOrStopButton, {
  disabled: false, hasDraft: false, running: false, stopPending: false,
  onSend: () => { throw new Error("展示不能自动执行"); }, onStop: () => undefined,
  ...options
}));
const paused = render({ resume: true });
assert.match(paused, /aria-label="继续上次任务"/u);
assert.doesNotMatch(paused, /aria-label="发送消息"|aria-disabled="true"/u);
assert.equal((paused.match(/<button\b/gu) ?? []).length, 1);
assert.match(render({ resume: true, resumePending: true, disabled: true }), /aria-busy="true"/u);
assert.match(render({ resume: true, disabled: true, disabledReason: "先核对执行结果" }), /aria-disabled="true"/u);
const running = render({ running: true, hasDraft: true });
assert.match(running, /aria-label="暂停生成"/u);
assert.match(running, /aria-label="加入队列"/u);
assert.match(render({ disabled: true }), /aria-label="发送消息"/u);
console.log("resume composer tests passed");
