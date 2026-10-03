import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { agentDir } from "../src/session/store.js";

test("只读运行投影不创建数据库、不迁移、不接受写入", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-read-only-"));
  try {
    assert.equal(await RuntimeEventAuthority.openReadOnly(root), undefined);
    await assert.rejects(access(path.join(agentDir(root), "runtime.sqlite")), { code: "ENOENT" });
    const writer = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const event = writer.appendEvent({ sessionId: "session", runId: "run", turnId: "turn", eventType: "test.saved", payload: { text: "saved" } });
    writer.close();
    const before = await readFile(writer.databasePath);
    const reader = await RuntimeEventAuthority.openReadOnly(root);
    assert.ok(reader);
    try {
      assert.deepEqual(reader.readEvents().events, [event]);
      assert.throws(() => reader.appendEvent({ sessionId: "session", runId: "run", turnId: "turn", eventType: "test.forbidden" }), /readonly|read-only/iu);
    } finally { reader.close(); }
    assert.deepEqual(await readFile(writer.databasePath), before);
    const outdated = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    outdated.databaseHandle().exec("PRAGMA user_version = 1");
    outdated.close();
    const oldBytes = await readFile(writer.databasePath);
    await assert.rejects(RuntimeEventAuthority.openReadOnly(root), /requires an explicit runtime startup/u);
    assert.deepEqual(await readFile(writer.databasePath), oldBytes, "浏览不得执行 schema 升级");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
