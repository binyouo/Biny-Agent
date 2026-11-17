import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopGitStatus } from "../src/desktop/protocol.js";

test("Git refresh reconciles selected paths without scanning every file per selection", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://desktop.local" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let reads = 0;
  const files = Array.from({ length: 1000 }, (_, i) => ({ get path() { reads++; return `file${i}.txt`; }, status: " M" }));
  let snapshot: DesktopGitStatus = { branch: "main", revision: "1", files };
  Object.assign(dom.window, { biny: { projectGitStatus: async () => snapshot, listProjectBranches: async () => [{ name: "main", current: true }] } });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceCommitPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceCommitPanel.js");
  const root = createRoot(document.getElementById("root")!);
  const act = async (action: () => void): Promise<void> => { await React.act(async () => { action(); }); };
  const refresh = async (): Promise<void> => await act(() => dom.window.dispatchEvent(new dom.window.Event("focus")));
  const checkbox = (path: string): HTMLInputElement => document.querySelector(`[aria-label="选择 ${path}"]`)!;
  try {
    await act(() => root.render(React.createElement(WorkspaceCommitPanel, { projectId: "p", active: true, onCount() {}, onSwitchBranch: async () => {}, onPreviewFile() {} })));
    await act(() => document.querySelector<HTMLInputElement>('[aria-label="选择所有变更"]')!.click());
    reads = 0;
    await refresh();
    const selectedRefreshReads = reads;
    t.diagnostic(`selected refresh path reads: ${selectedRefreshReads}`);
    assert.ok(selectedRefreshReads < 20000, `refresh must stay linear, got ${selectedRefreshReads} path reads`);
    assert.equal(document.querySelectorAll('input[type="checkbox"]:checked').length, 1001);
    // Removed selections are discarded, retained selections survive order/status changes,
    // and new files are not silently selected.
    snapshot = { branch: "main", revision: "2", files: [
      { path: "file999.txt", status: "UU" }, { path: "new.txt", status: "??" }, { path: "file1.txt", status: " M" }
    ] };
    await refresh();
    assert.equal(checkbox("file999.txt").checked, true);
    assert.equal(checkbox("file999.txt").disabled, true);
    assert.equal(checkbox("file1.txt").checked, true);
    assert.equal(checkbox("new.txt").checked, false);
    assert.equal(document.querySelector('[aria-label="选择 file0.txt"]'), null);
    snapshot = { branch: "main", revision: "3", files: [] };
    await refresh();
    assert.equal(document.querySelectorAll('input[type="checkbox"]:checked').length, 0);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
