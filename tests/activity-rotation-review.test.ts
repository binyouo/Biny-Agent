/** 交叉 review 回归：最终 source 校验和异步删除的生命周期边界。 */
import assert from "node:assert/strict";
import { promises as fs, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ActivityStore } from "../src/activity/store.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";

const now = new Date("2026-09-30T12:00:00.000Z");
const encoded = Buffer.alloc(50, 2);
const replacement = Buffer.alloc(200, 9);

for (const replaceAt of [2, 3]) {
  test(`source replacement at async identity check ${replaceAt} cannot be overwritten`, async (context) => {
    const fixture = await createFixture("2026-09-28T12:00:00.000Z");
    const originalRealpath = fs.realpath;
    let identityChecks = 0;
    let injectedReplacement = false;
    const mocked = context.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
      const result = await originalRealpath(...args);
      if (args[0] === fixture.source && ++identityChecks === replaceAt) {
        // 此次 lstat 已读到旧 identity，realpath 的结果仍是同一 canonical path。
        writeFileSync(`${fixture.source}.replacement`, replacement);
        renameSync(`${fixture.source}.replacement`, fixture.source);
        injectedReplacement = true;
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      await fixture.store.rotateSnapshots(100, now, async () => ({ data: encoded, width: 50, height: 50 }));
      assert.deepEqual(await fs.readFile(fixture.source), injectedReplacement ? replacement : encoded,
        "an injected replacement must survive; without injection, compression may publish");
      const snapshot = fixture.store.getSessionDetail(fixture.sessionId)?.snapshots[0];
      assert.equal(snapshot?.bytes, injectedReplacement ? 200 : 50);
      assert.equal(snapshot?.storageTier, injectedReplacement ? "hot" : "warm");
      if (replaceAt === 2) {
        assert.equal(injectedReplacement, true, "the commit-side stale identity must be exercised");
      } else {
        assert.equal(injectedReplacement, false, "the final identity check must not yield before publication");
        assert.equal(identityChecks, 2, "only reservation and commit preflight use async source checks");
      }
      assert.equal((await fs.readdir(path.dirname(fixture.source))).some((name) => name.endsWith(".tmp")), false);
      await assertUnlocked(fixture.root);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      await fixture.cleanup();
    }
  });
}

for (const removal of ["retention", "capacity"] as const) {
  for (const reopen of [false, true]) {
    test(`${removal} deletion stops after ${reopen ? "close/reopen" : "close"} during unlink`, async (context) => {
      const fixture = await createFixture(removal === "retention"
        ? "2026-08-01T12:00:00.000Z" : now.toISOString());
      const databasePath = path.join(fixture.root, AGENT_DATABASE_FILE);
      const setup = new DatabaseSync(databasePath);
      try {
        if (removal === "retention") {
          setup.prepare("UPDATE activity_snapshots SET storage_tier = 'cold' WHERE id = ?").run(fixture.snapshotId);
        } else {
          setup.prepare("UPDATE activity_snapshots SET bytes = ? WHERE id = ?").run(2 * 1024 * 1024, fixture.snapshotId);
        }
      } finally {
        setup.close();
      }
      const originalUnlink = fs.unlink;
      let interrupted = false;
      const mocked = context.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
        await originalUnlink(...args);
        if (args[0] === fixture.source) {
          interrupted = true;
          await fixture.store.close();
          if (reopen) await fixture.store.open(fixture.root, fixture.root);
        }
      });
      syncBuiltinESMExports();
      try {
        await fixture.store.rotateSnapshots(removal === "capacity" ? 1 : 100, now);
        assert.equal(interrupted, true, "close must happen inside the unlink await boundary");
        await assert.rejects(fs.access(fixture.source), { code: "ENOENT" });
        const inspect = new DatabaseSync(databasePath);
        try {
          assert.ok(inspect.prepare("SELECT id FROM activity_snapshots WHERE id = ?").get(fixture.snapshotId),
            "the expired rotation must not change metadata after its database binding is closed");
        } finally {
          inspect.close();
        }
        if (reopen) assert.equal(fixture.store.snapshot().fallbackCaptures, 1);
        await assertUnlocked(fixture.root);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
        await fixture.cleanup();
      }
    });
  }
}

test("rotation accepts an ancestor directory alias such as macOS /var", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-root-alias-"));
  const actualParent = path.join(parent, "actual");
  const aliasParent = path.join(parent, "alias");
  const root = path.join(aliasParent, "activity");
  const store = new ActivityStore();
  try {
    await fs.mkdir(actualParent);
    await fs.symlink(actualParent, aliasParent, "dir");
    await store.open(root, path.join(actualParent, "agent"));
    const capturedAt = "2026-09-28T12:00:00.000Z";
    const sessionId = store.startSession(capturedAt);
    const capture = await store.recordFallbackCapture({
      sessionId, occurredAt: capturedAt, eventType: "screenshot", jpeg: Buffer.alloc(200, 1)
    });
    assert.ok(capture.snapshotId);
    const source = store.getSnapshotPath(capture.snapshotId);
    assert.ok(source);
    let compressed = false;
    await store.rotateSnapshots(100, now, async () => {
      compressed = true;
      return { data: encoded, width: 50, height: 50 };
    });
    assert.equal(compressed, true, "a valid root ancestor alias must not silently disable compression");
    assert.deepEqual(await fs.readFile(source), encoded);
    assert.equal(store.getSessionDetail(sessionId)?.snapshots[0]?.storageTier, "warm");
    await assertUnlocked(root);
  } finally {
    await store.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

for (const link of ["leaf", "directory"] as const) {
  test(`rotation rejects an out-of-root screenshot ${link} symlink`, async () => {
    const fixture = await createFixture("2026-09-28T12:00:00.000Z");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-outside-"));
    try {
      let externalSource: string;
      if (link === "leaf") {
        externalSource = path.join(outside, "private.jpg");
        await fs.writeFile(externalSource, replacement);
        await fs.unlink(fixture.source);
        await fs.symlink(externalSource, fixture.source);
      } else {
        const externalDirectory = path.join(outside, "screenshots");
        await fs.rename(path.dirname(fixture.source), externalDirectory);
        await fs.symlink(externalDirectory, path.dirname(fixture.source), "dir");
        externalSource = path.join(externalDirectory, path.basename(fixture.source));
        await fs.writeFile(externalSource, replacement);
      }
      let compressed = false;
      await fixture.store.rotateSnapshots(100, now, async () => {
        compressed = true;
        return { data: encoded, width: 50, height: 50 };
      });
      assert.equal(compressed, false, "unsafe screenshot paths must never reach the compressor");
      assert.deepEqual(await fs.readFile(externalSource), replacement);
      assert.equal(fixture.store.getSessionDetail(fixture.sessionId)?.snapshots[0]?.storageTier, "hot");
      await assertUnlocked(fixture.root);
    } finally {
      await fixture.cleanup();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
}

async function createFixture(capturedAt: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-activity-rotation-review-"));
  const store = new ActivityStore();
  await store.open(root, root);
  const sessionId = store.startSession(capturedAt);
  const capture = await store.recordFallbackCapture({
    sessionId, occurredAt: capturedAt, eventType: "screenshot", jpeg: Buffer.alloc(200, 1)
  });
  assert.ok(capture.snapshotId);
  const snapshotId = capture.snapshotId;
  const source = store.getSnapshotPath(snapshotId);
  assert.ok(source);
  return {
    root, store, sessionId, snapshotId, source,
    cleanup: async () => {
      await store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

async function assertUnlocked(root: string): Promise<void> {
  await assert.rejects(fs.access(path.join(root, ".activity.files.lock")), { code: "ENOENT" });
}
