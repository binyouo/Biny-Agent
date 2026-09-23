/** 组件的公开标记验证附件名称、大小与操作，视觉效果由用户验收。 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentCard } from "../src/desktop/renderer/src/components/AttachmentCard.js";
import { attachmentSize } from "../src/desktop/renderer/src/attachmentPresentation.js";

const attachment = { name: "项目说明.pdf", path: "@attachments/report.pdf", mimeType: "application/pdf", size: 2048 };
const history = renderToStaticMarkup(createElement(AttachmentCard, { attachment, projectId: "project" }));
assert.match(history, /PDF/u);
assert.match(history, /项目说明.pdf/u);
assert.match(history, /2.0 KB/u);
assert.match(history, /系统应用打开/u);
assert.doesNotMatch(history, /移除/u);
const draft = renderToStaticMarkup(createElement(AttachmentCard, { attachment, projectId: "project", onRemove: () => undefined }));
assert.match(draft, /aria-label="移除 项目说明.pdf"/u);
assert.equal(attachmentSize(0), "0 B");
assert.equal(attachmentSize(undefined), "");
assert.equal(attachmentSize(1024 * 1024), "1.0 MB");
console.log("attachment card tests passed");
