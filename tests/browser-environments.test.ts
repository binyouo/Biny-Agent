import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";

test("browser environments persist user entries and keep default partition stable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-environments-"));
  const file = path.join(root, "browser-environments.json");
  try {
    const store = new BrowserEnvironmentStore(file);
    await store.load();
    assert.deepEqual(store.list().map(({ id, name }) => ({ id, name })), [{ id: "default", name: "默认" }]);
    await assert.rejects(store.delete("default"), /默认环境/);

    const created = await store.create({ name: "Work", proxy: { mode: "fixed_servers", proxyRules: "http=127.0.0.1:7890" } });
    assert.match(created.id, /^[0-9a-f-]{36}$/iu);
    assert.equal(browserPartitionForEnvironment("default"), "persist:biny-browser");
    assert.equal(browserPartitionForEnvironment(created.id), `persist:biny-browser-env-${created.id}`);
    await assert.rejects(store.create({ name: "work", proxy: { mode: "system" } }), /名称已存在/);
    await assert.rejects(store.create({ name: "Invalid proxy", proxy: { mode: "fixed_servers" } }), /代理规则/);
    await assert.rejects(store.create({ name: "Secret proxy", proxy: { mode: "fixed_servers", proxyRules: "http://user:pass@127.0.0.1:7890" } }), /用户名或密码/);

    const reloaded = new BrowserEnvironmentStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.get("work"), created);
    const updated = await reloaded.update(created.id, { name: "Work Account", proxy: { mode: "direct" } });
    assert.deepEqual(updated.proxy, { mode: "direct" });
    await reloaded.delete(created.id);
    assert.deepEqual(reloaded.list().map(({ id }) => id), ["default"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
