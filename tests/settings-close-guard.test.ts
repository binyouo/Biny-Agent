import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { desktopIpc, type DesktopSettingsCloseRequest } from "../src/desktop/protocol.js";
import {
  DesktopSettingsCloseCoordinator,
  type SettingsCloseRenderer
} from "../src/desktop/electron/main/DesktopSettingsCloseCoordinator.js";

class FakeRenderer extends EventEmitter {
  destroyed = false;
  throwOnSend = false;
  sent: Array<{ channel: string; request: DesktopSettingsCloseRequest }> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, request: DesktopSettingsCloseRequest): void {
    if (this.throwOnSend) throw new Error("renderer unavailable");
    this.sent.push({ channel, request });
  }
}

await testCleanStateClosesWithoutRendererRoundTrip();
await testQuitDoesNotWaitForUnsavedSettingsDraft();
await testSaveAndDiscardPermitClose();
await testCancelKeepsDraftDirty();
await testConcurrentCloseSharesOnePrompt();
await testUnavailableRendererAndTimeoutCancel();
console.log("settings close guard tests passed");

async function testCleanStateClosesWithoutRendererRoundTrip(): Promise<void> {
  const coordinator = new DesktopSettingsCloseCoordinator(20);
  const renderer = new FakeRenderer();
  assert.equal(await coordinator.request(asRenderer(renderer), "window"), "proceed");
  assert.equal(renderer.sent.length, 0);
}

async function testQuitDoesNotWaitForUnsavedSettingsDraft(): Promise<void> {
  const coordinator = new DesktopSettingsCloseCoordinator(20);
  const renderer = new FakeRenderer();
  coordinator.updateState({ dirty: true, canSave: true, open: true });

  assert.equal(await coordinator.request(asRenderer(renderer), "quit"), "proceed");
  assert.equal(renderer.sent.length, 0);
}

async function testSaveAndDiscardPermitClose(): Promise<void> {
  for (const response of ["saved", "discarded"] as const) {
    const coordinator = new DesktopSettingsCloseCoordinator(50);
    const renderer = new FakeRenderer();
    coordinator.updateState({ dirty: true, canSave: true, open: true });
    const decision = coordinator.request(asRenderer(renderer), "window");
    const request = renderer.sent[0]?.request;
    assert.equal(renderer.sent[0]?.channel, desktopIpc.settingsCloseRequest);
    assert.equal(request?.intent, "window");
    assert.equal(request?.canSave, true);
    assert.equal(coordinator.resolve(request!.requestId, response), true);
    assert.equal(await decision, "proceed");
    assert.equal(await coordinator.request(asRenderer(renderer), "window"), "proceed");
    assert.equal(renderer.sent.length, 1, "accepted response clears the main-process dirty bit");
  }
}

async function testCancelKeepsDraftDirty(): Promise<void> {
  const coordinator = new DesktopSettingsCloseCoordinator(50);
  const renderer = new FakeRenderer();
  coordinator.updateState({ dirty: true, canSave: false, open: true });
  const firstDecision = coordinator.request(asRenderer(renderer), "window");
  const first = renderer.sent[0]!.request;
  assert.equal(first.canSave, false);
  assert.equal(coordinator.resolve(first.requestId, "cancelled"), true);
  assert.equal(await firstDecision, "cancel");

  const secondDecision = coordinator.request(asRenderer(renderer), "window");
  assert.equal(renderer.sent.length, 2, "cancel does not silently discard the draft");
  const second = renderer.sent[1]!.request;
  coordinator.resolve(second.requestId, "discarded");
  assert.equal(await secondDecision, "proceed");
  assert.equal(coordinator.resolve(second.requestId, "saved"), false, "a response is one-shot");
}

async function testConcurrentCloseSharesOnePrompt(): Promise<void> {
  const coordinator = new DesktopSettingsCloseCoordinator(50);
  const renderer = new FakeRenderer();
  coordinator.updateState({ dirty: true, canSave: true, open: true });
  const first = coordinator.request(asRenderer(renderer), "window");
  const second = coordinator.request(asRenderer(renderer), "window");
  assert.equal(renderer.sent.length, 1);
  coordinator.resolve(renderer.sent[0]!.request.requestId, "discarded");
  assert.deepEqual(await Promise.all([first, second]), ["proceed", "proceed"]);
}

async function testUnavailableRendererAndTimeoutCancel(): Promise<void> {
  const destroyedCoordinator = new DesktopSettingsCloseCoordinator(20);
  const destroyed = new FakeRenderer();
  destroyed.destroyed = true;
  destroyedCoordinator.updateState({ dirty: true, canSave: true, open: true });
  assert.equal(await destroyedCoordinator.request(asRenderer(destroyed), "window"), "cancel");

  const failedSendCoordinator = new DesktopSettingsCloseCoordinator(20);
  const failedSend = new FakeRenderer();
  failedSend.throwOnSend = true;
  failedSendCoordinator.updateState({ dirty: true, canSave: true, open: true });
  assert.equal(await failedSendCoordinator.request(asRenderer(failedSend), "window"), "cancel");

  const crashedCoordinator = new DesktopSettingsCloseCoordinator(100);
  const crashed = new FakeRenderer();
  crashedCoordinator.updateState({ dirty: true, canSave: true, open: true });
  const crashedDecision = crashedCoordinator.request(asRenderer(crashed), "window");
  crashed.emit("render-process-gone");
  assert.equal(await crashedDecision, "cancel");

  const timeoutCoordinator = new DesktopSettingsCloseCoordinator(5);
  const timedOut = new FakeRenderer();
  timeoutCoordinator.updateState({ dirty: true, canSave: true, open: true });
  assert.equal(await timeoutCoordinator.request(asRenderer(timedOut), "window"), "cancel");
}

function asRenderer(renderer: FakeRenderer): SettingsCloseRenderer {
  return renderer as unknown as SettingsCloseRenderer;
}
