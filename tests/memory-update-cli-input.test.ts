import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";

await test("memory update rejects non-object patches without changing persisted facts or revision", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-memory-update-cli-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const memory = new LocalMemory(root, () => { throw new Error("Manual corrections must not call a model."); });
  const paths = runtimeHostPaths(root);
  const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  const preload = path.join(root, "memory-update-transport.mjs");
  try {
    const original = (await memory.writeEntry({ content: "Synthetic release checklist", tags: ["release"] })).entry;
    assert.ok(original);
    await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
    await writeFile(paths.registrationPath, JSON.stringify({
      ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
      persistenceRoot: root, hostEpoch: "memory-update-cli-fixture", token: "synthetic-memory-update-token",
      pid: process.pid, createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    // 保留真实 CLI、Host 发现、memory 方法、操作校验和 SQLite；仅替换连接及请求传输。
    await writeFile(preload, `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { RuntimeHostClient } from ${source("src/runtime/host/client.ts")};
import { LocalMemory } from ${source("src/agent/context/LocalMemory.ts")};
import { executeRuntimeHostMemoryOperation } from ${source("src/runtime/host/memory-operations.ts")};
const memory = new LocalMemory(process.cwd(), () => { throw new Error("Unexpected model request."); });
const context = {
  getCommands: () => ({ agent: { getLocalMemory: () => memory } }),
  scheduleEmbeddingRebuild: () => { throw new Error("Unexpected embedding rebuild."); }
};
let requests = 0;
let closed = 0;
mock.method(childProcess, "spawn", () => { throw new Error("Unexpected Runtime Host start."); });
syncBuiltinESMExports();
mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request."); });
mock.method(RuntimeHostClient, "connect", async () => ({
  memory: RuntimeHostClient.prototype.memory,
  async request(operation, payload) {
    requests++;
    assert.equal(operation, "memory");
    assert.equal(payload.action, "update");
    const result = await executeRuntimeHostMemoryOperation(context, JSON.parse(JSON.stringify(payload)));
    return JSON.parse(JSON.stringify(result));
  },
  async close() { closed++; memory.close(); }
}));
process.once("exit", () => {
  assert.equal(requests, 1);
  assert.equal(closed, 1);
});
`);
    const run = (id: string, entry: string, json: boolean) => spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href,
      path.resolve("src/cli/index.ts"), "memory", "update", id, "--entry", entry, ...(json ? ["--json"] : [])
    ], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15_000 });
    const snapshot = async () => {
      const reader = new MemoryStorage(root);
      try { return await reader.listEntries(); }
      finally { reader.close(); }
    };
    for (const json of [true, false]) {
      for (const entry of ["null", "[]", '"correction"', "42", "false"]) {
        // 既有 content 字段校验不能保护根级 JSON；原行为把这些输入当作空 patch 并递增 revision。
        await t.test(`${entry} in ${json ? "JSON" : "text"} mode is an error and preserves the saved record`, async () => {
          const before = await snapshot();
          const result = run(original.id, entry, json);
          assert.equal(result.error, undefined);
          assert.equal(result.signal, null);
          assert.equal(result.status, 1, `stdout: ${result.stdout}; stderr: ${result.stderr}`);
          assert.equal(result.stdout, "");
          assert.equal(result.stderr, "Memory patch must be a JSON object.\n");
          assert.deepEqual(await snapshot(), before, "invalid patches must preserve content, tags, timestamps and revision");
        });
      }
    }
    for (const [label, patch, json] of [
      ["empty object", {}, true],
      ["content correction", { content: "更新后的发布清单" }, false],
      ["metadata-only correction", { tags: ["updated"] }, true]
    ] as const) {
      await t.test(`${label} remains a valid patch`, async () => {
        const before = await snapshot();
        const result = run(original.id, JSON.stringify(patch), json);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        const value = JSON.parse(result.stdout) as { written: boolean; entry: { id: string; content: string; tags: string[] }; revision: number };
        assert.equal(value.written, true);
        assert.equal(value.entry.id, original.id);
        assert.equal(value.entry.content, "content" in patch ? patch.content : before.entries[0]!.content);
        assert.deepEqual(value.entry.tags, "tags" in patch ? patch.tags : before.entries[0]!.tags);
        assert.equal(value.revision, before.storeRevision + 1);
        const after = await snapshot();
        assert.deepEqual(JSON.parse(JSON.stringify(after.entries)), [value.entry]);
        assert.equal(after.storeRevision, value.revision);
        assert.equal(result.stdout, `${JSON.stringify(value, null, json ? undefined : 2)}\n`);
      });
    }
    await t.test("a valid patch for a missing ID keeps the existing written:false contract", async () => {
      const before = await snapshot();
      const result = run("missing-memory-id", '{"content":"Not stored"}', true);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { written: false, revision: before.storeRevision });
      assert.deepEqual(await snapshot(), before);
    });
  } finally {
    memory.close();
    await rm(paths.registrationPath, { force: true });
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
