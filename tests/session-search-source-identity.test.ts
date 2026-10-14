import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionSearchStore as SessionSearchIndex } from "../src/session/searchIndexStore.js";

const message = (messageId: string, content: string): string =>
  `${JSON.stringify({ type: "user_message", messageId, content })}\n`;

test("same session names in different source directories retain independent offsets and search hits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-source-"));
  const first = path.join(root, "sessions", "first", "shared.jsonl");
  const second = path.join(root, "sessions", "second", "shared.jsonl");
  const firstBody = message("first-message", "source collision marker with a much longer first document");
  const secondBody = message("second-message", "source collision marker");
  const index = new SessionSearchIndex(root);
  try {
    await mkdir(path.dirname(first), { recursive: true });
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(first, firstBody);
    await writeFile(second, secondBody);
    await index.refreshAll();
    const hits = index.search("source collision marker");
    assert.deepEqual(hits.map(hit => hit.messageId).sort(), ["first-message", "second-message"]);
    assert.deepEqual(hits.map(hit => hit.sourcePath).sort(), [await realpath(first), await realpath(second)].sort());
    assert.ok(hits.every(hit => hit.sessionId === "shared"));
    assert.deepEqual(index.status(), { indexedSessions: 2, indexedMessages: 2 });
    assert.equal(await index.indexSessionFile("shared", first), 0);
    assert.equal(await index.indexSessionFile("shared", second), 0);
    await index.refreshAll();
    assert.deepEqual(index.status(), { indexedSessions: 2, indexedMessages: 2 });
    assert.equal(await readFile(first, "utf8"), firstBody);
    assert.equal(await readFile(second, "utf8"), secondBody);
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const replacement of ["rename", "rewrite"] as const) {
  test(`same-size source ${replacement} rebuilds only its own derived rows`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-replacement-"));
    const file = path.join(root, "shared.jsonl");
    const other = path.join(root, "other", "retained.jsonl");
    const index = new SessionSearchIndex(root);
    try {
      await mkdir(path.dirname(other));
      await writeFile(file, message("changed", "before replacement"));
      await writeFile(other, message("retained", "other marker"));
      await index.indexSessionFile("shared", file);
      await index.indexSessionFile("retained", other);
      const next = message("changed", "afterx replacement");
      assert.equal(Buffer.byteLength(next), Buffer.byteLength(message("changed", "before replacement")));
      if (replacement === "rename") {
        await writeFile(`${file}.new`, next);
        await rename(`${file}.new`, file);
      } else {
        await writeFile(file, next);
        await utimes(file, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
      }
      await index.indexSessionFile("shared", file);
      assert.equal(index.search("before").length, 0);
      assert.equal(index.search("afterx")[0]?.messageId, "changed");
      assert.equal(index.search("other")[0]?.messageId, "retained");
    } finally {
      index.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("canonical source aliases share one checkpoint and scoped cleanup works after the raw file disappears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-canonical-"));
  const directory = path.join(root, "source");
  const alias = path.join(root, "alias");
  const file = path.join(directory, "shared.jsonl");
  const aliasedFile = path.join(alias, "shared.jsonl");
  const index = new SessionSearchIndex(root);
  try {
    await mkdir(directory);
    await symlink(directory, alias);
    await writeFile(file, message("canonical", "canonical history marker"));
    assert.equal(await index.indexSessionFile("shared", file), 1);
    assert.equal(await index.indexSessionFile("shared", aliasedFile), 0);
    assert.deepEqual(index.status(), { indexedSessions: 1, indexedMessages: 1 });
    const sourcePath = index.grep("canonical")[0]?.sourcePath;
    assert.equal(sourcePath, await realpath(file));
    assert.ok(sourcePath);
    await rm(file);
    await index.forgetSession("shared", { sourcePath });
    assert.deepEqual(index.status(), { indexedSessions: 0, indexedMessages: 0 });
    assert.deepEqual(index.search("canonical"), []);
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a replacement symlink cannot redirect cleanup away from the captured source identity", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-search-cleanup-identity-")));
  const file = path.join(root, "deleted.jsonl");
  const retained = path.join(root, "retained.jsonl");
  const index = new SessionSearchIndex(root);
  try {
    await writeFile(file, message("deleted", "deleted marker"));
    await writeFile(retained, message("retained", "retained marker"));
    await index.indexSessionFile("shared", file);
    await index.indexSessionFile("shared", retained);
    await rm(file);
    await symlink(retained, file);
    await index.forgetSession("shared", { sourcePath: file });
    assert.deepEqual(index.search("deleted"), []);
    assert.equal(index.search("retained")[0]?.sourcePath, retained);
    assert.deepEqual(index.status(), { indexedSessions: 1, indexedMessages: 1 });
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a source alias retargeted after canonical binding cannot index another file under the captured identity", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-search-read-identity-")));
  const first = path.join(root, "first.jsonl");
  const second = path.join(root, "second.jsonl");
  const alias = path.join(root, "alias.jsonl");
  const index = new SessionSearchIndex(root);
  try {
    await writeFile(first, message("first", "first source marker"));
    await writeFile(second, message("second", "second source marker"));
    await symlink(first, alias);
    const originalRealpath = fs.realpath;
    let changed = false;
    t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
      const resolved = await Reflect.apply(originalRealpath, fs, args);
      if (String(args[0]) === alias && !changed) {
        changed = true;
        await rm(alias);
        await symlink(second, alias);
      }
      return resolved;
    });
    syncBuiltinESMExports();
    await index.indexSessionFile("shared", alias);
    assert.ok(changed);
    assert.equal(index.search("first")[0]?.sourcePath, first);
    assert.deepEqual(index.search("second"), []);
    assert.equal(await readFile(first, "utf8"), message("first", "first source marker"));
    assert.equal(await readFile(second, "utf8"), message("second", "second source marker"));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
