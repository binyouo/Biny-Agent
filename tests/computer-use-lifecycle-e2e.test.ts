import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { ComputerUseController, type ComputerDriver } from "../src/computer/controller.js";

test("explicit computer enablement survives config reload without starting native work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-computer-lifecycle-"));
  const credentialStore = { persistent: false, get: async () => undefined, set: async () => undefined, delete: async () => undefined };
  const calls: string[] = [];
  const driver: ComputerDriver = {
    start: async () => { calls.push("start"); }, stop: async () => { calls.push("stop"); },
    list: async () => { calls.push("list"); return { data: { apps: [] }, images: [] }; },
    observe: async () => { throw new Error("unexpected capture"); }, act: async () => { throw new Error("unexpected input"); }
  };
  try {
    const config = configSchema.parse(defaultConfig);
    assert.deepEqual(config.computer, { enabled: false, strictApproval: false, apps: [] });
    assert.throws(() => configSchema.parse({ ...config, computer: { enabled: "yes" } }));
    const store = createFileConfigStore(root, { globalDir: root, credentialStore });
    await updateConfig(store, undefined, current => ({ ...current, computer: { ...current.computer, enabled: true } }));
    const restartedStore = createFileConfigStore(root, { globalDir: root, credentialStore });
    const restored = await restartedStore.load();
    const controller = new ComputerUseController(driver, { enabled: restored.computer.enabled });
    assert.equal(controller.status().state, "ready");
    assert.deepEqual(calls, [], "loading permission intent must not start, capture or input");
    await controller.list("fixture");
    assert.deepEqual(calls, ["start", "list"]);
    await controller.disable();
    await updateConfig(restartedStore, undefined, current => ({ ...current, computer: { ...current.computer, enabled: false } }));
    const saved = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(saved.computer, { enabled: false, strictApproval: false, apps: [] });
    const stopped = new ComputerUseController(driver, { enabled: (await restartedStore.load()).computer.enabled });
    await assert.rejects(stopped.list("fixture"), /computer_disabled/);
    assert.deepEqual(calls, ["start", "list", "stop"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
