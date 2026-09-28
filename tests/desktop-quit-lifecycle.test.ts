import assert from "node:assert/strict";
import { handleDesktopActivation, waitForDesktopQuitCleanup } from "../src/desktop/electron/main/DesktopQuitLifecycle.js";

testCommittedQuitIgnoresDockActivation();
assert.equal(await waitForDesktopQuitCleanup(async () => undefined, 50), "completed");
await testQuitDoesNotWaitForeverForCleanup();
console.log("desktop quit lifecycle tests passed");

async function testQuitDoesNotWaitForeverForCleanup(): Promise<void> {
  const cleanup = waitForDesktopQuitCleanup(() => new Promise<void>(() => undefined), 5);
  const bounded = await Promise.race([
    cleanup,
    new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 100))
  ]);

  assert.equal(bounded, "timed-out", "a stuck cleanup must not hold the app process open indefinitely");
}

function testCommittedQuitIgnoresDockActivation(): void {
  let createCount = 0;
  let showCount = 0;
  handleDesktopActivation(true, undefined, () => { createCount += 1; });
  assert.equal(createCount, 0, "Dock activation must not create a new window after quit is committed");
  handleDesktopActivation(false, { isDestroyed: () => false, show: () => { showCount += 1; } }, () => { createCount += 1; });
  assert.equal(showCount, 1, "normal Dock activation should still show the existing window");
}
