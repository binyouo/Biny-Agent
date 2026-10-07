import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopApplicationImports } from "../src/desktop/electron/main/DesktopApplicationImports.js";
import type { ApplicationImportHistory, ApplicationImportSnapshot } from "../src/imports/types.js";

const input = { previewId: "preview", itemIds: ["one"], workspaceRoot: "/fixture" };
function history(id: string, category: "mcp" | "sessions" = "mcp", status: "imported" | "skipped" | "unknown" = "imported"): ApplicationImportHistory {
  return { id, source: "claude", label: "Claude Code", time: "2026-10-07T01:00:00Z", workspaceRoot: "/fixture", results: [{ id: "one", category, label: "fixture", status }] };
}
function snapshot(histories: ApplicationImportHistory[] = []): ApplicationImportSnapshot {
  return { sources: [], history: histories, sync: { enabled: true, hasSelection: true } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(afterMcpImport: () => Promise<void>) {
  let nextHistory = history("initial");
  let current = snapshot();
  const controller = new DesktopApplicationImports({
    snapshot: async () => current,
    preview: async () => ({ id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }),
    run: async () => { current = snapshot([nextHistory, ...current.history]); return nextHistory; },
    configureSyncSelection: async () => current,
    setSyncEnabled: async () => current,
    sync: async () => current
  }, async () => undefined, afterMcpImport);
  return { controller, setNext: (next: ApplicationImportHistory) => { nextHistory = next; }, setSnapshot: (next: ApplicationImportSnapshot) => { current = next; } };
}

test("successful MCP imports refresh after commit while holding admission until refresh finishes", { timeout: 2_000 }, async () => {
  const started = deferred();
  const finish = deferred();
  const { controller } = fixture(async () => { started.resolve(); await finish.promise; });
  const importing = controller.run(input);
  try {
    assert.equal(await Promise.race([started.promise.then(() => true), importing.then(() => false)]), true,
      "the import must not finish before its MCP refresh begins");
    // The service write is immediately observable through its public snapshot.
    const committed = await controller.snapshot();
    assert.equal(committed.history[0]?.results[0]?.status, "imported");
    await assert.rejects(controller.withRuntimeAdmission(async () => "run"), /导入正在进行/u);
    await assert.rejects(controller.run(input), /导入正在进行/u);
  } finally { finish.resolve(); await importing; await controller.close(); }
});

test("post-commit refresh failure retains success and exposes only a safe independent warning", { timeout: 2_000 }, async () => {
  let fail = true;
  let refreshes = 0;
  const { controller, setNext } = fixture(async () => { refreshes += 1; if (fail) throw new Error("sensitive internal failure"); });
  assert.equal((await controller.run(input)).results[0]?.status, "imported");
  const committed = await controller.snapshot();
  assert.equal(committed.history[0]?.results[0]?.status, "imported");
  assert.equal(committed.sync.lastError, "内容已导入，但 MCP 运行时刷新未完成。请重启 Biny 后检查。");
  await controller.sync();
  assert.equal(refreshes, 1, "old committed history must not trigger another refresh");
  assert.equal((await controller.snapshot()).sync.lastError, committed.sync.lastError);
  fail = false;
  setNext(history("next"));
  await controller.run(input);
  assert.equal(refreshes, 2);
  assert.equal((await controller.snapshot()).sync.lastError, undefined);
  await controller.close();
});

test("sync refreshes once only for newly committed MCP history, without replaying older imports", { timeout: 2_000 }, async () => {
  const old = history("old");
  let current = snapshot([old]);
  let next = current;
  let refreshes = 0;
  const controller = new DesktopApplicationImports({
    snapshot: async () => current,
    preview: async () => ({ id: "preview", source: "claude", label: "Claude Code", items: [], warnings: [] }),
    run: async () => old,
    configureSyncSelection: async () => current,
    setSyncEnabled: async () => current,
    sync: async () => { current = next; return current; }
  }, async () => undefined, async () => { refreshes += 1; });
  await controller.sync();
  assert.equal(refreshes, 0);
  next = snapshot([history("new-a"), history("new-b"), old]);
  await controller.sync();
  assert.equal(refreshes, 1);
  await controller.sync();
  assert.equal(refreshes, 1);
  next = snapshot([history("session", "sessions"), history("skipped", "mcp", "skipped"), history("uncertain", "mcp", "unknown"), ...next.history]);
  await controller.sync();
  assert.equal(refreshes, 1);
  await controller.close();
});

test("non-MCP and unconfirmed imports never invoke the post-commit refresh", async () => {
  let refreshes = 0;
  const { controller, setNext } = fixture(async () => { refreshes += 1; });
  for (const result of [history("session", "sessions"), history("skipped", "mcp", "skipped"), history("unknown", "mcp", "unknown")]) {
    setNext(result);
    await controller.run(input);
  }
  assert.equal(refreshes, 0);
  await controller.close();
});
