import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { ManagedProcessService, type ManagedProcessSnapshot } from "../src/runtime/ManagedProcessService.js";

const command = `${process.platform === "win32" ? "" : "exec "}${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Managed process shutdown test exceeded 5 seconds")), 5_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanup(service: ManagedProcessService): Promise<void> {
  for (const record of await service.list()) await service.stop(record.processId, "test cleanup");
  await service.close();
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

await test("close rejects a background start still preparing its filesystem", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-close-preparing-"));
  const service = new ManagedProcessService({ workspaceRoot: root, terminationGraceMs: 200, killSettleMs: 200 });
  try {
    await service.initialize();
    const pending = service.start({ command }).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error })
    );
    const closing = service.close();
    assert.strictEqual(service.close(), closing, "concurrent close calls share cleanup");
    assert.deepEqual(await closing, []);
    const outcome = await pending;
    assert.ok("error" in outcome, "a start must not spawn after close has already drained the registry");
    assert.match(String(outcome.error), /closing/u);
    assert.deepEqual(await service.list(), []);
    await assert.rejects(service.start({ command }), /closing/u);
  } finally {
    await cleanup(service);
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const processLifetime of ["runtime", "execution-environment"] as const) {
  await test(`close owns a spawned ${processLifetime} process before the log descriptor closes`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-managed-close-spawned-"));
    const service = new ManagedProcessService({ workspaceRoot: root, processLifetime, terminationGraceMs: 200, killSettleMs: 200 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realOpen = fs.open;
    let pending: Promise<ManagedProcessSnapshot> | undefined;
    try {
      await service.initialize();
      mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]).endsWith(".log")) {
          const close = handle.close.bind(handle);
          mock.method(handle, "close", async () => {
            entered.resolve();
            await release.promise;
            await close();
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      pending = service.start({ command });
      await withinDeadline(entered.promise);
      const closed = await withinDeadline(service.close());
      release.resolve();
      const started = await pending;
      assert.equal(closed.length, 1, "close must include a child that has already spawned");
      const expected = processLifetime === "runtime" ? "stopped" : "transferred";
      assert.equal(closed[0]?.status, expected);
      assert.equal((await service.status(started.processId)).cleanup.status, expected);
      assert.equal(alive(started.pid), processLifetime === "execution-environment");
      assert.deepEqual(await service.close(), closed, "completed close remains idempotent");
    } finally {
      release.resolve();
      await pending?.catch(() => undefined);
      mock.restoreAll();
      syncBuiltinESMExports();
      await cleanup(service);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
