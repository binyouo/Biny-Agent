import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { registerHooks } from "node:module";
import type { BrowserCuaArgs } from "../src/browser/cuaSchema.js";

const hooks = registerHooks({ load(url, context, next) {
  if (/\/electron\/index\.js$/u.test(url)) return { format: "module", shortCircuit: true,
    source: "export class BrowserWindow {} export class WebContentsView {} export const clipboard = {}; export const session = {};" };
  return next(url);
} });
const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
hooks.deregister();

interface Command { method: string; params: Record<string, unknown> }
interface ServiceSubject {
  performCoordinateAction(action: BrowserCuaArgs, signal: AbortSignal | undefined, onAction: ((contents: object) => void) | undefined, contents: object): Promise<unknown>;
  executeAutomation(method: string, args: Record<string, unknown>, signal?: AbortSignal, onAction?: (contents: object) => void): Promise<unknown>;
  evaluate(expression: string, signal?: AbortSignal, contents?: object): Promise<unknown>;
  sendDebuggerCommand(method: string, params: Record<string, unknown>, signal?: AbortSignal, owner?: object, onAction?: (contents: object) => void): Promise<unknown>;
  pageState(contents?: object): Promise<unknown>;
  ensureAutomationContents(args: Record<string, unknown>): Promise<object>;
  pageOperation(operation: string, args: Record<string, unknown>, signal?: AbortSignal, contents?: object): Promise<unknown>;
  click(selector: string, signal?: AbortSignal, onAction?: (contents: object) => void, contents?: object): Promise<unknown>;
}

function coordinateFixture(options: { failRelease?: boolean } = {}) {
  const subject = new DesktopBrowserService(async () => "unused-cookie-jar.json") as unknown as ServiceSubject;
  const contents = {};
  const commands: Command[] = [];
  let failedRelease = false;
  subject.evaluate = async () => ({ width: 800, height: 600 });
  subject.sendDebuggerCommand = async (method, params, _signal, _owner, onAction) => {
    commands.push({ method, params });
    if (options.failRelease && params.type === "keyUp" && !failedRelease) {
      failedRelease = true;
      throw new Error("key release response lost");
    }
    onAction?.(contents);
    return {};
  };
  subject.pageState = async () => ({ url: "https://example.test/", title: "Fixture" });
  return { subject, contents, commands };
}

test("coordinate browser input stays within the viewport and releases mouse and key input", async () => {
  const { subject, contents, commands } = coordinateFixture();
  let actionCount = 0;
  const onAction = () => { actionCount++; };
  await assert.rejects(subject.performCoordinateAction({ action: "click", x: 800, y: 20 }, undefined, onAction, contents), /坐标超出/u);
  assert.equal(commands.length, 0);

  await subject.performCoordinateAction({ action: "doubleClick", x: 320, y: 210 }, undefined, onAction, contents);
  assert.deepEqual(commands.map(command => [command.method, command.params.type]), [
    ["Input.dispatchMouseEvent", "mouseMoved"],
    ["Input.dispatchMouseEvent", "mousePressed"],
    ["Input.dispatchMouseEvent", "mouseReleased"]
  ]);
  assert.equal(commands[1]!.params.clickCount, 2);
  assert.equal(commands[2]!.params.clickCount, 2);
  assert.deepEqual(commands[1]!.params.x, 320);
  assert.equal(actionCount, 1);

  commands.length = 0;
  await subject.performCoordinateAction({ action: "keypress", key: "c", modifiers: ["Control"] }, undefined, onAction, contents);
  assert.deepEqual(commands.map(command => [command.params.type, command.params.modifiers]), [["keyDown", 2], ["keyUp", 2]]);
  assert.equal(actionCount, 2);

  const failed = coordinateFixture({ failRelease: true });
  await assert.rejects(failed.subject.performCoordinateAction({ action: "keypress", key: "Enter", modifiers: [] }, undefined, onAction, failed.contents), /response lost/u);
  assert.deepEqual(failed.commands.map(command => command.params.type), ["keyDown", "keyUp", "keyUp"]);
});

test("DOM references are bound to one snapshot and expire after an action or navigation", async (t) => {
  const subject = new DesktopBrowserService(async () => "unused-cookie-jar.json") as unknown as ServiceSubject;
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => "https://example.test/",
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false
  });
  t.after(() => { destroyed = true; contents.emit("destroyed"); });
  const target = { tag: "button", role: "button", name: "Save", selector: "#save", box: { x: 10, y: 20, width: 100, height: 30 } };
  let actions = 0;
  subject.ensureAutomationContents = async () => contents;
  subject.pageOperation = async operation => {
    if (operation === "dom_snapshot") return { url: contents.getURL(), title: "Fixture", elements: [target] };
    if (operation === "scroll") return { x: 0, y: 100 };
    assert.equal(operation, "dom_target");
    return { selector: target.selector };
  };
  subject.click = async selector => { actions++; assert.equal(selector, "#save"); return { clicked: true }; };

  const snapshot = await subject.executeAutomation("dom_snapshot", {});
  const snapshotId = (snapshot as { snapshotId: string }).snapshotId;
  assert.equal((snapshot as { elements: { ref: string }[] }).elements[0]!.ref, "e1");
  assert.deepEqual(await subject.executeAutomation("dom_action", { snapshotId, ref: "e1", action: { m: "click" } }), { clicked: true });
  await assert.rejects(subject.executeAutomation("dom_action", { snapshotId, ref: "e1", action: { m: "click" } }), /失效/u);
  assert.equal(actions, 1);

  const afterScroll = await subject.executeAutomation("dom_snapshot", {});
  await subject.executeAutomation("scroll", { x: 0, y: 100 });
  await assert.rejects(subject.executeAutomation("dom_action", { snapshotId: (afterScroll as { snapshotId: string }).snapshotId, ref: "e1", action: { m: "click" } }), /失效/u);
  assert.equal(actions, 1);

  const next = await subject.executeAutomation("dom_snapshot", {});
  const nextId = (next as { snapshotId: string }).snapshotId;
  contents.getURL = () => "https://example.test/next";
  await assert.rejects(subject.executeAutomation("dom_action", { snapshotId: nextId, ref: "e1", action: { m: "click" } }), /失效/u);
  assert.equal(actions, 1);
});
