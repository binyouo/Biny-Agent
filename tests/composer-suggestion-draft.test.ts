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

test("successful suggestion submission preserves the unsent text, reference history, and attachments for reopening", { timeout: 10_000 }, async () => {
  const h = await fixture();
  try {
    const suggestion = document.querySelector<HTMLButtonElement>(".suggestion-chip");
    assert.equal(suggestion?.textContent, "整理近期工作");
    assert.equal(suggestion.disabled, false, "suggestions remain available beside a nonempty draft and attachments");
    assert.deepEqual(h.draft.getSnapshot().draft, h.original.draft);
    assert.deepEqual(h.draft.getSnapshot().attachments, h.original.attachments);
    let submitted!: Promise<void>;
    await h.React.act(async () => { submitted = h.ref.current!.submitSuggestion("整理近期工作"); });
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0]?.[0], "整理近期工作");
    assert.deepEqual(h.sends[0]?.[1], []);
    assert.deepEqual(h.sends[0]?.[4], { tools: [], skills: [] });
    await h.React.act(async () => { h.result.resolve(); await submitted; });
    assert.deepEqual(h.draft.getSnapshot(), { ...h.original, pendingAttachments: [], submitting: false }, "sending a suggestion must not discard an unrelated unsent draft");
    await h.render({ draftKey: "p:new-session" });
    await h.render();
    assert.deepEqual(h.props.drafts.get("p:draft")!.getSnapshot(), { ...h.original, pendingAttachments: [], submitting: false });
    assert.deepEqual(h.props.drafts.get("p:new-session")!.getSnapshot().draft, { value: "", tokens: [] });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const outcome of ["success", "failure"] as const) {
  test(`a ${outcome} suggestion receipt preserves newer callback-provided text and attachments`, { timeout: 10_000 }, async () => {
    const h = await fixture();
    try {
      let submitted!: Promise<void>;
      await h.React.act(async () => { submitted = h.ref.current!.submitSuggestion("整理近期工作"); });
      await h.React.act(async () => {
        h.ref.current!.appendText("补充参考");
        h.draft.update(current => ({ attachments: [...current.attachments,
          { id: "late-appshot", name: "capture.png", path: "/synthetic/capture.png", mimeType: "image/png", size: 2 }] }));
      });
      const newer = structuredClone(h.draft.getSnapshot());
      await h.React.act(async () => {
        if (outcome === "success") h.result.resolve(); else h.result.reject(new Error("send failed"));
        await submitted;
      });
      assert.deepEqual(h.draft.getSnapshot(), { ...newer, submitting: false }, "a late receipt cannot replace a draft it did not submit");
      assert.deepEqual(h.errors, outcome === "success" ? [] : ["send failed"]);
      assert.deepEqual(h.sends[0]?.[1], []);
    } finally { await h.close(); }
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`ordinary draft submission still ${outcome === "success" ? "clears the submitted draft" : "restores the submitted draft on failure"}`, { timeout: 10_000 }, async () => {
    const h = await fixture();
    try {
      await h.React.act(async () => h.input().onSubmit());
      assert.equal(h.sends.length, 1);
      assert.equal(h.sends[0]?.[0], "看看 @[notes.txt](biny://file/notes.txt)");
      assert.deepEqual(h.sends[0]?.[1], h.original.attachments);
      assert.deepEqual(h.draft.getSnapshot(), { draft: { value: "", tokens: [] }, history: [], attachments: [], pendingAttachments: [], submitting: true });
      assert.equal(h.input().disabled, true, "ordinary keyboard editing remains disabled while submission is pending");
      await h.React.act(async () => {
        if (outcome === "success") h.result.resolve(); else h.result.reject(new Error("send failed"));
      });
      assert.deepEqual(h.draft.getSnapshot(), outcome === "success"
        ? { draft: { value: "", tokens: [] }, history: [], attachments: [], pendingAttachments: [], submitting: false }
        : { ...h.original, pendingAttachments: [], submitting: false });
      assert.deepEqual(h.errors, outcome === "success" ? [] : ["send failed"]);
    } finally { await h.close(); }
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`a slash-command suggestion also preserves the unrelated draft on ${outcome}`, { timeout: 10_000 }, async () => {
    const h = await fixture();
    try {
      let submitted!: Promise<void>;
      await h.React.act(async () => { submitted = h.ref.current!.submitSuggestion("/goal show"); });
      assert.deepEqual(h.commands, ["/goal show"]);
      assert.deepEqual(h.sends, []);
      await h.React.act(async () => {
        if (outcome === "success") h.result.resolve(); else h.result.reject(new Error("goal failed"));
        await submitted;
      });
      assert.deepEqual(h.draft.getSnapshot(), { ...h.original, pendingAttachments: [], submitting: false });
      assert.deepEqual(h.warnings, outcome === "success" ? [] : ["goal failed"]);
    } finally { await h.close(); }
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`an explicitly submitted slash draft still ${outcome === "success" ? "clears" : "restores on failure"} its command`, { timeout: 10_000 }, async () => {
    const h = await fixture();
    try {
      await h.React.act(async () => h.draft.update({ draft: { value: "/goal show", tokens: [] }, history: [] }));
      await h.React.act(async () => h.input().onSubmit());
      assert.deepEqual(h.commands, ["/goal show"]);
      assert.deepEqual(h.sends, []);
      assert.equal(h.draft.getSnapshot().draft.value, "");
      await h.React.act(async () => {
        if (outcome === "success") h.result.resolve(); else h.result.reject(new Error("goal failed"));
      });
      assert.deepEqual(h.draft.getSnapshot(), { draft: { value: outcome === "success" ? "" : "/goal show", tokens: [] },
        history: [], attachments: h.original.attachments, pendingAttachments: [], submitting: false });
      assert.deepEqual(h.warnings, outcome === "success" ? [] : ["goal failed"]);
    } finally { await h.close(); }
  });
}
