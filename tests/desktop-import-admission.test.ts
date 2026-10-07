import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopApplicationImports } from "../src/desktop/electron/main/DesktopApplicationImports.js";
import type { ApplicationImportHistory, ApplicationImportSnapshot } from "../src/imports/types.js";

const snapshot: ApplicationImportSnapshot = { sources: [], history: [], sync: { enabled: true, hasSelection: true } };
const history: ApplicationImportHistory = { id: "batch", source: "claude", label: "Claude Code", time: "2026-10-07T01:00:00Z", workspaceRoot: "/fixture", results: [] };
const input = { previewId: "preview", itemIds: ["one"], workspaceRoot: "/fixture" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(assertReady: () => Promise<void> = async () => undefined) {
  let writes = 0;
  let reads = 0;
  const controller = new DesktopApplicationImports({
    snapshot: async () => { reads += 1; return snapshot; },
    preview: async () => ({ id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }),
    run: async () => { writes += 1; return history; },
    setSyncEnabled: async () => snapshot,
    configureSyncSelection: async () => snapshot,
    sync: async () => { writes += 1; return snapshot; }
  }, assertReady);
  return { controller, writes: () => writes, reads: () => reads };
}

test("a runtime request waiting for initialization fences imports synchronously until its receipt", { timeout: 2_000 }, async () => {
  const { controller, writes } = fixture();
  const receipt = deferred<string>();
  const running = controller.withRuntimeAdmission(async () => await receipt.promise);
  try {
    await assert.rejects(controller.run(input), /请求|任务/u);
    await assert.rejects(controller.sync(), /请求|任务/u);
    assert.equal(writes(), 0);
  } finally { receipt.resolve("accepted"); await running; }
  assert.equal(await controller.run(input), history);
  await controller.close();
});

test("an import waiting for runtime readiness rejects new runtime admission before dispatch", { timeout: 2_000 }, async () => {
  const readiness = deferred<void>();
  const { controller } = fixture(async () => await readiness.promise);
  const importing = controller.run(input);
  let dispatched = false;
  try {
    await assert.rejects(controller.withRuntimeAdmission(async () => { dispatched = true; }), /导入正在进行/u);
    assert.equal(dispatched, false);
  } finally { readiness.resolve(); await importing; await controller.close(); }
});

test("every admission releases on success, rejection and synchronous throw without releasing another request", { timeout: 2_000 }, async () => {
  const { controller } = fixture();
  const receipt = deferred<void>();
  const running = controller.withRuntimeAdmission(async () => await receipt.promise);
  try {
    await assert.rejects(controller.withRuntimeAdmission(async () => { throw new Error("async failure"); }), /async failure/u);
    await assert.rejects(controller.withRuntimeAdmission(() => { throw new Error("sync failure"); }), /sync failure/u);
    assert.equal(await controller.withRuntimeAdmission(async () => "done"), "done");
    await assert.rejects(controller.run(input), /请求|任务/u);
  } finally { receipt.resolve(); await running; }
  assert.equal(await controller.run(input), history);
  await controller.close();
});

test("automatic sync skips pending admissions and resumes at the next bounded interval", { timeout: 2_000 }, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { controller, writes, reads } = fixture();
  const receipt = deferred<void>();
  const changed = deferred<void>();
  const running = controller.withRuntimeAdmission(async () => await receipt.promise);
  try {
    controller.start(async () => { changed.resolve(); });
    t.mock.timers.tick(180_000);
    assert.equal(reads(), 0, "busy intervals must not enqueue persistent snapshots or later sync");
    receipt.resolve();
    await running;
    assert.equal(writes(), 0);
    assert.equal((await controller.snapshot()).sync.lastError, undefined);
    t.mock.timers.tick(60_000);
    await changed.promise;
    assert.equal(writes(), 1);
  } finally { receipt.resolve(); await running; await controller.close(); t.mock.timers.reset(); }
});

test("close rejects new admissions but does not own an already admitted runtime request", { timeout: 2_000 }, async () => {
  const { controller } = fixture();
  const receipt = deferred<string>();
  const running = controller.withRuntimeAdmission(async () => await receipt.promise);
  try {
    await controller.close();
    await assert.rejects(controller.withRuntimeAdmission(async () => "new"), /已关闭/u);
    await assert.rejects(controller.run(input), /已关闭/u);
  } finally { receipt.resolve("accepted"); }
  assert.equal(await running, "accepted");
});
