import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Workspace } from "../src/desktop/renderer/src/components/Workspace.js";

Object.assign(globalThis, { React });

const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;
const props: React.ComponentProps<typeof Workspace> = {
  projectId: "project", sessionId: "session", sessionTitle: "可读历史", turns: [],
  loading: false, runtimePanelOpen: false, thinking: false, running: false,
  onOpenProject: noop, onPreviewFile: noop, onRuntimePanelOpenChange: noop,
  onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
  onAddQuoteToConversation: asyncNoop, onResolvePermission: asyncNoop,
  onRetry: asyncNoop, onSwitchVersion: asyncNoop,
  onRetryRuntime: asyncNoop, onEditRequest: noop, onDismissGenerationError: noop,
  onCreateBranch: asyncNoop, onRollbackFiles: noop, onRuntimeError: noop,
  onRuntimeMutation: asyncNoop, onRuntimeRefresh: asyncNoop,
  onOpenRuntime: noop, onOpenExtensions: noop,
  children: React.createElement("textarea", { "aria-label": "输入消息", defaultValue: "保留草稿" })
};

test("会话占用只替换输入区，保留历史标题并同时提供重试和创建分支", () => {
  const html = renderToStaticMarkup(React.createElement(Workspace, { ...props, writerConflict: { sessionId: "session" } }));
  assert.match(html, /可读历史/u);
  assert.match(html, /已在另一个应用中打开/u);
  assert.match(html, /创建聊天分支/u);
  assert.match(html, /重试/u);
  assert.match(html, /<h3>已在另一个应用中打开<\/h3>/u);
  assert.match(html, /<span>请先在那边关闭会话，才能在这里继续。<\/span>/u);
  assert.match(html, /<aside[^>]*class="biny-runtime-recovery"[^>]*role="alert"/u);
  assert.match(html, /class="biny-chat-composer has-runtime-recovery"/u);
  assert.doesNotMatch(html, /textarea|Agent Runtime 无法启动/u);
  assert.doesNotMatch(html, /也可以|技术详情|重试中|创建中/u);
});

test("恢复提示使用薄描边圆角、透明操作和按容器宽度切换的分隔线", async () => {
  const css = await readFile(new URL("../src/desktop/renderer/src/styles/biny.css", import.meta.url), "utf8");
  const banner = css.match(/\.biny-runtime-recovery \{([^}]+)\}/u)?.[1] ?? "";
  assert.match(banner, /border:\s*0;/u);
  assert.match(banner, /box-shadow:\s*0 0 0 0\.5px var\(--biny-border-strong\)/u);
  assert.match(banner, /border-radius:\s*24px/u);
  assert.match(banner, /padding:\s*16px 12px 16px 20px/u);
  assert.doesNotMatch(banner, /min-height|flex-wrap|surface-elevated/u);
  const actions = css.match(/\.biny-runtime-recovery-actions \{([^}]+)\}/u)?.[1] ?? "";
  assert.match(actions, /border-inline-start:\s*1px solid var\(--biny-border\)/u);
  assert.match(actions, /padding-inline-start:\s*12px/u);
  const button = css.match(/\.biny-runtime-recovery button \{([^}]+)\}/u)?.[1] ?? "";
  assert.match(button, /background:\s*transparent/u);
  assert.match(button, /border-radius:\s*999px/u);
  assert.match(css, /\.biny-runtime-recovery-container \{[^}]*container-type:\s*inline-size/u);
  assert.match(css, /@container biny-runtime-recovery \(max-width: 400px\)/u);
  assert.match(css, /@container biny-runtime-recovery \(max-width: 400px\)[\s\S]*border-inline-start:\s*0[\s\S]*border-top:\s*1px solid var\(--biny-border\)/u);
  assert.match(css, /\.biny-chat-composer\.has-runtime-recovery \{[^}]*width:\s*var\(--biny-chat-content-width\)/u);
});

test("写入冲突时正文只读，保留复制而隐藏编辑、重新生成和版本写入", () => {
  const withHistory = { ...props, turns: [{ id: "turn", user: "问题", assistant: "已保存的回答", reasoning: "", skills: [], status: "completed" as const,
    tools: [], steps: [], userMessageId: "user", assistantMessageId: "assistant", versionCount: 2, versionIndex: 1 }] };
  const locked = renderToStaticMarkup(React.createElement(Workspace, { ...withHistory, writerConflict: { sessionId: "session" } }));
  assert.match(locked, /已保存的回答/u);
  assert.match(locked, /aria-label="复制回复"/u);
  assert.match(locked, /aria-label="复制消息"/u);
  assert.doesNotMatch(locked, /aria-label="编辑消息"|aria-label="重新生成"|aria-label="回复版本"/u);
  const ready = renderToStaticMarkup(React.createElement(Workspace, withHistory));
  assert.match(ready, /aria-label="编辑消息"/u);
  assert.match(ready, /aria-label="重新生成"/u);
  assert.match(ready, /aria-label="回复版本"/u);
});

test("启动超时保留正文，提示可重试而不是让用户关闭别的会话", () => {
  const html = renderToStaticMarkup(React.createElement(Workspace, { ...props,
    runtimeError: { kind: "startup_timeout", message: "Runtime Host did not become ready within 8000ms.", retryable: true },
    turns: [{ id: "turn", user: "问题", assistant: "已保存的回答", reasoning: "", skills: [], status: "completed", tools: [], steps: [] }]
  }));
  assert.match(html, /已保存的回答/u);
  assert.match(html, /运行时启动超时/u);
  assert.match(html, /技术详情/u);
  assert.doesNotMatch(html, /若另一个|关闭会话|创建聊天分支|textarea/u);
});

test("版本冲突不提供无效重试，普通状态正常保留输入框", () => {
  const html = renderToStaticMarkup(React.createElement(Workspace, { ...props,
    runtimeError: { kind: "protocol_mismatch", message: "protocol mismatch", retryable: false }
  }));
  assert.match(html, /运行时版本不一致/u);
  assert.doesNotMatch(html, />重试</u);
  const ready = renderToStaticMarkup(React.createElement(Workspace, props));
  assert.match(ready, /textarea/u);
  assert.match(ready, /保留草稿/u);
  assert.doesNotMatch(ready, /技术详情|已在另一个应用中打开/u);
});
