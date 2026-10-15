import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopGitCommitInput, DesktopGitStatus } from "../src/desktop/protocol.js";

test("Git 状态刷新不禁用提交说明，提交成功只清除本次已提交的草稿", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const snapshot: DesktopGitStatus = { branch: "main", revision: "1", files: [{ path: "a.txt", status: " M" }] };
  const writes: DesktopGitCommitInput[] = [];
  let releaseRead: ((value: DesktopGitStatus) => void) | undefined;
  let releaseCommit: ((value: DesktopGitStatus) => void) | undefined;
  let deferRead = false;
  Object.assign(dom.window, { biny: {
    projectGitStatus: async () => deferRead ? await new Promise<DesktopGitStatus>(resolve => { releaseRead = resolve; }) : snapshot,
    listProjectBranches: async () => [{ name: "main", current: true }],
    commitProjectFiles: async (_projectId: string, input: DesktopGitCommitInput) => {
      writes.push(input);
      return await new Promise<DesktopGitStatus>(resolve => { releaseCommit = resolve; });
    }
  } });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceCommitPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceCommitPanel.js");
  const root = createRoot(document.getElementById("root")!);
  const act = async (action: () => void): Promise<void> => { await React.act(async () => { action(); }); };
  const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('[aria-label="提交说明"]')!;
  const type = async (value: string): Promise<void> => {
    assert.equal(field().disabled, false, "只读刷新与后台提交不阻断草稿编辑");
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field(), value);
      field().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const submit = async (): Promise<void> => { await act(() => document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); };
  try {
    await act(() => root.render(React.createElement(WorkspaceCommitPanel, { projectId: "p", active: true, onCount() {}, onSwitchBranch: async () => {}, onPreviewFile() {} })));
    await type("第一笔提交");
    await act(() => field().focus());
    deferRead = true;
    await act(() => dom.window.dispatchEvent(new dom.window.Event("focus")));
    await type("第一笔提交（继续编辑）");
    assert.equal(document.activeElement, field(), "刷新保留编辑焦点");
    await act(() => releaseRead!(snapshot)); deferRead = false;
    await act(() => document.querySelector<HTMLInputElement>('[aria-label="选择 a.txt"]')!.click());
    await submit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.message, "第一笔提交（继续编辑）");
    await type("下一笔提交草稿");
    await submit();
    assert.equal(writes.length, 1, "在途事务不能重复派发");
    await act(() => releaseCommit!({ ...snapshot, revision: "2" }));
    assert.equal(field().value, "下一笔提交草稿", "旧提交成功不清空后来输入");
    await act(() => document.querySelector<HTMLInputElement>('[aria-label="选择 a.txt"]')!.click());
    await submit();
    await act(() => releaseCommit!({ ...snapshot, revision: "3" }));
    assert.equal(field().value, "", "未再编辑时仍清除本次成功提交的说明");
  } finally {
    await act(() => { releaseRead?.(snapshot); releaseCommit?.(snapshot); root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
