/** 补全只替换光标所在命令，正文、选区与 URL 不应被误改；不执行界面自动化。 */
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptInput } from "../src/desktop/renderer/src/components/composer/PromptInput.js";
import { buildDesktopComposerItems } from "../src/desktop/renderer/src/components/composer/desktopSlashCommands.js";
import { findPromptCompletion, filterPromptCompletions, replacePromptCompletion, promptKeyAction } from "../src/desktop/renderer/src/components/composer/promptCompletion.js";

const items = buildDesktopComposerItems([]);
const review = items.find((item) => item.id === "/review");
assert.ok(review);
assert.deepEqual(findPromptCompletion("/re", 3), { start: 0, end: 3, query: "re" });
assert.deepEqual(filterPromptCompletions(items, "RE"), [review]);
assert.deepEqual(filterPromptCompletions(items, "审查"), [review]);
assert.deepEqual(filterPromptCompletions(items, "不存在"), []);
assert.equal(filterPromptCompletions(items, "").length, items.length);
const skillItems = buildDesktopComposerItems([{
  id: "project:diagram", ref: "project:diagram", name: "diagram", description: "绘制流程图",
  scope: "project", source: "agents", precedence: 1, engine: "biny", linkedEngines: [],
  absolutePath: "/project/.agents/skills/diagram", mdPath: "/project/.agents/skills/diagram/SKILL.md",
  files: [], frontmatter: {}
}]);
const diagram = filterPromptCompletions(skillItems, "流程图");
assert.equal(diagram.length, 1);
assert.equal(diagram[0]?.id, "/skills:diagram");
assert.deepEqual(filterPromptCompletions(skillItems, "skills:dia"), diagram);
const skill = diagram[0];
assert.ok(skill);
assert.deepEqual(replacePromptCompletion("/dia", { start: 0, end: 4, query: "dia" }, skill), { value: "/skills:diagram ", cursor: 16 });
for (const value of ["https://example.test/re", "正文/re", "/review ", "/tmp/file"]) {
  assert.equal(findPromptCompletion(value, value.length), undefined, value);
}
assert.equal(findPromptCompletion("/re", 0, 3), undefined);
assert.equal(findPromptCompletion("/re", -1), undefined);
assert.equal(findPromptCompletion("/re", 10), undefined);
assert.equal(findPromptCompletion("/tmp/file", 3), undefined);
const value = "请检查\n/review 后面的正文";
const range = findPromptCompletion(value, 7);
assert.ok(range);
assert.deepEqual(replacePromptCompletion(value, range, review), { value, cursor: 12 });
assert.deepEqual(replacePromptCompletion("/re", { start: 0, end: 3, query: "re" }, review), { value: "/review ", cursor: 8 });

const enter = { key: "Enter", keyCode: 13, isComposing: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
assert.equal(promptKeyAction(enter, false, false, 0), "submit");
assert.equal(promptKeyAction(enter, true, true, 4), "native");
assert.equal(promptKeyAction({ ...enter, isComposing: true }, false, false, 0), "native");
assert.equal(promptKeyAction({ ...enter, keyCode: 229 }, false, true, 4), "native");
assert.equal(promptKeyAction({ ...enter, shiftKey: true }, false, true, 4), "native");
assert.equal(promptKeyAction(enter, false, true, 4), "choose");
assert.equal(promptKeyAction(enter, false, true, 0), "submit");
assert.equal(promptKeyAction({ ...enter, key: "Tab" }, false, true, 4), "choose");
assert.equal(promptKeyAction({ ...enter, key: "Tab" }, false, false, 0), "native");
assert.equal(promptKeyAction({ ...enter, key: "ArrowDown" }, false, true, 4), "next");
assert.equal(promptKeyAction({ ...enter, key: "ArrowUp" }, false, true, 4), "previous");
assert.equal(promptKeyAction({ ...enter, key: "Escape" }, false, true, 4), "dismiss");
assert.equal(promptKeyAction({ ...enter, key: " " }, false, true, 4), "native");

const markup = renderToStaticMarkup(createElement(PromptInput, {
  referenceTokens: [], onReferenceChange: () => undefined,
  value: "第一行\n<第二行>", onChange: () => undefined, onSubmit: () => undefined,
  onFiles: () => undefined, disabled: true, placeholder: "输入消息…", skills: [],
  inputRef: createRef<HTMLTextAreaElement>()
}));
assert.match(markup, /<textarea/u);
assert.match(markup, /aria-label="任务输入"/u);
assert.match(markup, /disabled=""/u);
assert.match(markup, /第一行\n&lt;第二行&gt;/u);
assert.doesNotMatch(markup, /contenteditable/u);
assert.match(markup, /class="biny-breathing-caret" aria-hidden="true"/u);
assert.match(markup, /class="biny-breathing-caret-trails" aria-hidden="true"/u);
assert.ok(skill.auxiliaryData.kind === "skill");
const decorated = renderToStaticMarkup(createElement(PromptInput, {
  referenceTokens: [], onReferenceChange: () => undefined,
  value: "/skills:diagram 检查代码", onChange: () => undefined, onSubmit: () => undefined,
  onFiles: () => undefined, disabled: false, placeholder: "输入消息…", skills: [skill.auxiliaryData.skill],
  inputRef: createRef<HTMLTextAreaElement>()
}));
assert.match(decorated, /data-skill-name="diagram">\/skills:diagram<\/span>/u);
assert.match(decorated, /<textarea[^>]*>\/skills:diagram 检查代码<\/textarea>/u);
console.log("prompt completion tests passed");
