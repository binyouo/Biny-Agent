/** Real rename callbacks and catalog persistence; no browser input or visual acceptance. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as React from "react";
import type { ReactNode } from "react";
import { JSDOM } from "jsdom";
import { RenameOverlay } from "../src/desktop/renderer/src/components/overlays/RenameOverlay.js";
import { readSessionCatalogRecord, sessionCatalogDirectory, sessionCatalogRecordRevision, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

type ElementProps = Record<string, unknown> & { children?: ReactNode };

async function harness(onSave: (title: string) => Promise<void>, initialValue = "Original title") {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), CSS: { escape: (value: string) => value }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.scrollTo = () => {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.matchMedia = query => ({ matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  // ReactDOM 的输入能力检测需要在 JSDOM 全局对象安装后初始化。
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let tree: ReactNode;
  let closed = 0;
  let completion: Promise<void> | undefined;
  function Host() {
    const [open, setOpen] = React.useState(true);
    tree = RenameOverlay({ open, initialValue, onSave: title => {
      completion = onSave(title).then(() => { setOpen(false); });
      // Observe failures so the baseline can assert feedback instead of aborting on an unhandled rejection.
      void completion.catch(() => undefined);
      return completion;
    }, onClose: () => { closed += 1; setOpen(false); } });
    return tree;
  }
  await React.act(async () => root.render(React.createElement(Host)));
  const props = (type: string, select: (p: ElementProps) => boolean = () => true): ElementProps => {
    let found: ElementProps | undefined;
    const walk = (node: ReactNode): void => {
      React.Children.forEach(node, child => {
        if (!React.isValidElement<ElementProps>(child)) return;
        const name = typeof child.type === "function" ? child.type.name : child.type;
        if (name === type && select(child.props)) found = child.props;
        walk(child.props.children);
      });
    };
    walk(tree);
    assert.ok(found, `Missing ${type}`);
    return found;
  };
  const call = (type: string, method: string, args: unknown[] = [], select?: (p: ElementProps) => boolean): unknown => {
    const fn = props(type, select)[method];
    assert.equal(typeof fn, "function", `${type}.${method}`);
    return Reflect.apply(fn as (...args: unknown[]) => unknown, undefined, args);
  };
  return { props, call, closed: () => closed,
    async settled(): Promise<void> { await React.act(async () => { await completion?.catch(() => undefined); }); },
    async invoke(fn: () => unknown): Promise<void> { await React.act(async () => { await fn(); }); },
    async close() {
      await React.act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

test("failed rename exposes a real catalog conflict and retains the user's title", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-rename-feedback-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "A session to rename" });
    await recorder.close();
    const original = await updateSessionCatalogMetadata(root, recorder.sessionId, { title: "Original title" });
    const revision = sessionCatalogRecordRevision(original);
    await updateSessionCatalogMetadata(root, recorder.sessionId, { title: "Changed elsewhere" }, revision);
    const newer = await readSessionCatalogRecord(root, recorder.sessionId);
    let requests = 0;
    h = await harness(async title => {
      requests += 1;
      await updateSessionCatalogMetadata(root, recorder.sessionId, { title }, revision);
    });
    await h.invoke(() => h!.call("TextInput", "onChange", ["Keep my edited title"]));
    await h.invoke(() => h!.call("form", "onSubmit", [{ preventDefault() {} }]));
    await h.settled();
    assert.deepEqual(await readSessionCatalogRecord(root, recorder.sessionId), newer, "failed rename cannot overwrite another editor's title");
    assert.equal(h.props("TextInput").value, "Keep my edited title");
    assert.equal(h.props("Dialog").isOpen, true);
    assert.equal(requests, 1, "failure must not retry automatically");
    assert.match(String(h.props("p", p => p.role === "alert").children), /Session catalog revision conflict/u);
    await h.invoke(() => h!.call("Button", "onClick", [], p => p.label === "取消"));
    assert.equal(h.closed(), 1);
    assert.deepEqual(await readSessionCatalogRecord(root, recorder.sessionId), newer);
  } finally {
    await h?.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});


test("pending rename is single-flight and a failed storage access supports explicit retry", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-rename-retry-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "A session to rename" });
    await recorder.close();
    const original = await updateSessionCatalogMetadata(root, recorder.sessionId, { title: "Original title" });
    const revision = sessionCatalogRecordRevision(original);
    const catalogPath = path.join(sessionCatalogDirectory(root), `${recorder.sessionId}.json`);
    const backupPath = `${catalogPath}.fixture-backup`;
    const originalBytes = await readFile(catalogPath, "utf8");
    await rename(catalogPath, backupPath);
    await mkdir(catalogPath);
    const requests: string[] = [];
    h = await harness(async title => {
      requests.push(title);
      await gate;
      await updateSessionCatalogMetadata(root, recorder.sessionId, { title }, revision);
    });
    await h.invoke(() => h!.call("TextInput", "onChange", ["  Retry this title  "]));
    const submit = h.props("form").onSubmit as (event: { preventDefault(): void }) => void;
    await h.invoke(() => { submit({ preventDefault() {} }); submit({ preventDefault() {} }); });
    assert.deepEqual(requests, ["Retry this title"], "a second submission while pending must not enqueue another write");
    assert.equal(h.props("TextInput").isDisabled, true);
    assert.equal(h.props("Button", p => p.label === "保存").isDisabled, true);
    assert.equal(h.props("Button", p => p.label === "取消").isDisabled, true);
    await h.invoke(() => h!.call("Dialog", "onOpenChange", [false]));
    await h.invoke(() => h!.call("DialogHeader", "onOpenChange", [false]));
    await h.invoke(() => h!.call("Button", "onClick", [], p => p.label === "取消"));
    assert.equal(h.closed(), 0, "pending save must finish before dismissing its editor");
    await h.invoke(() => release());
    await h.settled();
    assert.match(String(h.props("p", p => p.role === "alert").children), /single-link regular file/u);
    assert.equal(h.props("TextInput").value, "  Retry this title  ");
    assert.equal(h.props("TextInput").isDisabled, false);
    assert.equal(h.props("Dialog").isOpen, true);
    assert.deepEqual(requests, ["Retry this title"]);
    assert.equal(await readFile(backupPath, "utf8"), originalBytes);
    await rm(catalogPath, { recursive: true });
    await rename(backupPath, catalogPath);
    await h.invoke(() => h!.call("form", "onSubmit", [{ preventDefault() {} }]));
    await h.settled();
    assert.deepEqual(requests, ["Retry this title", "Retry this title"]);
    assert.equal((await readSessionCatalogRecord(root, recorder.sessionId))?.title, "Retry this title");
    assert.equal(h.props("Dialog").isOpen, false, "only a confirmed successful retry closes the editor");
  } finally {
    release();
    await h?.settled();
    await h?.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
