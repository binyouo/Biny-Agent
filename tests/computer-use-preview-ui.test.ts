import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { runInContext } from "node:vm";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { ComputerPreviewSurface, type PreviewWindow } from "../src/computer/previewSurface.js";
import { CaptureSchedule } from "../src/computer/captureSchedule.js";

test("preview prioritizes the frame and switches, returns, closes, and controls the selected source", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const app = {}; export class BrowserWindow {} export const screen = {}; export const nativeImage = {};" } : next(url, context);
  } });
  let dom: JSDOM | undefined;
  let surface: ComputerPreviewSurface | undefined;
  try {
    const { previewHtml } = await import("../src/desktop/electron/main/ComputerPreviewWindow.js");
    dom = new JSDOM(previewHtml, { runScripts: "outside-only", url: "https://preview.invalid" });
    const document = dom.window.document;
    assert.ok(document.querySelector("#stage #frame"));
    const image = document.querySelector<HTMLImageElement>("#frame")!;
    let width = 380, height = 250, naturalWidth = 800, naturalHeight = 400, complete = false;
    Object.defineProperties(image, { naturalWidth: { get: () => naturalWidth }, naturalHeight: { get: () => naturalHeight }, clientWidth: { get: () => width }, clientHeight: { get: () => height }, complete: { get: () => complete } });
    assert.equal(document.querySelector<HTMLElement>("#items")!.hidden, true);
    let closed = false;
    const webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => undefined, isLoading: () => false,
      executeJavaScript: async (script: string) => runInContext(script, dom!.getInternalVMContext())
    });
    const window = Object.assign(new EventEmitter(), {
      webContents, isDestroyed: () => closed, showInactive: () => undefined,
      destroy: () => { closed = true; window.emit("closed"); },
      getBounds: () => ({ x: 0, y: 0, width: 380, height: 250 }), setBounds: () => undefined,
      loadURL: async () => undefined
    }) as unknown as PreviewWindow;
    const controls: string[] = []; const returns: string[] = []; const removed: string[] = [];
    const captures = new CaptureSchedule();
    surface = new ComputerPreviewSurface(() => window, previewHtml, value => controls.push(value), () => undefined, captures);
    const status = { state: "ready", preview: true, lastOutcome: "not-dispatched" } as const;
    const frame = { image: { mimeType: "image/png", dataBase64: "aGVsbG8=" }, target: { pid: 42, windowId: "900" }, cursor: { x: 0.25, y: 0.5, expiresAt: Date.now() + 8_000 }, capturedAt: Date.now() } as const;
    surface.present({ id: "computer", label: "电脑", status, frame, onReturn: () => returns.push("computer"), onClose: () => removed.push("computer") });
    assert.equal(document.querySelector<HTMLImageElement>("#frame")!.getAttribute("src"), "data:image/png;base64,aGVsbG8=");
    assert.equal(image.dataset.loaded, "false", "a pending image remains hidden until it loads");
    const cursor = document.querySelector<HTMLElement>("#agent-cursor")!;
    assert.equal(cursor.hidden, true);
    complete = true;
    image.dispatchEvent(new dom.window.Event("load"));
    assert.equal(image.dataset.loaded, "true");
    assert.equal(cursor.hidden, false);
    assert.equal(cursor.style.left, "95px"); assert.equal(cursor.style.top, "95px");
    width = 300; height = 300; dom.window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(cursor.style.left, "75px"); assert.equal(cursor.style.top, "75px");
    naturalWidth = 400; naturalHeight = 800; image.dispatchEvent(new dom.window.Event("load"));
    assert.equal(cursor.style.left, "112.5px"); assert.equal(cursor.style.top, "150px");
    surface.present({ id: "computer", label: "电脑", status });
    assert.equal(image.dataset.loaded, "false", "clearing the frame resets the first-frame transition");
    assert.equal(document.querySelector<HTMLElement>("#empty")!.hidden, false);
    surface.present({ id: "computer", label: "电脑", status, frame });
    assert.equal(image.dataset.loaded, "false");
    image.dispatchEvent(new dom.window.Event("load"));
    assert.equal(image.dataset.loaded, "true");
    const nextFrame = { ...frame, image: { ...frame.image, dataBase64: "d29ybGQ=" } };
    complete = false;
    surface.present({ id: "computer", label: "电脑", status, frame: nextFrame });
    surface.present({ id: "computer", label: "电脑", status, frame: nextFrame });
    assert.equal(image.dataset.loaded, "true", "subsequent frames do not restart the fade animation");
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(cursor.hidden, true, "a new cursor must not be placed over the previous image while loading");
    complete = true; image.dispatchEvent(new dom.window.Event("load"));
    assert.equal(cursor.hidden, false);
    surface.present({ id: "computer", label: "电脑", status, frame });
    image.dispatchEvent(new dom.window.Event("load"));
    assert.equal(document.querySelector<HTMLElement>("#items")!.hidden, true);
    surface.present({ id: "computer", label: "电脑", status: { ...status, lastOutcome: "unverified" }, frame, onReturn: () => returns.push("computer"), onClose: () => removed.push("computer") });
    assert.equal(document.querySelector<HTMLElement>("#status")!.dataset.alert, "true");
    surface.present({ id: "browser:one", label: "浏览器", status, frame: { ...frame, cursor: undefined }, onReturn: () => returns.push("browser"), onClose: () => removed.push("browser") });
    assert.equal(surface.activeItem(), "browser:one");
    assert.equal(cursor.hidden, true);
    assert.equal(document.querySelector<HTMLElement>("#items")!.hidden, false);
    assert.equal(document.querySelectorAll("#items a").length, 2);
    const sources = [...document.querySelectorAll<HTMLAnchorElement>("#items a")];
    assert.deepEqual(sources.map(link => link.dataset.kind), ["computer", "browser"]);
    assert.deepEqual(sources.map(link => link.querySelector("svg")?.getAttribute("aria-hidden")), ["true", "true"]);
    assert.deepEqual(sources.map(link => link.title), ["电脑", "浏览器"]);
    assert.ok([...document.querySelectorAll<HTMLElement>("[data-control]")].every(element => element.hidden));
    const selected = document.querySelector<HTMLElement>('#items a[aria-current="true"]')!;
    selected.focus();
    surface.present({ id: "browser:one", label: "浏览器", status, frame, onReturn: () => returns.push("browser"), onClose: () => removed.push("browser") });
    assert.equal(document.activeElement, selected, "frame refresh must not replace the focused source selector");
    surface.present({ id: "browser:one", label: "新页面标题", status, frame, onReturn: () => returns.push("browser"), onClose: () => removed.push("browser") });
    assert.equal((document.activeElement as HTMLElement).dataset.sourceId, "browser:one", "renaming a source preserves keyboard focus on that source");
    assert.equal((document.activeElement as HTMLElement).textContent, "新页面标题");
    const navigate = (url: string) => webContents.emit("will-navigate", { preventDefault() {} }, url);
    navigate("biny-computer:return"); assert.deepEqual(returns, ["browser"]);
    navigate("biny-computer:select:computer");
    assert.equal(surface.activeItem(), "computer");
    assert.equal(cursor.hidden, false);
    surface.present({ id: "computer", label: "电脑", status, frame: { ...frame, cursor: { ...frame.cursor, expiresAt: Date.now() - 1 } }, onReturn: () => returns.push("computer"), onClose: () => removed.push("computer") });
    assert.equal(cursor.hidden, true);
    assert.ok([...document.querySelectorAll<HTMLElement>("[data-control]")].every(element => !element.hidden));
    navigate("biny-computer:pause"); assert.deepEqual(controls, ["pause"]);
    navigate("biny-computer:remove"); assert.deepEqual(removed, ["computer"]);
    assert.equal(surface.activeItem(), "computer");
    assert.equal(document.querySelector<HTMLElement>("#stage")!.dataset.completing, "true");
    t.mock.timers.tick(420);
    assert.equal(surface.activeItem(), "browser:one");
    assert.equal(document.querySelector<HTMLElement>("#items")!.hidden, true);
    surface.retire("browser:one");
    assert.equal(document.querySelector<HTMLElement>("#stage")!.dataset.completing, "true");
    surface.present({ id: "browser:one", label: "浏览器", status, frame, onReturn: () => returns.push("browser"), onClose: () => removed.push("browser") });
    assert.equal(document.querySelector<HTMLElement>("#stage")!.dataset.completing, "false");
    navigate("biny-computer:remove"); assert.deepEqual(removed, ["computer", "browser"]);
    assert.equal(closed, false);
    assert.equal(document.querySelector<HTMLElement>("#stage")!.dataset.completing, "true");
    assert.equal(captures.canPersistActivity(captures.activityEpoch()), false);
    t.mock.timers.tick(419);
    assert.equal(closed, false);
    t.mock.timers.tick(1);
    assert.equal(closed, true);
    assert.equal(captures.canPersistActivity(captures.activityEpoch()), true);
  } finally {
    surface?.close(); dom?.window.close(); hooks.deregister(); t.mock.timers.reset();
  }
});
