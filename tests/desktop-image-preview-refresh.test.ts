/** Real Inspector controls with inert IPC, plus actual temporary-file read boundaries. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { DesktopProject, DesktopWorkspaceFilePreview } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const image = (value: string) => `data:image/svg+xml;base64,${Buffer.from(value).toString("base64")}`;
const metadata = (path: string): DesktopWorkspaceFilePreview => ({ path, bytes: 10, binary: true, truncated: false });
let id = 0;
async function fixture(t: TestContext) {
  const imports = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@xterm/xterm") return next("@xterm/xterm/lib/xterm.mjs", context);
      if (specifier === "@xterm/addon-fit") return next("@xterm/addon-fit/lib/addon-fit.mjs", context);
      return next(specifier, context);
    },
    load(url, context, next) {
      if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
      return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
    }
  });
  const React = await import("react");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.test", pretendToBeVisual: true });
  const saved: Array<() => void> = [];
  function replace(target: object, key: string, value: unknown) {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    saved.push(() => old ? Object.defineProperty(target, key, old) : Reflect.deleteProperty(target, key));
  }
  replace(dom.window, "innerWidth", 1800);
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    React, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true })) replace(globalThis, key, value);
  replace(dom.window, "requestAnimationFrame", () => 1);
  replace(dom.window, "cancelAnimationFrame", () => {});
  replace(dom.window.HTMLCanvasElement.prototype, "getContext", () => null);
  const unexpected: string[] = [];
  replace(globalThis, "fetch", () => { unexpected.push("fetch"); throw new Error("Unexpected network"); });
  const { createRoot } = await import("react-dom/client");
  const { useWorkspaceInspector } = await import("../src/desktop/renderer/src/components/workspace/useWorkspaceInspector.js");
  const { FilePreviewPanel } = await import("../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js");
  const images = await import("../src/desktop/renderer/src/inlineImage.js");
  const { useInlineImageState } = images;
  const projectId = `image-refresh-${++id}`;
  const reads: Array<{ projectId: string; path: string; thumbnail: boolean }> = [];
  const fileReads: string[] = [];
  let readFile = async (path: string) => metadata(path);
  let readImage = async (_projectId: string, path: string, _thumbnail: boolean): Promise<string | undefined> => image(path);
  const boundary = {
    readInlineImage: async (projectId: string, path: string, thumbnail = false) => {
      reads.push({ projectId, path, thumbnail });
      return await readImage(projectId, path, thumbnail);
    }
  };
  replace(dom.window, "biny", new Proxy(boundary, { get(target, key) {
    if (key in target) return target[key as keyof typeof target];
    unexpected.push(String(key)); throw new Error(`Unexpected IPC: ${String(key)}`);
  } }));
  const options = {
    changes: [], tools: [], filePanelResizing: false, filePanelWidth: 800, projectId, source: `${projectId}:s`,
    onFilePanelResizeEnd() {}, onFilePanelResizeStart() {}, onFilePanelWidthChange() {},
    onListDirectory: async (path: string) => ({ path, entries: [{ name: "picture.svg", path: "picture.svg", kind: "file" as const }] }),
    onOpenFile() {}, onOpenBrowser: async () => {}, onSwitchBranch: async () => {}, onFixPreview() {}, onWarning() {},
    onReadFile: async (path: string) => { fileReads.push(path); return await readFile(path); }
  };
  let inspector!: ReturnType<typeof useWorkspaceInspector>;
  let probes: Array<{ key: string; projectId: string; path: string; thumbnail?: boolean }> = [];
  function Probe({ projectId, path, thumbnail }: typeof probes[number]) {
    const { source, loading } = useInlineImageState(projectId, path, thumbnail);
    return React.createElement("img", { className: "probe", src: source, "data-loading": loading });
  }
  function Harness() {
    inspector = useWorkspaceInspector(options);
    return React.createElement("div", null, inspector.rail, inspector.dock,
      ...probes.map(props => React.createElement(Probe, props)));
  }
  const root = createRoot(document.getElementById("root")!);
  const act = async (action: () => void | Promise<unknown>) => { await React.act(async () => { await action(); }); };
  const render = async (source = options.source, project = options.projectId) => {
    options.source = source; options.projectId = project;
    await act(() => root.render(React.createElement(Harness)));
  };
  const cleanup: Array<() => Promise<void>> = [];
  const pending: Array<(error: Error) => void> = [];
  function gate<T>() { const value = deferred<T>(); pending.push(value.reject); return value; }
  t.after(async () => {
    try {
      await act(() => root.unmount());
      await act(() => { for (const reject of pending) reject(new Error("fixture cleanup")); });
      for (const close of cleanup) await close();
    } finally {
      dom.window.close(); imports.deregister();
      for (const undo of saved.reverse()) undo();
    }
    assert.deepEqual(unexpected, [], "Only explicit inert IPC is allowed");
  });
  const click = async (label: string) => act(() => {
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(button, `Missing ${label}`);
    assert.equal(button.closest('[inert], [aria-hidden="true"]'), null, "Do not click hidden controls");
    assert.equal(button.disabled, false); button.click();
  });
  await render();
  return { act, render, click, reads, fileReads, projectId, cleanup, gate,
    // Main has no invalidation entrypoint; reach the same visible assertion there
    // instead of failing the regression fixture during setup.
    invalidate: () => images.invalidateInlineImage?.(projectId, "picture.svg"),
    ready: async (revision: number) => act(() => root.render(React.createElement(FilePreviewPanel, {
      width: 800, projectId, preview: { source: options.source, path: "picture.svg", status: "ready", file: metadata("picture.svg"), revision },
      directoryStates: new Map(), expandedDirectories: new Set<string>(), onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {}
    }))),
    open: async (path = "picture.svg") => act(() => inspector.previewFile(path)),
    openTree: async () => act(() => inspector.openFiles()),
    source: () => document.querySelector<HTMLImageElement>(".file-preview-image img")?.src,
    setFileReader(value: typeof readFile) { readFile = value; },
    setImageReader(value: typeof readImage) { readImage = value; },
    async probes(value: typeof probes) { probes = value; await render(); }
  };
}

test("explicit file refresh displays changed on-disk image bytes, even for equal-sized replacements", async t => {
  const h = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-image-refresh-"));
  const priorAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "config");
  h.cleanup.push(async () => {
    if (priorAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const { createFileConfigStore } = await import("../src/config/store.js");
  const { DesktopProjectService } = await import("../src/desktop/electron/main/DesktopProjectService.js");
  const { DesktopStateStore } = await import("../src/desktop/electron/main/DesktopStateStore.js");
  const { DesktopUserDataStore } = await import("../src/desktop/electron/main/DesktopUserDataStore.js");
  const service = new DesktopProjectService(new DesktopStateStore(path.join(root, "state.json")),
    new DesktopUserDataStore(path.join(root, "desktop")), createFileConfigStore(root, { globalDir: root }));
  const project: DesktopProject = { id: h.projectId, name: "Owned fixture", path: root, dirty: false, missing: false,
    pinned: false, addedAt: "2026-10-21T00:00:00Z", lastOpenedAt: "2026-10-21T00:00:00Z" };
  const before = '<svg xmlns="http://www.w3.org/2000/svg"><text>old</text></svg>';
  const after = before.replace("old", "new");
  await writeFile(path.join(root, "picture.svg"), before);
  h.setFileReader(async path => service.readWorkspaceFile(project, path));
  h.setImageReader(async (_project, path, thumbnail) => service.readInlineImage(project, path, thumbnail));
  await h.open();
  // Real filesystem continuations need bounded observable waiting, not sleeps.
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 3_000;
    while (!condition()) { assert.ok(performance.now() < deadline, `Image should settle: ${document.body.textContent}; reads=${JSON.stringify(h.reads)}`); await h.act(() => new Promise<void>(resolve => setImmediate(resolve))); }
  };
  await until(() => !!h.source()); assert.equal(h.source(), image(before));
  await writeFile(path.join(root, "picture.svg"), after);
  await h.click("刷新文件");
  await until(() => !!h.source());
  assert.equal(h.fileReads.length, 2);
  assert.equal(h.source(), image(after), "Explicit refresh must not retain the old global image promise");
  assert.equal(h.reads.length, 2);
});

test("immediate metadata and image replies refresh repeatedly", async t => {
  const h = await fixture(t); let version = 0;
  h.setImageReader(async () => image(String(++version)));
  await h.open(); assert.equal(h.source(), image("1"));
  await h.click("刷新文件"); assert.equal(h.source(), image("2"));
  await h.click("刷新文件"); assert.equal(h.source(), image("3"));
  assert.equal(h.fileReads.length, 3); assert.equal(h.reads.length, 3);
});

for (const outcome of ["reject", "undefined"] as const) {
  test(`explicit refresh retries a cached ${outcome} image result`, async t => {
    const h = await fixture(t); let fail = true;
    h.setImageReader(async () => { if (!fail) return image("recovered"); if (outcome === "reject") throw new Error("temporary image failure"); });
    await h.open(); assert.match(document.body.textContent ?? "", /图片无法内联预览/u);
    fail = false; await h.click("刷新文件");
    assert.equal(h.source(), image("recovered")); assert.equal(h.reads.length, 2);
  });
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`late old-image ${outcome} cannot overwrite or remove the refreshed cached read`, async t => {
    const h = await fixture(t); const old = h.gate<string>(); let calls = 0;
    h.setImageReader(async () => ++calls === 1 ? old.promise : image("current"));
    await h.open(); assert.equal(h.source(), undefined); assert.equal(h.reads.length, 1);
    await h.click("刷新文件"); assert.equal(h.source(), image("current"));
    await h.act(() => outcome === "resolve" ? old.resolve(image("obsolete")) : old.reject(new Error("obsolete failure")));
    assert.equal(h.source(), image("current"));
    await h.click("关闭当前文件"); await h.open();
    assert.equal(h.source(), image("current")); assert.equal(h.reads.length, 2, "Old settlement must not evict the replacement promise");
  });
}

test("failed refresh metadata remains an error, and retry reads fresh image bytes without another refresh click", async t => {
  const h = await fixture(t); let version = "old";
  h.setImageReader(async () => image(version)); await h.open();
  version = "new"; h.setFileReader(async () => { throw new Error("metadata unavailable"); });
  await h.click("刷新文件");
  assert.match(document.body.textContent ?? "", /metadata unavailable/u); assert.equal(h.source(), undefined);
  h.setFileReader(async path => metadata(path));
  await h.act(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重试读取");
    assert.ok(button); assert.equal(button.closest('[inert], [aria-hidden="true"]'), null); button.click();
  });
  assert.equal(h.source(), image("new")); assert.equal(h.reads.length, 2);
});

test("double refresh while metadata is pending shares that read and makes one replacement image request", async t => {
  const h = await fixture(t); let version = "old";
  h.setImageReader(async () => image(version)); await h.open();
  const gate = h.gate<DesktopWorkspaceFilePreview>(); h.setFileReader(async () => gate.promise); version = "new";
  await h.act(() => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!;
    assert.equal(button.closest('[inert], [aria-hidden="true"]'), null); button.click(); button.click();
  });
  assert.equal(h.fileReads.length, 2); assert.equal(h.reads.length, 1);
  await h.act(() => gate.resolve(metadata("picture.svg")));
  assert.equal(h.source(), image("new")); assert.equal(h.reads.length, 2);
});

for (const dismissal of ["close", "source", "project"] as const) {
  test(`pending refresh metadata cannot revive the image after ${dismissal}`, async t => {
    const h = await fixture(t); await h.open();
    const gate = h.gate<DesktopWorkspaceFilePreview>(); h.setFileReader(async () => gate.promise);
    await h.click("刷新文件");
    if (dismissal === "close") await h.click("关闭当前文件");
    else await h.render(`${h.projectId}:next`, dismissal === "project" ? `${h.projectId}-other` : h.projectId);
    await h.act(() => gate.resolve(metadata("picture.svg")));
    assert.equal(h.source(), undefined); assert.equal(h.reads.length, 1, "Retired metadata must not start an image read");
    assert.equal(document.querySelector(".file-browser-path-label"), null);
  });
}

for (const dismissal of ["close", "source", "project"] as const) {
  test(`pending refreshed image cannot publish after ${dismissal}`, async t => {
    const h = await fixture(t); await h.open(); const gate = h.gate<string>();
    h.setImageReader(async () => gate.promise); await h.click("刷新文件");
    assert.equal(h.reads.length, 2); assert.equal(h.source(), undefined);
    if (dismissal === "close") await h.click("关闭当前文件");
    else await h.render(`${h.projectId}:next`, dismissal === "project" ? `${h.projectId}-other` : h.projectId);
    await h.act(() => gate.resolve(image("late")));
    assert.equal(h.source(), undefined); assert.equal(document.querySelector(".file-browser-path-label"), null);
  });
}

test("refresh invalidates only the selected full-image key, not thumbnails, other projects, or other paths", async t => {
  const h = await fixture(t); let version = "old";
  h.setImageReader(async (project, path, thumb) => image(`${project}:${path}:${thumb}:${version}`));
  const probes = [
    { key: "thumb", projectId: h.projectId, path: "picture.svg", thumbnail: true },
    { key: "other-project", projectId: `${h.projectId}-other`, path: "picture.svg" },
    { key: "other-file", projectId: h.projectId, path: "other.svg" },
    { key: "attachment", projectId: h.projectId, path: "@attachments/immutable.svg" }
  ];
  await h.probes(probes); const cached = [...document.querySelectorAll<HTMLImageElement>(".probe")].map(image => image.src);
  await h.open(); assert.equal(h.reads.length, 5);
  version = "new"; await h.click("刷新文件"); assert.equal(h.reads.length, 6);
  assert.equal(h.source(), image(`${h.projectId}:picture.svg:false:new`));
  await h.probes([]); await h.probes(probes);
  assert.deepEqual([...document.querySelectorAll<HTMLImageElement>(".probe")].map(image => image.src), cached);
  assert.equal(h.reads.length, 6, "Unrelated cached bytes remain cached across remounts");
});

test("ordinary rerenders, image controls, and duplicate file selections keep the existing image request", async t => {
  const h = await fixture(t); await h.open();
  const node = document.querySelector(".file-preview-image img");
  await h.render(); await h.click("放大图片"); await h.click("向右旋转图片"); await h.open(); await h.open();
  assert.equal(h.fileReads.length, 1); assert.equal(h.reads.length, 1);
  assert.equal(document.querySelector(".file-preview-image img"), node);
  assert.match((node as HTMLImageElement).style.transform, /rotate\(90deg\) scale\(1\.25\)/u);
});

test("default immutable inline consumers share in-flight and remounted reads", async t => {
  const h = await fixture(t); const gate = h.gate<string>(); h.setImageReader(async () => gate.promise);
  const probe = { projectId: h.projectId, path: "@attachments/immutable.svg" };
  await h.probes([{ ...probe, key: "first" }, { ...probe, key: "second" }]); assert.equal(h.reads.length, 1);
  await h.act(() => gate.resolve(image("immutable")));
  await h.probes([]); await h.probes([{ ...probe, key: "remounted" }]);
  assert.equal(h.reads.length, 1); assert.equal(document.querySelector<HTMLImageElement>(".probe")?.src, image("immutable"));
});

test("the shared image cache retains its existing 32-entry FIFO bound", async t => {
  const h = await fixture(t);
  const probes = Array.from({ length: 33 }, (_, index) => ({ key: String(index), projectId: h.projectId, path: `${index}.svg` }));
  await h.probes(probes); assert.equal(h.reads.length, 33);
  await h.probes([]); await h.probes([{ ...probes[32]!, key: "recent" }]); assert.equal(h.reads.length, 33);
  await h.probes([]); await h.probes([{ ...probes[0]!, key: "evicted" }]); assert.equal(h.reads.length, 34);
});


// A defensive component contract, not evidence that the Inspector batches away
// its loading render. The explicit UI/real-filesystem regression is above.
test("ready-to-ready file preview revision re-subscribes without resetting image controls", async t => {
  const h = await fixture(t); let version = "old";
  h.setImageReader(async () => image(version));
  await h.ready(1); assert.equal(h.source(), image("old"));
  await h.click("放大图片"); await h.click("向右旋转图片");
  version = "new"; h.invalidate(); await h.ready(2);
  assert.equal(h.source(), image("new"), "A new ready revision must not retain the old hook subscription");
  assert.equal(h.reads.length, 2);
  assert.match(document.querySelector<HTMLImageElement>(".file-preview-image img")!.style.transform, /rotate\(90deg\) scale\(1\.25\)/u);
  await h.ready(2); assert.equal(h.reads.length, 2, "The same revision does not cause every-render reads");
});
