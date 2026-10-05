/** 表格控件按当前可见数据复制、下载；界面效果仍由人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";
import { serializeMarkdownTable } from "../src/desktop/renderer/src/components/markdownTableExport.js";

async function mountTable() {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const writes: Array<Record<string, Blob>> = [];
  const textWrites: string[] = [];
  class ClipboardEntry {
    constructor(readonly data: Record<string, Blob>) {}
  }
  Object.assign(globalThis, { ClipboardItem: ClipboardEntry });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: ClipboardEntry[]) => { writes.push(...items.map(item => item.data)); },
      writeText: async (value: string) => { textWrites.push(value); }
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { MarkdownTable } = await import("../src/desktop/renderer/src/components/MarkdownTable.js");
  const root = createRoot(document.getElementById("root")!);
  const children = (extra = false) => React.createElement(React.Fragment, null,
    React.createElement("thead", null, React.createElement("tr", null,
      React.createElement("th", { style: { textAlign: "left" } }, " 名称 "),
      React.createElement("th", { style: { textAlign: "right" } }, " 状态 ")
    )),
    React.createElement("tbody", null,
      React.createElement("tr", null,
        React.createElement("td", null, ' a,"b" '),
        React.createElement("td", null, React.createElement("strong", null, " 完成 "))
      ),
      extra ? React.createElement("tr", null, React.createElement("td", null, " 追加 "), React.createElement("td", null, " 2 ")) : null
    )
  );
  const render = (extra = false, streaming = false) => React.act(() => flushSync(() => root.render(React.createElement(MarkdownTable, { children: children(extra), streaming }))));
  render();
  const trigger = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement;
  let selectedMenu: Element | null = null;
  const open = (label: string) => React.act(() => flushSync(() => {
    const button = trigger(label);
    selectedMenu = button.closest(".markdown-table-action, details");
    button.click();
  }));
  const choose = async (label: string) => {
    const option = selectedMenu?.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
    assert.ok(option, `存在 ${label} 选项`);
    await React.act(async () => option.click());
  };
  return { dom, root, render, trigger, open, choose, writes, textWrites, dispose: () => { React.act(() => flushSync(() => root.unmount())); dom.window.close(); } };
}

test("复制表格同时提供当前 CSV 文本与可粘贴的 HTML，成功关闭菜单并反馈", async () => {
  const fixture = await mountTable();
  try {
    fixture.render(true);
    fixture.open("复制表格");
    await fixture.choose("CSV");
    assert.equal(fixture.writes.length, 1, "复制为双格式剪贴板内容");
    assert.equal(await fixture.writes[0]!["text/plain"]!.text(), '名称,状态\n"a,""b""",完成\n追加,2');
    const html = await fixture.writes[0]!["text/html"]!.text();
    assert.match(html, /<table[^>]*>/);
    assert.match(html, /<strong> 完成 <\/strong>/);
    assert.match(html, /text-align: right/);
    assert.equal(fixture.trigger("复制表格").getAttribute("aria-expanded"), "false");
    assert.equal(fixture.trigger("复制表格").getAttribute("title"), "已复制");
    assert.deepEqual(fixture.textWrites, []);
  } finally { fixture.dispose(); }
});

test("剪贴板拒绝后显示错误并保留菜单，不绕过失败或显示成功", async () => {
  const fixture = await mountTable();
  try {
    navigator.clipboard.write = async () => { throw new Error("denied"); };
    fixture.open("复制表格");
    await fixture.choose("TSV");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /复制失败/);
    assert.equal(fixture.trigger("复制表格").getAttribute("aria-expanded"), "true");
    assert.equal(fixture.trigger("复制表格").getAttribute("title"), "复制表格");
    assert.deepEqual(fixture.textWrites, []);
  } finally { fixture.dispose(); }
});

test("只支持文本的剪贴板仍可复制 TSV，成功反馈在两秒后复原", async () => {
  const fixture = await mountTable();
  const callbacks = new Map<number, () => void>();
  let delay = 0;
  fixture.dom.window.setTimeout = ((callback: () => void, milliseconds: number) => {
    delay = milliseconds;
    callbacks.set(1, callback);
    return 1;
  }) as typeof fixture.dom.window.setTimeout;
  fixture.dom.window.clearTimeout = (id: number) => { callbacks.delete(id); };
  try {
    Object.defineProperty(navigator.clipboard, "write", { value: undefined });
    fixture.open("复制表格");
    await fixture.choose("TSV");
    assert.deepEqual(fixture.textWrites, ['名称\t状态\na,"b"\t完成']);
    assert.equal(delay, 2_000);
    const reset = callbacks.get(1);
    assert.ok(reset);
    React.act(() => reset());
    assert.equal(fixture.trigger("复制表格").getAttribute("title"), "复制表格");
    fixture.open("复制表格");
    await fixture.choose("TSV");
    fixture.dispose();
    assert.equal(callbacks.size, 0, "卸载时回收复制反馈定时器");
  } finally {
    if (document.querySelector(".markdown-table-block")) fixture.dispose();
  }
});

test("流式表格禁用资源操作但保持表格节点和横向位置，完成后恢复操作", async () => {
  const fixture = await mountTable();
  try {
    const scroller = document.querySelector(".markdown-table") as HTMLElement;
    const table = scroller.querySelector("table");
    const cell = table?.querySelector("td");
    scroller.scrollLeft = 48;
    fixture.render(true, true);
    assert.equal((fixture.trigger("复制表格") as HTMLButtonElement).disabled, true);
    assert.equal((fixture.trigger("下载表格") as HTMLButtonElement).disabled, true);
    fixture.render(true, false);
    assert.equal((fixture.trigger("复制表格") as HTMLButtonElement).disabled, false);
    assert.equal(document.querySelector(".markdown-table"), scroller);
    assert.equal(scroller.querySelector("table"), table);
    assert.equal(table?.querySelector("td"), cell);
    assert.equal(scroller.scrollLeft, 48);
    fixture.open("复制表格");
    await React.act(async () => fixture.dom.window.document.dispatchEvent(new fixture.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(fixture.trigger("复制表格").getAttribute("aria-expanded"), "false");
  } finally { fixture.dispose(); }
});

test("下载从最新单元格提取格式，CSV 成功后收起菜单", async () => {
  const fixture = await mountTable();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let content: Blob | undefined;
  let filename = "";
  URL.createObjectURL = (blob: Blob) => { content = blob; return "blob:table"; };
  URL.revokeObjectURL = () => undefined;
  document.addEventListener("click", event => {
    if (event.target instanceof fixture.dom.window.HTMLAnchorElement) {
      filename = event.target.download;
      event.preventDefault();
    }
  });
  try {
    fixture.render(true);
    fixture.open("下载表格");
    await fixture.choose("CSV");
    assert.equal(filename, "table.csv");
    assert.equal(await content?.text(), '名称,状态\n"a,""b""",完成\n追加,2');
    assert.equal(content?.type, "text/csv;charset=utf-8");
    assert.equal(fixture.trigger("下载表格").getAttribute("aria-expanded"), "false");
    fixture.open("下载表格");
    await fixture.choose("Markdown");
    assert.equal(filename, "table.md");
    assert.equal(await content?.text(), '| 名称 | 状态 |\n| --- | --- |\n| a,"b" | 完成 |\n| 追加 | 2 |');
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; fixture.dispose(); }
});

test("生产 Markdown 表格管线保留允许的 HTML 换行并可导出", () => {
  const markup = renderToStaticMarkup(React.createElement(MarkdownContent, {
    content: "| Value |\n| --- |\n| north<br>south |",
    projectId: "synthetic-test-project",
    onPreviewFile: () => undefined,
    onOpenExternal: () => undefined
  }));
  const dom = new JSDOM(markup);
  try {
    const table = dom.window.document.querySelector("table");
    assert.ok(table);
    assert.equal(table.querySelector("td")?.innerHTML, "north<br>south");
    assert.equal(serializeMarkdownTable(table, "csv"), 'Value\n"north\nsouth"');
  } finally { dom.window.close(); }
});

test("导出保留单元格换行，并继续按各格式转义", () => {
  const dom = new JSDOM(`<table>
    <thead><tr><th> Head<br>line </th></tr></thead>
    <tbody>
      <tr><td><strong>alpha, "q"</strong><br><em>beta|\tgamma</em></td></tr>
      <tr><td><br>leading</td></tr>
      <tr><td>trailing<br></td></tr>
      <tr><td>north<br><br>south</td></tr>
    </tbody>
  </table>`);
  try {
    const table = dom.window.document.querySelector("table")!;
    assert.equal(serializeMarkdownTable(table, "csv"), '"Head\nline"\n"alpha, ""q""\nbeta|\tgamma"\n"\nleading"\n"trailing\n"\n"north\n\nsouth"');
    assert.equal(serializeMarkdownTable(table, "tsv"), "Head\\nline\nalpha, \"q\"\\nbeta|\\tgamma\n\\nleading\ntrailing\\n\nnorth\\n\\nsouth");
    assert.equal(serializeMarkdownTable(table, "markdown"), "| Head<br>line |\n| --- |\n| alpha, \"q\"<br>beta\\|\tgamma |\n| <br>leading |\n| trailing<br> |\n| north<br><br>south |");
  } finally { dom.window.close(); }
});

const trimBoundaryCases = [
  { name: "换行前仅有空白文本", cell: "&nbsp;<br>  leading", previous: "leading", logical: "\nleading" },
  { name: "换行后仅有空白文本", cell: "trailing  <br>&nbsp;", previous: "trailing", logical: "trailing\n" },
  { name: "多个前置换行和空白片段", cell: "&nbsp;<br>&nbsp;<br>  leading", previous: "leading", logical: "\n\nleading" },
  { name: "仅含空白文本和连续换行", cell: "&nbsp;<br>&nbsp; <br>&nbsp;", previous: "", logical: "\n\n" }
] as const;

for (const value of trimBoundaryCases) {
  for (const format of ["csv", "tsv", "markdown"] as const) {
    test(`单元格在 ${value.name} 时独立保留修剪结果与结构换行（${format}）`, () => {
      const markup = renderToStaticMarkup(React.createElement(MarkdownContent, {
        content: `| H |\n| --- |\n| ${value.cell} |`,
        projectId: "synthetic-trim-boundary-test",
        onPreviewFile: () => undefined,
        onOpenExternal: () => undefined
      }));
      const dom = new JSDOM(markup);
      try {
        const table = dom.window.document.querySelector("table")!;
        const cell = table.querySelector("td")!;
        assert.ok(cell.querySelector("br"), "实际 Markdown/raw/sanitize 管线保留 BR");
        assert.equal(cell.textContent!.trim(), value.previous, "维持此前的外侧 textContent.trim 行为");
        const expected = format === "csv" ? `H\n"${value.logical}"`
          : format === "tsv" ? `H\n${value.logical.replaceAll("\n", "\\n")}`
            : `| H |\n| --- |\n| ${value.logical.replaceAll("\n", "<br>")} |`;
        assert.equal(serializeMarkdownTable(table, format), expected);
      } finally { dom.window.close(); }
    });
  }
}

test("没有结构换行时保持原有的空白文本裁剪", () => {
  const dom = new JSDOM('<table><thead><tr><th> H </th></tr></thead><tbody><tr><td> &nbsp; leading </td></tr><tr><td>trailing &nbsp; </td></tr><tr><td> &nbsp; </td></tr></tbody></table>');
  try {
    const table = dom.window.document.querySelector("table")!;
    assert.equal(serializeMarkdownTable(table, "csv"), "H\nleading\ntrailing\n");
    assert.equal(serializeMarkdownTable(table, "tsv"), "H\nleading\ntrailing\n");
    assert.equal(serializeMarkdownTable(table, "markdown"), "| H |\n| --- |\n| leading |\n| trailing |\n|  |");
  } finally { dom.window.close(); }
});
