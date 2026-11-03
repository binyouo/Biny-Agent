import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";

const command = `${process.platform === "win32" ? "" : "exec "}${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;

for (const phase of ["initialization", "log preparation"] as const) {
  for (const closing of [false, true]) {
    await test(`${closing ? "close and cancellation" : "cancellation"} during ${phase} prevents spawn and releases prepared files`, { timeout: 10_000 }, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-cancel-"));
      const service = new ManagedProcessService({ workspaceRoot: root });
      const controller = new AbortController();
      const reason = new Error("cancel at filesystem boundary");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const realMkdir = fs.mkdir;
      const realOpen = fs.open;
      let activeHandles = 0;
      let spawns = 0;
      t.mock.method(childProcess, "spawn", () => { spawns++; throw new Error("No command may spawn"); });
      t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
        if (phase === "initialization" && String(args[0]).endsWith("logs-v1")) { entered.resolve(); await release.promise; }
        return realMkdir(...args);
      });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        activeHandles++;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          if (phase === "log preparation" && String(args[0]).endsWith("owner.json")) { entered.resolve(); await release.promise; }
          try { await close(); } finally { activeHandles--; }
        });
        return handle;
      });
      syncBuiltinESMExports();
      const pending = service.start({ command, signal: controller.signal });
      const rejected = assert.rejects(pending, error => closing ? /closing/u.test(String(error)) : error === reason);
      try {
        await entered.promise;
        const cleanup = closing ? service.close() : undefined;
        controller.abort(reason);
        release.resolve();
        await rejected;
        await cleanup;
        assert.equal(spawns, 0);
        assert.deepEqual(await service.list(), []);
        assert.equal(activeHandles, 0);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        await service.close();
        t.mock.restoreAll(); syncBuiltinESMExports();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}

await test("initial cancellation does not initialize or spawn", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-initial-cancel-"));
  const service = new ManagedProcessService({ workspaceRoot: root });
  const reason = new Error("already cancelled");
  const controller = new AbortController(); controller.abort(reason);
  const initialize = t.mock.method(service, "initialize", async () => assert.fail("must not initialize"));
  await assert.rejects(service.start({ command, signal: controller.signal }), error => error === reason);
  assert.equal(initialize.mock.callCount(), 0);
  await fs.rm(root, { recursive: true, force: true });
});

await test("post-spawn cancellation retains ownership and actually stops the child", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-spawn-cancel-"));
  const service = new ManagedProcessService({ workspaceRoot: root, terminationGraceMs: 200, killSettleMs: 200 });
  const controller = new AbortController();
  const reason = new Error("cancel after spawn");
  const realSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const child = realSpawn(...args);
    if (String(args[0]) === command) controller.abort(reason);
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(service.start({ command, signal: controller.signal }), error => error === reason);
    const [record] = await service.list();
    assert.ok(record);
    assert.equal(record.cleanup.status, "stopped");
    assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
  } finally {
    await service.shutdown();
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
