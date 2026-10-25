import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";

// Execute only the audited action component and its local UI helpers. No application
// imports, native speech implementation, resource loading, or scripts are enabled.
const source = readFileSync(new URL("../src/desktop/renderer/src/components/MessageTimeline.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("MessageTimeline.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["AssistantActions", "VersionSwitcher", "useAnchoredMenu", "plainTextFromMarkdown"];
const extracted = names.map(name => {
  const matches = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `exactly one ${name}`);
  return matches[0]!.getText(parsed);
}).join("\n");
const compiled = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None } }).outputText;
assert.doesNotMatch(compiled, /\b(?:import|require)\s*\(/u);

interface Turn {
  id: string;
  assistantMessageId: string;
  tools: [];
  skills: [];
}
interface Props {
  projectId: string;
  sessionId: string;
  turn: Turn;
  content: string;
  versionCount: number;
  versionIndex: number;
  onSwitchVersion(direction: "prev" | "next"): Promise<void>;
}
interface Request {
  text: string;
  done(): void;
  stopped: boolean;
}
const fail = (): never => { throw new Error("Unexpected external operation"); };

async function harness() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://speech.test" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "biny", { get: fail });
  Object.defineProperty(dom.window, "speechSynthesis", { get: fail });
  const requests: Request[] = [];
  let active: Request | undefined;
  let stops = 0;
  const stopActive = () => {
    const request = active;
    active = undefined;
    if (request) { request.stopped = true; stops++; request.done(); }
  };
  const speak = (text: string, done: () => void) => {
    stopActive();
    const request = { text, done, stopped: false };
    requests.push(request);
    active = request;
    return () => { if (active === request) stopActive(); };
  };
  const nullComponent = () => null;
  const sandbox = {
    React, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
    useMemo: React.useMemo, useCallback: React.useCallback,
    window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
    speak, speechSupported: () => true,
    useChatResponseSettings: () => ({ showTokenUsage: false }),
    summarizeToolOptimizations: () => ({ runs: 0 }), buildUsageDetailRows: fail,
    finishReasonTone: fail, formatMessageClock: fail, formatDuration: fail, copyToClipboard: fail,
    Icon: nullComponent, CopyButton: nullComponent, MessageContextMenu: nullComponent, ExecutionTraceDialog: fail,
    createPortal: fail, fetch: fail, WebSocket: fail, SpeechSynthesisUtterance: fail,
    require: fail, process: undefined
  };
  const Actions = vm.runInNewContext(`${compiled}\nAssistantActions;`, sandbox, { timeout: 1_000 }) as React.ComponentType<Props>;
  const root = createRoot(dom.window.document.getElementById("root")!);
  let present = true;
  let second = false;
  let switchCount = 0;
  let pendingVersion: (() => void) | undefined;
  let deferVersion = false;
  let props: Props = {
    projectId: "project", sessionId: "session", turn: { id: "turn", assistantMessageId: "answer-a", tools: [], skills: [] },
    content: "# Version A", versionCount: 2, versionIndex: 0,
    onSwitchVersion: async () => {
      switchCount++;
      if (deferVersion) await new Promise<void>(resolve => { pendingVersion = resolve; });
      props = { ...props, content: "# Version B", turn: { ...props.turn, assistantMessageId: "answer-b" }, versionIndex: 1 };
      renderRoot();
    }
  };
  function renderRoot() {
    root.render(React.createElement(React.Fragment, null,
      present ? React.createElement("section", { key: "user", "data-owner": "first" }, React.createElement(Actions, props)) : null,
      second ? React.createElement("section", { key: "other-user", "data-owner": "second" }, React.createElement(Actions, { ...props, content: "Other reply", turn: { ...props.turn, assistantMessageId: "other" } })) : null));
  }
  function button(label: string, owner = "first") {
    const found = dom.window.document.querySelector<HTMLButtonElement>(`[data-owner="${owner}"] button[aria-label="${label}"]`);
    assert.ok(found, `${owner}: ${label} exists`);
    return found;
  }
  const click = async (label: string, owner = "first") => { await act(() => button(label, owner).click()); };
  const render = async (changes: Partial<Props> = {}) => { props = { ...props, ...changes }; await act(renderRoot); };
  await render();
  return {
    dom, requests, button, click, render,
    current() { return active; },
    get props() { return props; }, get active() { return active; }, get stops() { return stops; }, get switchCount() { return switchCount; },
    deferVersion() { deferVersion = true; },
    async finishVersion() { await act(async () => { pendingVersion?.(); await Promise.resolve(); }); },
    async complete() { await act(() => { const request = active; active = undefined; request?.done(); }); },
    async addSecond() { second = true; await act(renderRoot); },
    async removeFirst() { present = false; await act(renderRoot); },
    async close() {
      await act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

test("visible version selection retires old speech without automatically reading the new reply", async () => {
  const h = await harness();
  try {
    await h.click("朗读回复");
    assert.equal(h.active?.text, "Version A");
    await h.click("下一版本");
    assert.equal(h.switchCount, 1);
    assert.equal(h.props.turn.assistantMessageId, "answer-b");
    assert.equal(h.stops, 1, "old version must stop on replacement");
    assert.equal(h.active, undefined);
    assert.equal(h.requests.length, 1, "version selection never starts speech automatically");
    h.button("朗读回复");
    assert.equal(h.dom.window.document.querySelector(".message-version-count")?.textContent, "2 / 2");
    await h.click("朗读回复");
    assert.equal(h.current()?.text, "Version B");
  } finally { await h.close(); }
});

for (const changed of ["content", "message", "project", "session", "empty"] as const) {
  test(`${changed} replacement retires only the owned speech`, async () => {
    const h = await harness();
    try {
      await h.click("朗读回复");
      await h.render(changed === "content" ? { content: "Changed text" }
        : changed === "message" ? { turn: { ...h.props.turn, assistantMessageId: "same-text-new-message" } }
          : changed === "project" ? { projectId: "another-project" }
            : changed === "session" ? { sessionId: "another-session" } : { content: "" });
      assert.equal(h.stops, 1);
      assert.equal(h.active, undefined);
      assert.equal(h.requests.length, 1);
      assert.equal(h.dom.window.document.querySelector('[aria-label="停止朗读"]'), null);
      if (changed !== "empty") h.button("朗读回复");
    } finally { await h.close(); }
  });
}

test("unchanged re-render and pending version action preserve current reading", async () => {
  const h = await harness();
  try {
    await h.click("朗读回复");
    const request = h.active;
    await h.render({ turn: { ...h.props.turn } });
    assert.equal(h.active, request);
    assert.equal(h.stops, 0);
    h.deferVersion();
    await h.click("下一版本");
    assert.equal(h.button("下一版本").disabled, true);
    await h.click("下一版本");
    assert.equal(h.switchCount, 1);
    assert.equal(h.active, request, "do not cancel until the visible reply actually changes");
    await h.finishVersion();
    assert.equal(h.button("下一版本").disabled, false);
    assert.equal(h.active, undefined);
  } finally { await h.close(); }
});

test("manual stop, explicit replay and natural completion retain normal button state", async () => {
  const h = await harness();
  try {
    await h.click("朗读回复");
    await h.click("停止朗读");
    assert.equal(h.active, undefined);
    await h.click("朗读回复");
    assert.equal(h.requests.length, 2);
    await h.complete();
    h.button("朗读回复");
    assert.equal(h.stops, 1);
    await h.render({ content: "Changed after completion" });
    assert.equal(h.stops, 1, "retired stop handle is inert");
  } finally { await h.close(); }
});

test("old owner replacement and unmount cannot cancel a newer different-message reading", async () => {
  const h = await harness();
  try {
    await h.addSecond();
    await h.click("朗读回复");
    await h.click("朗读回复", "second");
    const current = h.active;
    h.button("朗读回复");
    assert.equal(current?.text, "Other reply");
    await h.render({ content: "Replaced first reply", turn: { ...h.props.turn, assistantMessageId: "replacement" } });
    assert.equal(h.active, current);
    assert.equal(h.stops, 1, "only takeover stopped the first request");
    await h.removeFirst();
    assert.equal(h.active, current);
    h.button("停止朗读", "second");
  } finally { await h.close(); }
});

test("unmount stops active reading once", async () => {
  const h = await harness();
  try {
    await h.click("朗读回复");
    await h.removeFirst();
    assert.equal(h.active, undefined);
    assert.equal(h.stops, 1);
  } finally { await h.close(); }
});
