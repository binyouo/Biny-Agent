/** 分块必须使用 Markdown 语法边界，不能按空行切断围栏、列表或引用定义。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarkdownBlockParser, splitMarkdownBlocks } from "../src/desktop/renderer/src/markdownBlocks.js";

test("追加正文时已完成块保持相同内容，可直接复用渲染结果", () => {
  const prefix = "# 标题\n\n第一段 **说明**。\n\n";
  const before = splitMarkdownBlocks(`${prefix}第二段`);
  const after = splitMarkdownBlocks(`${prefix}第二段继续增长\n\n第三段`);
  assert.equal(before.length, 3);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  assert.equal(after.join(""), `${prefix}第二段继续增长\n\n第三段`);
});

test("逐字追加的增量解析与全文解析一致，包括后置定义、替换和回退", () => {
  const parse = createMarkdownBlockParser();
  for (const text of [
    "# 标题\n\n前言\n\n- 项目\n\n  续段\n\n结束\n\n```ts\na\n\n```\n\n后记",
    "第一段 [文档][id]\n\n第二段\n\n第三段\n\n[id]: https://example.com\n\n末尾",
    "首段\n\n正文[^1]\n\n第三段\n\n[^1]: 脚注\n\n尾段",
    "前言\n\n标题\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n尾段",
    "前言\r\n\r\n段落\r\n\r\n$$\r\na\r\n$$\r\n\r\n末尾"
  ]) {
    for (let i = 0; i <= text.length; i++) assert.deepEqual(parse(text.slice(0, i)), splitMarkdownBlocks(text.slice(0, i)));
    assert.deepEqual(parse(text.slice(0, 5)), splitMarkdownBlocks(text.slice(0, 5)));
    assert.deepEqual(parse(""), [""]);
  }
});

test("围栏、嵌套列表、表格、公式和 Setext 标题不被拆散", () => {
  for (const block of [
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "- 第一项\n\n  第二段\n  - 子项\n\n- 第二项",
    "| A | B |\n| - | - |\n| 1 | 2 |",
    "$$\na + b\n\nc\n$$",
    "标题\n===="
  ]) {
    const content = `前言\n\n${block}\n\n尾段`;
    assert.deepEqual(splitMarkdownBlocks(content), ["前言\n\n", `${block}\n\n`, "尾段"]);
  }
});

test("后置链接与脚注定义保留全文作用域；删除、替换、未闭合围栏不复用旧块", () => {
  for (const content of ["[链接][id]\n\n[id]: https://example.com", "正文[^1]\n\n[^1]: 注释", "> [id]: https://example.com\n\n[id]"]) {
    assert.deepEqual(splitMarkdownBlocks(content), [content]);
  }
  assert.equal(splitMarkdownBlocks("前言\n\n```ts\n未闭合\n\n仍在围栏").length, 2);
  assert.deepEqual(splitMarkdownBlocks(""), [""]);
  assert.deepEqual(splitMarkdownBlocks("替换内容"), ["替换内容"]);
});
