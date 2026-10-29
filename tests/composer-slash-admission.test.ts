/** 建议只提交建议正文；通过公开回调检查草稿状态，不模拟界面输入。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { ComposerHandle } from "../src/desktop/renderer/src/components/Composer.js";

registerHooks({ load(url, context, next) {
  if (url.endsWith("/composer/PromptInput.tsx")) return { format: "module", shortCircuit: true, source: `
    import { createElement } from "react";
    import { PromptInput as Original } from ${JSON.stringify(`${url}?callback-fixture`)};
    export function PromptInput(props) { window.__draftTestInput = props; return createElement(Original, props); }
  ` };
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
} });

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {},
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {} });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(window, "biny", { value: { activitySuggestions: async () => ["整理近期工作"], readInlineImage: async () => undefined } });
  const { Workspace } = await import("../src/desktop/renderer/src/components/Workspace.js");
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  const { ComposerDraftState } = await import("../src/desktop/renderer/src/components/composer/composerDraft.js");
  const draft = new ComposerDraftState();
  const original = {
    draft: { value: "看看 @notes.txt", tokens: [{ start: 3, end: 13, label: "notes.txt", uri: "biny://file/notes.txt", kind: "file" as const }] },
    history: [{ before: { value: "看看 ", tokens: [] }, after: { value: "看看 @notes.txt", tokens: [{ start: 3, end: 13, label: "notes.txt", uri: "biny://file/notes.txt", kind: "file" as const }] } }],
    attachments: [{ id: "synthetic-file", name: "draft.txt", path: "/synthetic/draft.txt", mimeType: "text/plain", size: 1 }]
  };
  draft.update(original);
  const ref = React.createRef<ComposerHandle>();
  const result = deferred();
  const sends: unknown[][] = [];
  const commands: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const noop = async (): Promise<void> => {};
  const props: React.ComponentProps<typeof Composer> = {
    ref, project: { id: "p", name: "p", path: "/synthetic/project", dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" },
    drafts: new Map([["p:draft", draft]]), draftKey: "p:draft", models: [],
    memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
    focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
    onSend: async (...args) => { sends.push(args); await result.promise; }, onMutateQueuedMessage: noop, onResume: noop,
    onSubmitEdit: noop, onCancelEdit: () => {}, onSlashCommand: async command => { commands.push(command); await result.promise; }, onStop: noop,
    onToggleMemory: noop, onSwitchModel: noop, onSaveAttachment: async () => { throw new Error("unused"); },
    onWarning: message => { warnings.push(message); }, onSubmitError: message => { errors.push(message); }
  };
  const root = createRoot(document.getElementById("root")!);
  const render = async (overrides: Partial<typeof props> = {}) => {
    const unused = (): never => { throw new Error("unrelated workspace action"); };
    const workspaceProps: React.ComponentProps<typeof Workspace> = { turns: [], loading: false, thinking: false, running: false, projectId: "p",
      project: props.project, runtimePanelOpen: false, heroStart: true,
      onSendActivitySuggestion: async (text: string) => { await ref.current?.submitSuggestion(text); },
      onRuntimeError: (error: unknown) => { errors.push(String(error)); },
      onOpenProject: unused, onPreviewFile: unused, onRuntimePanelOpenChange: unused, onOpenExternal: unused,
      onReferenceMessage: unused, onShowMessageReferences: unused, onAddQuoteToConversation: unused,
      onResolvePermission: unused, onRetry: unused, onSwitchVersion: unused, onRetryRuntime: unused,
      onEditRequest: unused, onDismissGenerationError: unused, onCreateBranch: unused, onRollbackFiles: unused,
      onRuntimeMutation: unused, onRuntimeRefresh: unused, onOpenRuntime: unused, onOpenExtensions: unused
    };
    await React.act(async () => root.render(React.createElement(Workspace, workspaceProps,
      React.createElement(Composer, { ...props, ...overrides, key: overrides.draftKey ?? props.draftKey }))));
  };
  await render();
  return { React, ref, draft, original, props, result, sends, commands, errors, warnings, render,
    input: () => (window as unknown as { __draftTestInput: { onSubmit(): void; disabled: boolean } }).__draftTestInput,
    async close() {
      await React.act(() => root.unmount()); dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

for (const newer of ["none", "append", "empty"] as const) {
  test(`stale slash admission failure preserves draft ownership: ${newer}`, async () => {
    const h = await fixture(); let current = true;
    try {
      await h.render({ isSubmissionCurrent: () => current });
      const originalDraft = { value: "/tasks", tokens: [] };
      const originalHistory = [{ before: { value: "/task", tokens: [] }, after: originalDraft }];
      await h.React.act(async () => h.draft.update({ draft: originalDraft, history: originalHistory }));
      await h.React.act(async () => h.input().onSubmit());
      assert.deepEqual(h.commands, ["/tasks"]); assert.equal(h.draft.getSnapshot().draft.value, "");
      current = false;
      await h.React.act(async () => {
        if (newer === "append") h.ref.current!.appendText("new owner input");
        if (newer === "empty") h.draft.update({ draft: { value: "", tokens: [] }, history: [] });
      });
      const before = h.draft.getSnapshot();
      await h.React.act(async () => h.result.reject(new Error("old admission rejected")));
      assert.deepEqual(h.warnings, []);
      assert.equal(h.draft.getSnapshot().draft, newer === "none" ? originalDraft : before.draft);
      assert.deepEqual(h.draft.getSnapshot().history, newer === "none" ? originalHistory : before.history);
      assert.deepEqual(h.draft.getSnapshot().attachments, h.original.attachments);
    } finally { await h.close(); }
  });
}
test("current slash rejection restores original draft/history and reports the failure", async () => {
  const h = await fixture();
  try {
    const originalDraft = { value: "/tasks", tokens: [] };
    const originalHistory = [{ before: { value: "/task", tokens: [] }, after: originalDraft }];
    await h.React.act(async () => h.draft.update({ draft: originalDraft, history: originalHistory }));
    await h.React.act(async () => h.input().onSubmit());
    await h.React.act(async () => h.result.reject(new Error("admission rejected")));
    assert.equal(h.draft.getSnapshot().draft, originalDraft);
    assert.deepEqual(h.draft.getSnapshot().history, originalHistory);
    assert.deepEqual(h.warnings, ["admission rejected"]);
  } finally { await h.close(); }
});
