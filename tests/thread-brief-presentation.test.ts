/** 验证显示边界与位置对应组件的公开输出；视觉和点击验收仍交给用户。 */
import assert from "node:assert/strict";
import React, { createElement, type ComponentProps } from "react";
import { registerHooks } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadBriefContext } from "../src/desktop/renderer/src/threadBrief/context.js";
import { ProjectSuggestionBanner } from "../src/desktop/renderer/src/threadBrief/ProjectSuggestionBanner.js";
import { DEFAULT_SIDEBAR_LAYOUT, resolveSidebarLayout } from "../src/desktop/sidebarLayout.js";
import { defaultThreadBriefSettings } from "../src/session/threadBriefTypes.js";
import type { DesktopThreadBriefSnapshot } from "../src/desktop/threadBriefProtocol.js";

const assets = registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
} });
const { Sidebar } = await import("../src/desktop/renderer/src/components/Sidebar.js").finally(() => assets.deregister());
const snapshot: DesktopThreadBriefSnapshot = { config: defaultThreadBriefSettings, defaults: defaultThreadBriefSettings, enabledAt: "2026-09-22", projects: [], briefs: [], suggestions: [{ id: "suggestion", signature: "signature", kind: "create", status: "open", name: "编辑器", brief: "项目理解", focus: "准备发布", reason: "持续推进编辑器发布", threads: [{ sessionId: "related", projectId: "project", title: "编辑器发布", createdAt: "2026-09-22" }], createdAt: "2026-09-22" }] };
const render = (child: React.ReactElement): string => renderToStaticMarkup(createElement(ThreadBriefContext.Provider, { value: { snapshot, request: async () => snapshot } }, child));
assert.equal(render(createElement(ProjectSuggestionBanner, { sessionId: "unrelated" })), "", "无关对话不展示项目建议");
const banner = render(createElement(ProjectSuggestionBanner, { sessionId: "related" }));
assert.match(banner, /看看草稿/u);
assert.doesNotMatch(banner, /<dialog|项目理解/u, "草稿只能点击当前对话的提示打开");
snapshot.suggestions[0]!.status = "dismissed";
assert.equal(render(createElement(ProjectSuggestionBanner, { sessionId: "related" })), "", "已忽略建议不重复出现");
// Main removed the brief status badge/menu; test the current production Sidebar instead.
const unexpected = (): never => { throw new Error("static rendering must not invoke a desktop action"); };
const pointerHandlers = { onPointerEnter: unexpected, onPointerLeave: unexpected, onPointerMove: unexpected };
const sidebarProps: ComponentProps<typeof Sidebar> = {
  layout: resolveSidebarLayout(DEFAULT_SIDEBAR_LAYOUT),
  peekDrawerHandlers: pointerHandlers, peekDrawerRef: { current: null }, peekTriggerHandlers: pointerHandlers,
  resizeHandlers: { onResizeStart: unexpected, onWidthChange: unexpected, onResizeEnd: unexpected },
  projects: [], sessions: [{ id: "related", projectId: "", fileName: "related.jsonl", title: "编辑器发布",
    firstUserMessage: "", lastAssistantMessage: "", eventCount: 1, createdAt: "2026-09-22", updatedAt: "2026-09-22", pinned: false, status: "idle" }],
  onOpenProject: unexpected, onCreateEmptyProject: unexpected, onSelectSession: unexpected,
  captureDeletionProject: unexpected,
  onLoadSessionChildren: unexpected, onSessionAction: unexpected, onDeleteSessions: unexpected,
  onProjectPinned: unexpected, onReorderProjects: unexpected, onRefreshProject: unexpected,
  onRevealProject: unexpected, onOpenTerminalProject: unexpected, onRenameProject: unexpected,
  onNewTask: unexpected, onNewTopLevelTask: unexpected, onImportSession: unexpected,
  onRemoveProject: unexpected, onSearch: unexpected, onTimeClues: unexpected,
  onToggleSidebar: unexpected
};
const assertSidebar = (message: string): void => {
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  let html: string;
  try {
    Object.defineProperty(globalThis, "React", { configurable: true, value: React });
    html = render(createElement(Sidebar, sidebarProps));
  } finally {
    if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
  assert.match(html, /biny-sidebar-session-title[^>]*>编辑器发布/u, "the actual session row must render");
  assert.doesNotMatch(html, /biny-brief-session-status|自动标记待办|aria-label="(?:待办|已完成)"/u, message);
};
assertSidebar("没有摘要结果就不臆造待办");
snapshot.briefs.push({ ...snapshot.suggestions[0]!.threads[0]!, brief: { topic: "编辑器", goal: "发布", objects: [], conclusions: [], followUp: { what: "发布", quote: "明天发布" } }, contentHash: "hash", materialLength: 500, userTurns: 2, updatedAt: "2026-09-22", status: "todo", statusManual: false, autoTodo: { what: "发布", quote: "明天发布", at: "2026-09-22" } });
assertSidebar("已有自动待办记录也不恢复已移除的侧栏状态徽章");
console.log("thread brief presentation boundary tests passed");
