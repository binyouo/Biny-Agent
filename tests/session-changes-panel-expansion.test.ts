/** 变更详情按需读取，默认突出实际增删，后续内容分批可达；DOM 断言不代替视觉验收。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { SessionFileChange } from "../src/desktop/renderer/src/sessionChanges.js";

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  return next(url, context);
} });
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, React, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true
})) {
  savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
after(() => {
  dom.window.close();
  imports.deregister();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const { createRoot } = await import("react-dom/client");
const { SessionChangesPanel } = await import("../src/desktop/renderer/src/components/workspace/SessionChangesPanel.js");

function change(index: number, diff: string): SessionFileChange {
  return { path: `src/module-${String(index)}.ts`, operation: "update", changeCount: 1, diff, add: 1, del: 1, status: "completed" };
}

function fullFileDiff(contextLines: number): string {
  return ["--- a/file.ts", "+++ b/file.ts", "@@",
    ...Array.from({ length: contextLines }, (_unused, index) => ` const line${String(index)} = ${String(index)};`),
    "-const changed = 1;", "+const changed = 2;"].join("\n");
}

const document = dom.window.document;
const renderedLines = (): NodeListOf<HTMLElement> => document.querySelectorAll(".biny-session-change-diff [data-line]");
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === text);
  assert.ok(result, `存在按钮：${text}`);
  return result;
}
async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
}
async function withPanel(changes: SessionFileChange[], check: () => Promise<void>): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(SessionChangesPanel, { changes, onPreviewFile: () => undefined })));
    await check();
  } finally {
    await act(async () => root.unmount());
  }
}

test("收起的文件只展示摘要，不读取其他文件的差异详情", async () => {
  const reads = [0, 0];
  const changes = reads.map((_unused, index) => {
    const value = change(index, "");
    Object.defineProperty(value, "diff", { get() { reads[index]! += 1; return fullFileDiff(3_000); } });
    return value;
  });
  await withPanel(changes, async () => {
    assert.deepEqual(reads, [0, 0]);
    assert.equal(renderedLines().length, 0);
    await click(document.querySelector<HTMLButtonElement>(".biny-session-change-row")!);
    assert.ok(reads[0]! > 0);
    assert.equal(reads[1], 0, "未打开文件不读取差异");
    assert.ok(document.querySelector('[data-line="add"]')?.textContent?.includes("const changed = 2;"));
  });
});

test("默认展开直接看到文件末尾的真实增删及相邻上下文", async () => {
  await withPanel([change(0, fullFileDiff(3_000))], async () => {
    await click(document.querySelector<HTMLButtonElement>(".biny-session-change-row")!);
    assert.equal(document.querySelector('[data-line="del"] .merged-diff-text')?.textContent, "const changed = 1;");
    assert.equal(document.querySelector('[data-line="add"] .merged-diff-text')?.textContent, "const changed = 2;");
    assert.equal(document.querySelector('[data-line="add"] .merged-diff-ln')?.textContent, "3001");
    assert.equal(renderedLines().length, 5, "保留改动前 3 行上下文和一对增删");
    assert.ok(document.querySelector(".merged-diff-gap"), "省略的上下文具有明确间隔");
  });
});

test("多处变更保留各自上下文与原始行号，重叠上下文不重复", async () => {
  const diff = ["--- a/file.ts", "+++ b/file.ts", "@@",
    " before0", " before1", " before2", " before3", "-old first", "+new first",
    " middle0", " middle1", " middle2", " middle3", " middle4", " middle5", " middle6", " middle7",
    "-old second", "+new second", " after0", " after1", " after2", " after3",
    "@@ -40,1 +50,1 @@", "-old last", "+new last"].join("\n");
  await withPanel([change(0, diff)], async () => {
    await click(button("展开"));
    assert.deepEqual([...renderedLines()].map(line => line.querySelector(".merged-diff-text")?.textContent), [
      "before1", "before2", "before3", "old first", "new first", "middle0", "middle1", "middle2",
      "middle5", "middle6", "middle7", "old second", "new second", "after0", "after1", "after2",
      "old last", "new last"
    ]);
    assert.deepEqual([...document.querySelectorAll('[data-line="add"] .merged-diff-ln')].map(line => line.textContent), ["5", "14", "50"]);
    assert.deepEqual([...document.querySelectorAll('[data-line="del"] .merged-diff-ln')].map(line => line.textContent), ["5", "14", "40"]);
  });
});

test("大量变更每次继续显示最多 500 行，全部可达，折叠再展开恢复默认规模", async () => {
  const diff = ["--- a/file.ts", "+++ b/file.ts", "@@",
    ...Array.from({ length: 1_202 }, (_unused, index) => `+added ${String(index)}`)].join("\n");
  await withPanel([change(0, diff)], async () => {
    await click(button("展开"));
    assert.equal(renderedLines().length, 500);
    await click(button("继续显示 500 行（还有 702 行）"));
    assert.equal(renderedLines().length, 1_000);
    await click(button("继续显示 202 行（还有 202 行）"));
    assert.equal(renderedLines().length, 1_202);
    assert.equal(renderedLines().item(1_201).querySelector(".merged-diff-text")?.textContent, "added 1201");
    await click(button("折叠"));
    assert.equal(renderedLines().length, 0);
    await click(button("展开"));
    assert.equal(renderedLines().length, 500, "折叠后不得沿用上次展开的全部节点");
  });
});

test("完整上下文通过明确入口分批显示，返回精简展示仍可见真实变更", async () => {
  await withPanel([change(0, fullFileDiff(1_200))], async () => {
    await click(button("展开"));
    await click(button("显示完整上下文"));
    assert.equal(renderedLines().length, 500);
    assert.equal(renderedLines().item(0).querySelector(".merged-diff-text")?.textContent, "const line0 = 0;");
    await click(button("继续显示 500 行（还有 702 行）"));
    assert.equal(renderedLines().length, 1_000);
    await click(button("继续显示 202 行（还有 202 行）"));
    assert.equal(renderedLines().length, 1_202);
    assert.equal(document.querySelector('[data-line="add"] .merged-diff-text')?.textContent, "const changed = 2;");
    await click(button("仅显示变更附近"));
    assert.equal(renderedLines().length, 5);
    assert.equal(document.querySelector('[data-line="add"] .merged-diff-text')?.textContent, "const changed = 2;");
  });
});

test("批量展开每个文件都展示真实改动且各自受默认行数上限约束", async () => {
  const changes = Array.from({ length: 12 }, (_unused, index) => change(index, fullFileDiff(2_000)));
  await withPanel(changes, async () => {
    await click(button("展开"));
    const rows = document.querySelectorAll(".biny-session-change.is-open");
    assert.equal(rows.length, 12);
    for (const row of rows) {
      assert.ok(row.querySelector('[data-line="add"]')?.textContent?.includes("const changed = 2;"));
      assert.ok(row.querySelectorAll("[data-line]").length <= 500);
    }
  });
});
