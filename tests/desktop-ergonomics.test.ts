/** DOM 状态契约使用本地 IPC fake；不代替真实客户端人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

async function harness() {
  const imports = registerHooks({ load(url, context, next) {
    if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  const React = await import("react");
  Object.assign(dom.window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    biny: { updateSettingsDraftState: async () => {}, previewAppearance: async () => {}, activitySettings: async () => { throw new Error("offline"); },
      quickChatSettings: async () => ({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false }),
      activityStatus: async () => { throw new Error("offline"); }, activityPermissions: async () => { throw new Error("offline"); } } });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(dom.window.document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
  dom.window.scrollTo = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element,
    Node: dom.window.Node, navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value }, ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const render = async (node: React.ReactNode) => { await React.act(async () => root.render(node)); };
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await React.act(async () => button.click());
  };
  const input = async (selector: string, value: string) => {
    const element = document.querySelector<HTMLTextAreaElement>(selector)!;
    assert.ok(element, selector);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  return { React, dom, render, click, input, async close() {
    await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test("运行中可直接插话，队列中断操作明确说明会停止当前任务", async () => {
  const h = await harness();
  try {
    const { SendOrStopButton } = await import("../src/desktop/renderer/src/components/composer/SendOrStopButton.js");
    let steered = 0;
    await h.render(h.React.createElement(SendOrStopButton, { running: true, hasDraft: true, disabled: false,
      stopPending: false, onSend() {}, onStop() {}, ...{ onSteer() { steered++; } } }));
    await h.click('[aria-label="立即插话"]');
    assert.equal(steered, 1);
    const { QueuedMessages } = await import("../src/desktop/renderer/src/components/composer/QueuedMessages.js");
    await h.render(h.React.createElement(QueuedMessages, { messages: [{ messageId: "m", content: "补充", attachmentCount: 0, createdAt: "2026-09-30" }],
      running: true, onRemove: async () => {}, onMove: async () => {}, onSteer: async () => {}, onSendNow: async () => {}, onUpdate: async () => {}, onError() {} }));
    assert.match(document.querySelector('[aria-label="停止当前任务并发送队列"]')?.textContent ?? "", /停止并发送/u);
  } finally { await h.close(); }
});

test("队列编辑确认中文候选词不提交，普通 Enter 提交且失败保留编辑文本", async () => {
  const h = await harness();
  try {
    const { QueuedMessages } = await import("../src/desktop/renderer/src/components/composer/QueuedMessages.js");
    const updates: string[] = [];
    await h.render(h.React.createElement(QueuedMessages, { messages: [{ messageId: "m", content: "原文", attachmentCount: 0, createdAt: "2026-09-30" }],
      running: true, onRemove: async () => {}, onMove: async () => {}, onSteer: async () => {}, onSendNow: async () => {},
      onUpdate: async (_id, input) => { updates.push(input); throw new Error("offline"); }, onError() {} }));
    await h.click('.biny-queued-message-content');
    await h.input('textarea', "中文补充");
    await h.React.act(async () => document.querySelector('textarea')!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    assert.deepEqual(updates, []);
    await h.React.act(async () => document.querySelector('textarea')!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(updates, ["中文补充"]);
    assert.equal(document.querySelector('textarea')?.value, "中文补充");
  } finally { await h.close(); }
});

test("聊天草稿在切项目、切会话和取消历史编辑后保留，默认能力更新不清空输入", async () => {
  const h = await harness();
  try {
    const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
    const drafts = new Map();
    const reference = h.React.createRef<import("../src/desktop/renderer/src/components/Composer.js").ComposerHandle>();
    const noop = async () => {};
    const props = { ref: reference, models: [], memoryState: "enabled" as const, memoryToggleBusy: false, memoryToggleDisabled: false,
      running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
      focusToken: 0, capabilityDefaults: { tools: "auto" as const, skills: "auto" as const }, skills: [], toolCatalog: [],
      onSend: noop, onMutateQueuedMessage: noop, onResume: noop, onSubmitEdit: noop, onCancelEdit() {}, onSlashCommand: noop,
      onStop: noop, onToggleMemory: noop, onSwitchModel: noop, onSaveAttachment: async () => { throw new Error("unused"); }, onWarning() {}, onSubmitError() {}, drafts };
    const render = async (scope: string, editingMessage?: { nonce: number; value: string }, tools: "auto" | "all" = "auto", extra: Partial<React.ComponentProps<typeof Composer>> = {}) => {
      const projectId = scope.split(":")[0]!;
      await h.render(h.React.createElement(Composer, { ...props, ...extra, key: scope, draftKey: scope, editingMessage,
        capabilityDefaults: { tools, skills: "auto" }, project: { id: projectId, name: projectId, path: `/tmp/${projectId}`, dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" } }));
    };
    await render("p:a");
    await h.React.act(() => reference.current!.appendText("尚未发送"));
    await render("q:b");
    assert.equal(document.querySelector('textarea')?.value, "");
    await render("p:a");
    assert.equal(document.querySelector('textarea')?.value, "尚未发送 ");
    await render("p:a", undefined, "all");
    assert.equal(document.querySelector('textarea')?.value, "尚未发送 ");
    await render("p:a", { nonce: 1, value: "历史消息" }, "all");
    assert.equal(document.querySelector('textarea')?.value, "历史消息");
    await h.click('[aria-label="取消编辑"]');
    await render("p:a", undefined, "all");
    assert.equal(document.querySelector('textarea')?.value, "尚未发送 ");
    await render("p:b");
    assert.equal(document.querySelector('textarea')?.value, "", "同项目不同会话不能串草稿");
    await render("p:a");
    assert.equal(document.querySelector('textarea')?.value, "尚未发送 ");

    let rejectSend!: (error: Error) => void;
    const send = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    let delivery: string | undefined;
    let errors = 0;
    await render("p:a", undefined, "auto", { running: true, onSend: async (_text, _files, mode) => { delivery = mode; await send; }, onSubmitError() { errors++; } });
    await h.click('[aria-label="立即插话"]');
    assert.equal(delivery, "steer", "插话直接提交 steering，不经过队列编辑");
    await render("q:b");
    await h.React.act(() => reference.current!.appendText("另一个项目"));
    await h.React.act(async () => rejectSend(new Error("offline")));
    assert.equal(document.querySelector('textarea')?.value, "另一个项目 ");
    assert.equal(errors, 0, "旧会话失败不能污染当前会话的错误提示");
    await render("p:a");
    assert.equal(document.querySelector('textarea')?.value, "尚未发送 ", "发送失败回填所属草稿");

    let finishUpload!: (file: { name: string; path: string; mimeType: string; size: number }) => void;
    const upload = new Promise<{ name: string; path: string; mimeType: string; size: number }>(resolve => { finishUpload = resolve; });
    await render("p:a", undefined, "auto", { onSaveAttachment: async () => await upload });
    await h.React.act(async () => {
      const fileInput = document.querySelector('input[type="file"]')!;
      Object.defineProperty(fileInput, "files", { configurable: true, value: [new h.dom.window.File(["file"], "notes.txt", { type: "text/plain" })] });
      fileInput.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
    });
    assert.ok(document.querySelector('[aria-label="正在添加"]'));
    await render("q:b");
    await render("p:a");
    assert.ok(document.querySelector('[aria-label="正在添加"]'), "上传中切回保留等待状态");
    await h.React.act(async () => finishUpload({ name: "notes.txt", path: "/tmp/p/notes.txt", mimeType: "text/plain", size: 4 }));
    assert.ok(document.querySelector('[aria-label="移除 notes.txt"]'));
    await render("q:b");
    assert.equal(document.querySelector('[aria-label="待发送附件"]'), null);
    await render("p:a");
    assert.ok(document.querySelector('[aria-label="移除 notes.txt"]'));
    await render("p:a", { nonce: 2, value: "历史" });
    assert.equal(document.querySelector('[aria-label="待发送附件"]'), null, "编辑历史不混入原草稿附件");
    await h.click('[aria-label="取消编辑"]');
    await render("p:a");
    assert.ok(document.querySelector('[aria-label="移除 notes.txt"]'));
  } finally { await h.close(); }
});

test("设置页分别导航，快速对话深链直接定位对应页面", async () => {
  const h = await harness();
  try {
    const { SettingsOverlay } = await import("../src/desktop/renderer/src/components/settings/SettingsOverlay.js");
    const props = { open: true, version: "test", themePreference: "system", fontPreference: { family: "system", size: 14 }, sessionRunning: false,
      onNotify() {}, onThemePreference() {}, onFontPreference() {}, onSettingsCommitted() {}, onClose() {} };
    await h.render(h.React.createElement(SettingsOverlay, props as unknown as React.ComponentProps<typeof SettingsOverlay>));
    assert.deepEqual([...document.querySelectorAll('.settings-nav-list button')].map(node => node.textContent), [
      "通用", "聊天偏好", "快速对话", "模型供应商", "工具模型", "技能", "MCP 服务器", "插件", "网络搜索", "浏览器",
      "记忆", "活动记录", "对话摘要", "权限", "关于"
    ]);
    await h.render(h.React.createElement(SettingsOverlay, { ...props, targetTab: "快速对话" } as unknown as React.ComponentProps<typeof SettingsOverlay>));
    assert.equal(document.querySelector('.settings-nav-list [aria-current="page"]')?.textContent, "快速对话");
    assert.equal(document.querySelector('[aria-label="聊天分类"]'), null);
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "快速对话");
    await h.render(h.React.createElement(SettingsOverlay, { ...props, targetTab: "配色" } as unknown as React.ComponentProps<typeof SettingsOverlay>));
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "配色");
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索设置"]')!;
    await h.React.act(async () => {
      Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Longhorn");
      search.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(document.querySelector('[aria-label="设置搜索结果"] strong')?.textContent, "配色");
    await h.click('[aria-label="设置搜索结果"] button');
    assert.equal(document.querySelector('.settings-titlebar h2')?.textContent, "配色");
  } finally { await h.close(); }
});

test("移除无实际删除能力的入口和重复文件入口", async () => {
  const { readFile } = await import("node:fs/promises");
  const workspace = await readFile(new URL("../src/desktop/renderer/src/components/Workspace.tsx", import.meta.url), "utf8");
  const messages = await readFile(new URL("../src/desktop/renderer/src/components/MessageTimeline.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(workspace, /WorkspaceFilesButton/u);
  assert.doesNotMatch(messages, /删除消息|onDeleteUserMessage/u);
});

test("项目排序只提供有区别的手动排序与最近打开", async () => {
  const h = await harness();
  try {
    const { Sidebar } = await import("../src/desktop/renderer/src/components/Sidebar.js");
    await h.render(h.React.createElement(Sidebar, { projects: [], sessions: [], layout: { mode: "expanded", contentWidth: 260 },
      peekDrawerHandlers: {}, peekTriggerHandlers: {}, resizeHandlers: {},
    } as unknown as React.ComponentProps<typeof Sidebar>));
    await h.click('[aria-label="项目排序"]');
    assert.deepEqual([...document.querySelectorAll('[aria-label="项目排序菜单"] [role="menuitemradio"]')].map(node => node.textContent), ["最近打开", "手动排序"]);
  } finally { await h.close(); }
});
