/** 组件契约测试使用 DOM 与 IPC 替身，不执行网页或桌面自动化验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopBrowserAction, DesktopBrowserSnapshot } from "../src/desktop/protocol.js";
import type { LocalReferenceResult } from "../src/session/localReferences.js";

test("浏览器导航参数、引用搜索乱序与解析失败重试", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://localhost/" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class ResizeObserver { observe(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const actions: DesktopBrowserAction[] = [];
  const imports: string[] = [];
  const fixes: string[] = [];
  const previewEntries: string[] = [];
  let previewAvailable = true;
  let previewError: string | undefined;
  let chooseHtml = false;
  const snapshot: DesktopBrowserSnapshot = { projectId: "p", revision: 0, tabs: [] };
  const searches: Array<(results: LocalReferenceResult[]) => void> = [];
  let resolveFails = true;
  const object: LocalReferenceResult = { kind: "skill", uri: "biny://skill/s", label: "当前引用", content: "完整的功能用法" };
  Object.assign(dom.window, { biny: {
    browserSnapshot: async () => snapshot, onBrowserState: () => () => {}, browserBounds: async () => {},
    listTerminals: async () => [], onTerminalEvent: () => () => {},
    projectPreviewAvailability: async () => previewAvailable ? (chooseHtml ? { available: true, kind: "static", entry: "a.html", entries: ["a.html", "pages/b.html"] } : { available: true, kind: "static", entry: "index.html", entries: ["index.html"] }) : ({ available: false, reason: "没有预览入口" }),
    projectPreviewStatus: async () => previewError ? ({ kind: "failed", error: previewError }) : ({ kind: "stopped" }),
    startProjectPreview: async (_projectId: string, entry?: string) => { if (!previewAvailable) throw new Error("没有预览入口"); if (entry) previewEntries.push(entry); return { kind: "static", url: "http://127.0.0.1:3000/" }; },
    stopProjectPreview: async () => {},
    listBrowserProfiles: async () => [{ id: "chrome:Default", appName: "Google Chrome", profileName: "Person 1" }],
    importBrowserProfile: async (profileId: string) => { imports.push(profileId); return { imported: 3, failed: 0, appName: "Google Chrome" }; },
    browserAction: async (_projectId: string, action: DesktopBrowserAction) => { actions.push(action); return snapshot; },
    referenceSearch: async () => await new Promise<LocalReferenceResult[]>((resolve) => searches.push(resolve)),
    referenceResolve: async () => { if (resolveFails) throw new Error("对象暂不可读"); return object; }
  } });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceBrowserPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceBrowserPanel.js");
  const { WorkspaceReferencesPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceReferencesPanel.js");
  const root = createRoot(document.getElementById("root")!);
  const input = async (label: string, value: string): Promise<void> => {
    await React.act(async () => {
      const field = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const submit = async (): Promise<void> => { await React.act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); };
  try {
    await React.act(async () => root.render(React.createElement(WorkspaceBrowserPanel, { projectId: "p", active: true, onWarning() {}, onOpenTerminal() {}, onFixPreview(error: string) { fixes.push(error); } })));
    assert.doesNotMatch(document.body.textContent!, /连接日常浏览器|复制配对地址/);
    await input("网页地址", "javascript:alert(1)"); await submit();
    assert.equal(actions.length, 0); assert.match(document.querySelector('[role="alert"]')!.textContent!, /HTTP/);
    await input("网页地址", "localhost:5173"); await submit();
    assert.deepEqual(actions[0], { type: "new", url: "http://localhost:5173/" });
    await React.act(async () => ([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("运行预览")) as HTMLButtonElement).click());
    assert.deepEqual(actions[1], { type: "new", url: "http://127.0.0.1:3000/" });
    await React.act(async () => ([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("停止预览")) as HTMLButtonElement).click());
    chooseHtml = true;
    await React.act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    await React.act(async () => ([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("运行预览")) as HTMLButtonElement).click());
    assert.match(document.body.textContent!, /pages\/b.html/);
    await React.act(async () => ([...document.querySelectorAll("button")].find((button) => button.textContent === "pages/b.html") as HTMLButtonElement).click());
    assert.deepEqual(previewEntries, ["pages/b.html"]);
    await React.act(async () => ([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("停止预览")) as HTMLButtonElement).click());
    await React.act(async () => (document.querySelector('[aria-label="复用浏览器登录态"]') as HTMLButtonElement).click());
    assert.match(document.body.textContent!, /Google Chrome · Person 1/);
    await React.act(async () => (document.querySelector(".inspector-profile-picker > button") as HTMLButtonElement).click());
    assert.deepEqual(imports, ["chrome:Default"]);
    assert.match(document.body.textContent!, /导入 3 个 Cookie/);
    previewAvailable = false;
    await React.act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(document.body.textContent!, /没有预览入口/);
    assert.equal(document.querySelector(".inspector-preview-failure"), null);
    assert.ok([...document.querySelectorAll("button")].filter((button) => button.textContent?.includes("运行预览")).every((button) => button.disabled), "没有预览入口时禁用启动，保持普通空状态");
    assert.deepEqual(fixes, []);
    previewAvailable = true; previewError = "构建失败，请检查项目日志";
    await React.act(async () => root.render(React.createElement(WorkspaceBrowserPanel, { key: "failed", projectId: "p", active: true, onWarning() {}, onOpenTerminal() {} })));
    assert.equal((document.body.textContent!.match(/构建失败，请检查项目日志/g) ?? []).length, 1, "失败原因只显示一次");
    function References(): React.ReactNode {
      const [reference, setReference] = React.useState<LocalReferenceResult>();
      return React.createElement(WorkspaceReferencesPanel, { projectId: "p", reference, onSelect: setReference });
    }
    await React.act(async () => root.render(React.createElement(References)));
    await input("查找引用", "旧查询"); await submit();
    await input("查找引用", "新查询"); await submit();
    await React.act(async () => { searches[1]!([object]); });
    await React.act(async () => { searches[0]!([{ ...object, label: "过期结果" }]); });
    assert.equal(document.body.textContent!.includes("过期结果"), false);
    await React.act(async () => (document.querySelector(".inspector-reference-result") as HTMLButtonElement).click());
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /对象暂不可读/);
    resolveFails = false;
    await React.act(async () => (document.querySelector(".inspector-reference-result") as HTMLButtonElement).click());
    assert.match(document.querySelector(".inspector-reference-content")!.textContent!, /完整的功能用法/);
    await React.act(async () => root.render(React.createElement(WorkspaceReferencesPanel, {
      projectId: "p", reference: { ...object, content: "仅搜索摘要" }, onSelect() {}
    })));
    assert.match(document.querySelector(".inspector-reference-content")!.textContent!, /完整的功能用法/);
    assert.equal(document.body.textContent!.includes("仅搜索摘要"), false);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
