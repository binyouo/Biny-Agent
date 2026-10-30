import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopWorkspaceFilePreview, DesktopWorkspaceDirectoryEntry, DesktopWorkspaceDirectory } from "../src/desktop/protocol.js";
import type { SessionFileChange } from "../src/desktop/renderer/src/sessionChanges.js";

async function withInspector(check: (fixture: {
  preview(path: string): void;
  act(action: () => void): Promise<void>;
  reads: Array<{ path: string; resolve(file: DesktopWorkspaceFilePreview): void; reject(error: Error): void }>;
  directories: string[];
  tree: Map<string, DesktopWorkspaceDirectoryEntry[]>;
  directoryReplies: Map<string, Promise<DesktopWorkspaceDirectory>>;
  recordChange(path: string): Promise<void>;
  render(source?: string, projectId?: string): Promise<void>;
}) => Promise<void>, viewportWidth = 1024): Promise<void> {
  const hook = registerHooks({ load(url, context, next) {
    if (url.includes("/@xterm/xterm/")) return { format: "module", source: "export class Terminal {}", shortCircuit: true };
    if (url.includes("/@xterm/addon-fit/")) return { format: "module", source: "export class FitAddon {}", shortCircuit: true };
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    return next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: viewportWidth });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const { useWorkspaceInspector } = await import("../src/desktop/renderer/src/components/workspace/useWorkspaceInspector.js");
    const reads: Array<{ path: string; resolve(file: DesktopWorkspaceFilePreview): void; reject(error: Error): void }> = [];
    const directories: string[] = [];
    const tree = new Map<string, DesktopWorkspaceDirectoryEntry[]>();
    const directoryReplies = new Map<string, Promise<DesktopWorkspaceDirectory>>();
    const initialChanges: SessionFileChange[] = [];
    const options = {
      changes: initialChanges, tools: [], skills: [], filePanelResizing: false, filePanelWidth: 800, projectId: "p", source: "p:s",
      onFilePanelResizeEnd() {}, onFilePanelResizeStart() {}, onFilePanelWidthChange() {},
      onListDirectory: async (path: string) => { directories.push(path); return await (directoryReplies.get(path) ?? Promise.resolve({ path, entries: tree.get(path) ?? [] })); },
      onOpenFile() {}, onOpenBrowser: async () => {}, onSwitchBranch: async () => {}, onFixPreview() {}, onWarning() {},
      onReadFile: async (path: string) => await new Promise<DesktopWorkspaceFilePreview>((resolve, reject) => reads.push({ path, resolve, reject }))
    };
    let inspector!: ReturnType<typeof useWorkspaceInspector>;
    function Harness() {
      inspector = useWorkspaceInspector(options);
      return React.createElement("div", null, inspector.rail, inspector.dock);
    }
    const root = createRoot(document.getElementById("root")!);
    const act = async (action: () => void): Promise<void> => { await React.act(async () => { action(); }); };
    const render = async (source = "p:s", projectId = "p"): Promise<void> => {
      options.source = source; options.projectId = projectId;
      await act(() => root.render(React.createElement(Harness)));
    };
    try {
      await render();
      await check({ preview: path => inspector.previewFile(path), act, reads, directories, tree, directoryReplies, render,
        recordChange: async path => {
          const count = (options.changes.find(change => change.path === path)?.changeCount ?? 0) + 1;
          options.changes = [...options.changes.filter(change => change.path !== path), {
            path, operation: "update", changeCount: count, diff: `+change ${String(count)}`, add: count, del: 0, status: "completed"
          }];
          await render();
        }
      });
    } finally {
      await act(() => root.unmount());
    }
  } finally {
    dom.window.close(); hook.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const file = (path: string): DesktopWorkspaceFilePreview => ({ path, bytes: 100, binary: true, truncated: false });

test("当前文件出现新的操作记录后再次选择会重读，其他文件变化不使它失效", async () => {
  await withInspector(async ({ preview, act, reads, recordChange }) => {
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.resolve(file("a.bin")));
    await recordChange("a.bin");
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 2, "新的已知文件变更不能被重复选择优化遮蔽");
    await act(() => reads[1]!.resolve(file("a.bin")));
    await recordChange("b.bin");
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 2, "其他文件变更不重复读取当前文件");
  });
});

test("重复选择当前文件合并在途读取，已显示内容不会因再次选择重建", async () => {
  await withInspector(async ({ preview, act, reads, directories }) => {
    await act(() => { preview("a.bin"); preview("a.bin"); });
    assert.equal(reads.length, 1, "同一交互批次只读取一次文件");
    assert.deepEqual(directories, ["."], "顺带目录读取也不重复");
    await act(() => reads[0]!.resolve(file("a.bin")));
    const content = document.querySelector(".file-preview-state");
    assert.ok(content);
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 1, "重复选择已显示文件不会重新读盘");
    assert.equal(document.querySelector(".file-preview-state"), content, "保留阅读节点及其局部状态");
    await act(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click();
      document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click();
    });
    assert.equal(reads.length, 2, "显式刷新仍重新读取文件");
    assert.deepEqual(directories, [".", "."], "连点刷新合并正在进行的目录读取");
    await act(() => reads[1]!.resolve(file("a.bin")));
  });
});

test("读取失败后再次选择可以重试，切换文件的迟到结果不覆盖当前内容", async () => {
  await withInspector(async ({ preview, act, reads }) => {
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.reject(new Error("文件暂不可读")));
    assert.match(document.body.textContent ?? "", /文件暂不可读/u);
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 2);
    await act(() => preview("b.bin"));
    await act(() => reads[2]!.resolve(file("b.bin")));
    await act(() => reads[1]!.resolve(file("a.bin")));
    assert.equal(document.querySelector(".file-browser-path-label")?.textContent, "b.bin");
  });
});

test("关闭文件、切换会话或项目后选择同路径会重新读取", async () => {
  await withInspector(async ({ preview, act, reads, render }) => {
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.resolve(file("a.bin")));
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭当前文件"]')!.click());
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 2);
    await render("p:s2");
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 3);
    await render("q:s", "q");
    await act(() => preview("a.bin"));
    assert.equal(reads.length, 4);
    await act(() => reads[3]!.resolve(file("a.bin")));
    await act(() => { reads[1]!.resolve(file("old.bin")); reads[2]!.resolve(file("old.bin")); });
    assert.equal(document.querySelector(".file-browser-path-label")?.textContent, "a.bin");
  });
});

test("收起文件树后关闭当前文件仍能看到文件列表，再选文件时保持文件树可见", async () => {
  await withInspector(async ({ preview, act, reads, tree }) => {
    tree.set(".", [{ name: "a.bin", path: "a.bin", kind: "file" }, { name: "b.bin", path: "b.bin", kind: "file" }]);
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.resolve(file("a.bin")));
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="隐藏文件树"]')!.click());
    assert.equal(document.querySelector(".file-browser-body")?.classList.contains("is-tree-hidden"), true);

    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭当前文件"]')!.click());
    assert.match(document.querySelector(".file-browser-content")?.textContent ?? "", /选择要预览的文件/u);
    assert.equal(document.querySelector(".file-browser-body")?.classList.contains("is-tree-hidden"), false);
    assert.match(document.querySelector('[role="treeitem"]')?.textContent ?? "", /a\.bin$/u);

    await act(() => document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')[1]!.click());
    await act(() => reads[1]!.resolve(file("b.bin")));
    assert.equal(document.querySelector(".file-browser-path-label")?.textContent, "b.bin");
    assert.equal(document.querySelector(".file-browser-body")?.classList.contains("is-tree-hidden"), false);
  }, 1600);
});


test("刷新文件树只读取可见展开目录，重新打开隐藏分支时按需加载新内容", async () => {
  await withInspector(async ({ preview, act, reads, directories, tree }) => {
    tree.set(".", [{ name: "src", path: "src", kind: "directory" }]);
    tree.set("src", [{ name: "nested", path: "src/nested", kind: "directory" }]);
    tree.set("src/nested", [{ name: "old.txt", path: "src/nested/old.txt", kind: "file" }]);
    const click = async (text: string) => await act(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(row => row.textContent === text);
      assert.ok(button, `可见目录 ${text}`); button.click();
    });
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.resolve(file("a.bin")));
    await click("src"); await click("nested"); await click("src");
    tree.set("src/nested", [{ name: "new.txt", path: "src/nested/new.txt", kind: "file" }]);
    directories.length = 0;
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click());
    assert.deepEqual(directories, ["."], "折叠父目录下保留的展开标记不能触发读盘");
    await click("src");
    assert.deepEqual(directories, [".", "src", "src/nested"], "重新打开时保留子目录展开意图，并刷新失效缓存");
    assert.match(document.body.textContent ?? "", /new.txt/u);
    assert.doesNotMatch(document.body.textContent ?? "", /old.txt/u);
    directories.length = 0;
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click());
    assert.deepEqual(directories, [".", "src", "src/nested"], "可见的展开分支仍参与显式刷新");
    await act(() => reads.at(-1)!.resolve(file("a.bin")));
  });
});


test("刷新使隐藏分支的在途结果失效，不让迟到内容成为重新展开后的缓存", async () => {
  await withInspector(async ({ preview, act, reads, directories, tree, directoryReplies }) => {
    tree.set(".", [{ name: "src", path: "src", kind: "directory" }]);
    tree.set("src", [{ name: "nested", path: "src/nested", kind: "directory" }]);
    const pending = Promise.withResolvers<DesktopWorkspaceDirectory>();
    directoryReplies.set("src/nested", pending.promise);
    const click = async (name: string) => await act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(row => row.textContent === name)!.click();
    });
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.resolve(file("a.bin")));
    await click("src"); await click("nested"); await click("src");
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click());
    directoryReplies.delete("src/nested");
    tree.set("src/nested", [{ name: "fresh.txt", path: "src/nested/fresh.txt", kind: "file" }]);
    await act(() => pending.resolve({ path: "src/nested", entries: [{ name: "stale.txt", path: "src/nested/stale.txt", kind: "file" }] }));
    directories.length = 0;
    await click("src");
    assert.deepEqual(directories, ["src", "src/nested"]);
    assert.match(document.body.textContent ?? "", /fresh.txt/u);
    assert.doesNotMatch(document.body.textContent ?? "", /stale.txt/u);
    await act(() => reads.at(-1)!.resolve(file("a.bin")));
  });
});


test("文件树保留反斜杠目录身份，展开、预览、收起和刷新不会跳到同名嵌套目录", async () => {
  await withInspector(async ({ preview, act, reads, directories, tree }) => {
    const literal = "report\\draft";
    tree.set(".", [{ name: literal, path: literal, kind: "directory" }, { name: "report", path: "report", kind: "directory" }]);
    tree.set(literal, [{ name: "literal.bin", path: `${literal}/literal.bin`, kind: "file" }]);
    tree.set("report", [{ name: "draft", path: "report/draft", kind: "directory" }]);
    tree.set("report/draft", [{ name: "nested.bin", path: "report/draft/nested.bin", kind: "file" }]);
    const click = async (name: string) => await act(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(row => row.querySelector("span:last-child")?.textContent === name);
      assert.ok(button, `可见条目 ${name}`); button.click();
    });
    await act(() => preview("a.bin"));
    await act(() => reads[0]!.resolve(file("a.bin")));
    await click(literal);
    assert.deepEqual(directories, [".", literal]);
    await click("literal.bin");
    assert.equal(reads.at(-1)!.path, `${literal}/literal.bin`);
    await act(() => reads.at(-1)!.resolve(file(`${literal}/literal.bin`)));
    await click("report"); await click("draft");
    assert.deepEqual(directories, [".", literal, "report", "report/draft"]);
    await click(literal);
    assert.doesNotMatch(document.querySelector('[role="tree"]')?.textContent ?? "", /literal.bin/u);
    assert.match(document.querySelector('[role="tree"]')?.textContent ?? "", /nested.bin/u);
    await click(literal);
    assert.equal(directories.length, 4, "重新展开使用同身份缓存，不多读另一路径");
    directories.length = 0;
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click());
    assert.deepEqual(new Set(directories), new Set([".", literal, "report", "report/draft"]));
    await act(() => reads.at(-1)!.resolve(file(`${literal}/literal.bin`)));
  });
});
