import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { ComposerDraftState } from "../src/desktop/renderer/src/components/composer/composerDraft.js";

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
} });
const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
Object.defineProperty(globalThis, "React", { configurable: true, value: React });
try {
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  const draft = new ComposerDraftState();
  draft.update({ draft: { value: "发送普通消息", tokens: [] } });
  const props: React.ComponentProps<typeof Composer> = {
    project: { id: "project", path: "/tmp/project", name: "Project", dirty: false, missing: false, pinned: false, addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
    drafts: new Map([["draft", draft]]), draftKey: "draft", models: [],
    memoryState: "disabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], resourceState: "loading",
    sessionWriterConflict: false, modelSetupRequired: false, focusToken: 0,
    capabilityDefaults: { tools: "auto", skills: "auto" }, skills: [], toolCatalog: [],
    onResume: async () => {}, onSend: async () => {}, onMutateQueuedMessage: async () => {},
    onSubmitEdit: async () => {}, onCancelEdit: () => {}, onSlashCommand: async () => {},
    onStop: async () => {}, onToggleMemory: async () => {}, onSwitchModel: async () => {},
    onSaveAttachment: async () => { throw new Error("not used"); }, onWarning: () => {}, onSubmitError: () => {}
  };
  const render = (overrides: Partial<typeof props> = {}): Document => {
    return new JSDOM(renderToStaticMarkup(React.createElement(Composer, { ...props, ...overrides }))).window.document;
  };
  const document = render();
  const send = document.querySelector('button[aria-label="发送消息"]');
  assert.ok(send, "必须保留发送入口");
  assert.notEqual(send.getAttribute("aria-disabled"), "true", "扩展首连不能禁用普通消息发送");
  assert.equal(send.hasAttribute("disabled"), false);
  const capabilities = document.querySelector('[data-composer-menu="capabilities"]');
  assert.equal(capabilities?.getAttribute("aria-label"), "工具与技能");
  assert.equal(capabilities?.querySelector(".capabilities-spinner"), null, "正常加载不占用输入区状态入口");
  assert.ok(render({ resourceState: "degraded" }).querySelector(".capabilities-status-dot"), "失败仍有可检查的提示");
  assert.equal(render({ sessionWriterConflict: true }).querySelector('button[aria-label="发送消息"]')?.getAttribute("aria-disabled"), "true");
  assert.equal(render({ modelSetupRequired: true }).querySelector('button[aria-label="发送消息"]')?.getAttribute("aria-disabled"), "true");
  assert.equal(render({ memoryToggleBusy: true }).querySelector('button[aria-label="发送消息"]')?.getAttribute("aria-disabled"), "true");
} finally {
  imports.deregister();
  if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
  else Reflect.deleteProperty(globalThis, "React");
}

console.log("Desktop MCP startup tests passed");
