import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopApplicationImports } from "../src/desktop/electron/main/DesktopApplicationImports.js";
import type { ApplicationImportHistory, ApplicationImportSnapshot } from "../src/imports/types.js";

const snapshot: ApplicationImportSnapshot = { sources: [], history: [], sync: { enabled: false, hasSelection: false } };
const history: ApplicationImportHistory = { id: "batch", source: "claude", label: "Claude Code", time: "2026-10-07T01:00:00Z", workspaceRoot: "/fixture", results: [] };
test("Desktop import rejects busy or recovering runtime before dispatching side effects", async () => {
  let dispatched = false;
  const controller = new DesktopApplicationImports({
    snapshot: async () => snapshot,
    preview: async () => ({ id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }),
    run: async () => { dispatched = true; return history; },
    setSyncEnabled: async () => snapshot,
    configureSyncSelection: async () => snapshot,
    sync: async () => { dispatched = true; return snapshot; }
  }, async () => { throw new Error("runtime busy"); });
  await assert.rejects(controller.run({ previewId: "preview", itemIds: ["one"], workspaceRoot: "/fixture" }), /runtime busy/u);
  await assert.rejects(controller.sync(), /runtime busy/u);
  assert.equal(dispatched, false);
});

test("admitted imports fence new work, concurrent imports and shutdown without replay", async () => {
  let complete!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { complete = resolve; });
  let writes = 0;
  const controller = new DesktopApplicationImports({
    snapshot: async () => snapshot,
    preview: async () => ({ id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }),
    run: async () => { writes += 1; entered(); await pending; return history; },
    setSyncEnabled: async () => snapshot,
    configureSyncSelection: async () => snapshot,
    sync: async () => snapshot
  }, async () => undefined);
  const input = { previewId: "preview", itemIds: ["one"], workspaceRoot: "/fixture" };
  const running = controller.run(input);
  await ready;
  assert.throws(() => controller.assertIdle(), /导入正在进行/u);
  await assert.rejects(controller.run(input), /导入正在进行/u);
  await assert.rejects(controller.sync(), /导入正在进行/u);
  let closed = false;
  const closing = controller.close().then(() => { closed = true; });
  assert.equal(closed, false);
  complete();
  assert.equal(await running, history);
  await closing;
  assert.equal(writes, 1);
  await assert.rejects(controller.run(input), /已关闭/u);
  await assert.rejects(controller.preview("claude"), /已关闭/u);
  await assert.rejects(controller.setSyncEnabled(true), /已关闭/u);
  await assert.rejects(controller.configureSyncSelection(input), /已关闭/u);
});

test("automatic sync schedules the same guarded service and cancels on close", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let changed!: () => void;
  let writes = 0;
  const notification = new Promise<void>(resolve => { changed = resolve; });
  const active = { ...snapshot, sync: { enabled: true, hasSelection: true } };
  const controller = new DesktopApplicationImports({
    snapshot: async () => active,
    preview: async () => ({ id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }),
    run: async () => history,
    setSyncEnabled: async () => active,
    configureSyncSelection: async () => active,
    sync: async () => { writes += 1; return active; }
  }, async () => undefined);
  try {
    controller.start(async () => changed());
    t.mock.timers.tick(60_000);
    await notification;
    assert.equal(writes, 1);
    await controller.close();
    t.mock.timers.tick(120_000);
    assert.equal(writes, 1);
  } finally { t.mock.timers.reset(); await controller.close(); }
});

test("closing also waits for an admitted preview state write", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const controller = new DesktopApplicationImports({
    snapshot: async () => snapshot,
    preview: async () => { await pending; return { id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }; },
    run: async () => history,
    setSyncEnabled: async () => snapshot,
    configureSyncSelection: async () => snapshot,
    sync: async () => snapshot
  }, async () => undefined);
  const preview = controller.preview("claude");
  let closed = false;
  const closing = controller.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  finish();
  await preview;
  await closing;
  assert.equal(closed, true);
  await assert.rejects(controller.snapshot(), /已关闭/u);
});
