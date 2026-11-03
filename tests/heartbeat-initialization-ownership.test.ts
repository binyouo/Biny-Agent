import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HeartbeatFileStore } from "../src/agent/context/heartbeat.js";

for (const contents of ["owner checklist\n- Call the dentist\n", ""]) {
  test(`initialization preserves a concurrently created ${contents ? "checklist" : "empty file"}`, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-create-"));
    const store = new HeartbeatFileStore(path.join(root, "config"));
    const mkdir = fs.mkdir;
    let created = false;
    context.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await mkdir(...args);
      if (args[0] === path.dirname(store.path) && !created) {
        created = true;
        await fs.writeFile(store.path, contents, { flag: "wx" });
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      await store.ensure();
      assert.equal(created, true, "the competing file was created after the initial missing read");
      assert.equal(await fs.readFile(store.path, "utf8"), contents);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("a delayed initializer preserves edits after another initializer wins", { timeout: 5_000 }, async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-initializers-"));
  const store = new HeartbeatFileStore(root);
  const mkdir = fs.mkdir;
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let delayed = false;
  context.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await mkdir(...args);
    if (args[0] === root && !delayed) {
      delayed = true;
      reached.resolve();
      await release.promise;
    }
    return result;
  });
  syncBuiltinESMExports();
  const pending = store.ensure();
  try {
    await reached.promise;
    await new HeartbeatFileStore(root).ensure();
    await fs.writeFile(store.path, "owner updated the newly created checklist\n");
    release.resolve();
    await pending;
    assert.equal(await fs.readFile(store.path, "utf8"), "owner updated the newly created checklist\n");
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing checklist is created and repeated initialization preserves it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-normal-"));
  try {
    const store = new HeartbeatFileStore(path.join(root, "config"));
    await store.ensure();
    assert.match(await store.read() ?? "", /Heartbeat Checklist/u);
    await fs.writeFile(store.path, "custom checklist\n");
    await store.ensure();
    assert.equal(await fs.readFile(store.path, "utf8"), "custom checklist\n");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("initialization still propagates creation errors other than EEXIST", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-create-error-"));
  const store = new HeartbeatFileStore(root);
  const writeFile = fs.writeFile;
  const failure = Object.assign(new Error("injected write failure"), { code: "EIO" });
  context.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === store.path) throw failure;
    return await writeFile(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.ensure(), error => error === failure);
    await assert.rejects(fs.stat(store.path), { code: "ENOENT" });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// As on the initial read path, an existing but unreadable target is an error.
test("a concurrently created directory is not treated as a usable checklist", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-directory-"));
  const store = new HeartbeatFileStore(path.join(root, "config"));
  const mkdir = fs.mkdir;
  let created = false;
  context.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await mkdir(...args);
    if (args[0] === path.dirname(store.path) && !created) {
      created = true;
      await mkdir(store.path);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.ensure(), { code: "EISDIR" });
    assert.equal((await fs.stat(store.path)).isDirectory(), true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
