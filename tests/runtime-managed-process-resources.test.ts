import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";

const command = `${process.platform === "win32" ? "" : "exec "}${JSON.stringify(process.execPath)} -e "console.log('READY');setInterval(() => console.log('tick'), 20)"`;

test("Host retains transferred output after session close and reaps the process at Host shutdown", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-managed-"));
  const registry = new RuntimeHostResourceRegistry();
  const service = registry.createManagedProcesses({ workspaceRoot: root, processLifetime: "execution-environment", terminationGraceMs: 200, killSettleMs: 200 });
  try {
    const started = await service.start({ command, readiness: { type: "log", pattern: "READY", timeoutMs: 5000, intervalMs: 10 } });
    assert.equal(started.readiness?.status, "ready");
    const before = await service.readOutput(started.processId);
    assert.equal((await service.close())[0]?.status, "transferred");
    assert.equal(registry.hasManagedProcesses(), true);
    // Another session must share the same store without reclaiming a live owner's logs.
    const second = registry.createManagedProcesses({ workspaceRoot: root });
    await second.initialize(); await second.close();
    const deadline = Date.now() + 5_000;
    let after = await service.readOutput(started.processId);
    while (after.totalBytes <= before.totalBytes) {
      assert.ok(Date.now() < deadline, "transferred process stopped producing captured output");
      await new Promise(resolve => setTimeout(resolve, 10));
      after = await service.readOutput(started.processId);
    }
    assert.match(after.content, /tick/u);
    await registry.close();
    assert.equal(registry.hasManagedProcesses(), false);
    assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
    assert.throws(() => registry.createManagedProcesses({ workspaceRoot: root }), /closing/u);
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
});
