import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FatigueService } from "../src/agent/context/fatigue.js";

const now = new Date(2026, 9, 30, 10);
async function withService(run: (service: FatigueService) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-fatigue-read-error-"));
  try { await run(new FatigueService({ agentDir: root, now: () => now })); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
for (const code of ["EIO", "EACCES"]) {
  for (const action of ["read", "recordMessage", "sleep", "wake", "rest"] as const) {
    test(`${action} preserves stored and cached fatigue when reading fails with ${code}`, async () => {
      await withService(async service => {
        await service.recordMessage();
        await service.recordMessage();
        await service.change("sleep");
        const before = await fs.readFile(service.path, "utf8");
        const status = service.status();
        const failure = Object.assign(new Error(`synthetic ${code}`), { code });
        const originalRead = fs.readFile;
        let injections = 0;
        fs.readFile = (async (file: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
          if (file === service.path) { injections += 1; throw failure; }
          return Reflect.apply(originalRead, fs, [file, ...args]);
        }) as typeof fs.readFile;
        try {
          await assert.rejects(action === "read" || action === "recordMessage" ? service[action]() : service.change(action), error => error === failure);
        } finally { fs.readFile = originalRead; }
        assert.equal(injections, 1);
        assert.equal(await fs.readFile(service.path, "utf8"), before);
        assert.deepEqual(service.status(), status);
        assert.equal((await service.currentStatus()).manualSleep, true);
      });
    });
  }
}
test("missing state remains a valid fresh-state fallback", async () => {
  await withService(async service => {
    assert.equal((await service.currentStatus()).messageCount, 0);
    assert.equal((await service.recordMessage()).messageCount, 1);
  });
});
for (const [label, content] of [["malformed JSON", "{"], ["null", "null"], ["invalid schema", '{"fatigue":101}']] as const) {
  test(`${label} retains the existing default-state recovery behavior`, async () => {
    await withService(async service => {
      await fs.writeFile(service.path, content);
      assert.equal((await service.currentStatus()).messageCount, 0);
      const result = await service.recordMessage();
      assert.equal(result.messageCount, 1);
      assert.equal(result.manualSleep, false);
      assert.equal(JSON.parse(await fs.readFile(service.path, "utf8")).fatigue, 1.5);
    });
  });
}
test("valid state and legacy numeric lastMessageTime remain readable", async () => {
  await withService(async service => {
    await service.recordMessage(); await service.recordMessage(); await service.change("sleep");
    const state = JSON.parse(await fs.readFile(service.path, "utf8"));
    state.lastMessageTime = now.getTime();
    await fs.writeFile(service.path, JSON.stringify(state));
    assert.equal((await service.currentStatus()).manualSleep, true);
    assert.equal((await service.recordMessage()).messageCount, 3);
    assert.equal((await service.currentStatus()).manualSleep, true);
  });
});
test("valid two-hour daytime sleep transition remains persisted", async () => {
  await withService(async service => {
    await service.change("sleep");
    const later = new FatigueService({agentDir: path.dirname(service.path), now: () => new Date(now.getTime() + 2 * 60 * 60 * 1000)});
    assert.equal((await later.currentStatus()).manualSleep, false);
    assert.equal(JSON.parse(await fs.readFile(service.path,"utf8")).manualSleep,false);
  });
});

test("a directory at the state path is not treated as missing or damaged JSON", async () => {
  await withService(async service => {
    await fs.mkdir(service.path);
    await assert.rejects(service.initialize(), { code: "EISDIR" });
    assert.equal((await fs.stat(service.path)).isDirectory(), true);
  });
});
