/** Composer 的短引用草稿必须在编辑后保持 URI 身份，发送时才物化。 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptInput } from "../src/desktop/renderer/src/components/composer/PromptInput.js";
import {
  findReferenceCompletion, insertDraftReference, materializeDraftReferences, normalizeDraftReferences,
  reconcileDraftReferenceChange, referenceDraftDeletion, referenceDraftHistoryStep
} from "../src/desktop/renderer/src/components/composer/referenceCompletion.js";

const file = { kind: "file" as const, label: "README.md", uri: "biny://file/README.md", content: "README.md" };
const otherFile = { ...file, uri: "biny://file/docs/README.md" };
const initial = insertDraftReference("先看 @文件:READ 再处理", { start: 3, end: 11, query: "READ", kind: "file" }, file, []);
assert.equal(initial.value, "先看 @README.md 再处理");
assert.equal(initial.cursor, "先看 @README.md".length);
assert.equal(initial.tokens[0]?.uri, file.uri);
assert.equal(findReferenceCompletion(initial.value, initial.tokens[0]!.end, initial.tokens[0]!.end, initial.tokens), undefined);
assert.equal(materializeDraftReferences(initial.value, initial.tokens), "先看 @[README.md](biny://file/README.md) 再处理");

const duplicate = insertDraftReference(`${initial.value} @`, { start: initial.value.length + 1, end: initial.value.length + 2, query: "" }, otherFile, initial.tokens);
assert.match(duplicate.value, /@README\.md 2/u);
assert.match(materializeDraftReferences(duplicate.value, duplicate.tokens), /@\[README\.md 2\]\(biny:\/\/file\/docs\/README\.md\)/u);

const shifted = reconcileDraftReferenceChange(initial.value, `请${initial.value}`, initial.tokens);
assert.equal(materializeDraftReferences(`请${initial.value}`, shifted), `请${materializeDraftReferences(initial.value, initial.tokens)}`);
const edited = initial.value.replace("README", "CHANGED");
assert.deepEqual(reconcileDraftReferenceChange(initial.value, edited, initial.tokens), []);
assert.equal(materializeDraftReferences(edited, []), edited);
assert.deepEqual(referenceDraftDeletion(initial.value, initial.cursor, initial.cursor, "Backspace", initial.tokens),
  { start: 3, end: initial.cursor });
assert.deepEqual(referenceDraftDeletion(initial.value, initial.cursor + 1, initial.cursor + 1, "Backspace", initial.tokens),
  { start: 3, end: initial.cursor + 1 });
assert.deepEqual(referenceDraftDeletion(initial.value, 3, 3, "Delete", initial.tokens),
  { start: 3, end: initial.cursor + 1 });
const removed = initial.value.slice(0, 3) + initial.value.slice(initial.cursor + 1);
assert.deepEqual(reconcileDraftReferenceChange(initial.value, removed, initial.tokens), []);
const removedDraft = { value: removed, tokens: [] };
const history = [{ before: { value: initial.value, tokens: initial.tokens }, after: removedDraft }];
assert.deepEqual(referenceDraftHistoryStep(removedDraft, initial.value, "undo", history), history[0]!.before);
assert.deepEqual(referenceDraftHistoryStep(history[0]!.before, removed, "redo", history), removedDraft);
assert.equal(referenceDraftHistoryStep(removedDraft, "@README.md", "undo", history), undefined);

const restored = normalizeDraftReferences("前文 @[README.md](biny://file/README.md) 后文", []);
assert.equal(restored.value, "前文 @README.md 后文");
assert.equal(materializeDraftReferences(restored.value, restored.tokens), "前文 @[README.md](biny://file/README.md) 后文");
assert.deepEqual(normalizeDraftReferences("@[外部](https://example.invalid)", []).tokens, []);
assert.equal(materializeDraftReferences("@README.md", []), "@README.md");
const markup = renderToStaticMarkup(React.createElement(PromptInput, {
  value: initial.value, referenceTokens: initial.tokens, onChange: () => undefined,
  onReferenceChange: () => undefined, onSubmit: () => undefined, onFiles: () => undefined,
  disabled: false, placeholder: "输入消息…", skills: [], inputRef: React.createRef<HTMLTextAreaElement>()
}));
assert.match(markup, /class="biny-prompt-reference-token" data-reference-kind="file"/u);
assert.match(markup, /<svg[^>]*aria-hidden="true"/u);
assert.doesNotMatch(markup, /biny:\/\/file\/README\.md/u);
console.log("local reference draft tests passed");
