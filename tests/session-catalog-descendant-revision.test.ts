import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  querySessionCatalog,
  refreshSessionIndex,
  registerSessionBranch,
  sessionCatalogDirectory,
  updateSessionCatalogMetadata
} from "../src/session/catalog.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-catalog-descendant-revision-"));
  const root = await realpath(temporary);
  await ensureAgentDirs(root);
  const create = async (id: string, parentSessionId?: string) => {
    const file = await createSessionFile(root, id, Buffer.from(`${JSON.stringify({
      type: "user_message", content: id, time: "2026-01-01T00:00:00.000Z"
    })}\n`));
    if (parentSessionId !== undefined) {
      await registerSessionBranch(root, { sessionId: id, parentSessionId, branchPoint: { kind: "event", index: 1 } });
    }
    return file;
  };
  const remove = async (id: string, file: string) => {
    // Only synthetic fixture files are removed; production deletion behavior is unchanged.
    await unlink(file);
    await unlink(path.join(sessionCatalogDirectory(root), `${id}.json`));
  };
  await create("parent");
  await create("child-a", "parent");
  await create("child-z", "parent");
  return { root, create, remove, dispose: async () => {
    await refreshSessionIndex(root);
    await rm(temporary, { recursive: true, force: true });
  } };
}

const query = { parentSessionId: "parent", limit: 1 };

test("adding the first grandchild invalidates a scoped cursor and refreshes the first child", async () => {
  const view = await fixture();
  try {
    const before = await querySessionCatalog(view.root, query);
    const firstChild = before.items[0]!;
    assert.equal(firstChild.id, "child-z");
    assert.equal(firstChild.hasChildren, false);
    assert.ok(before.nextCursor);
    await view.create("grandchild", firstChild.id);

    const continuation = await querySessionCatalog(view.root, { ...query, cursor: before.nextCursor });
    assert.equal(continuation.revisionChanged, true, "a loaded child's changed expandability must reject the old cursor");
    assert.deepEqual(continuation.items, []);
    assert.equal(continuation.nextCursor, undefined);
    const fresh = await querySessionCatalog(view.root, query);
    assert.notEqual(fresh.revision, before.revision);
    assert.equal(fresh.items[0]?.hasChildren, true);
    assert.equal(fresh.items[0]?.metadataRevision, firstChild.metadataRevision, "descendant changes must not alter the child's metadata CAS");
    const next = await querySessionCatalog(view.root, { ...query, cursor: fresh.nextCursor });
    assert.equal(next.revisionChanged, false);
    assert.deepEqual(next.items.map((item) => item.id), ["child-a"]);
    assert.equal(next.nextCursor, undefined);
  } finally { await view.dispose(); }
});

test("removing the last grandchild invalidates a scoped cursor and removes expandability", async () => {
  const view = await fixture();
  try {
    const file = await view.create("grandchild", "child-z");
    const before = await querySessionCatalog(view.root, query);
    assert.equal(before.items[0]?.hasChildren, true);
    await view.remove("grandchild", file);
    const continuation = await querySessionCatalog(view.root, { ...query, cursor: before.nextCursor });
    assert.equal(continuation.revisionChanged, true);
    assert.deepEqual(continuation.items, []);
    const fresh = await querySessionCatalog(view.root, query);
    assert.notEqual(fresh.revision, before.revision);
    assert.equal(fresh.items[0]?.hasChildren, false);
    const next = await querySessionCatalog(view.root, { ...query, cursor: fresh.nextCursor });
    assert.equal(next.revisionChanged, false);
    assert.deepEqual(next.items.map((item) => item.id), ["child-a"]);
  } finally { await view.dispose(); }
});

test("unchanged child projections keep cursors across descendant and unrelated branch changes", async () => {
  const view = await fixture();
  try {
    await view.create("grandchild-one", "child-z");
    const before = await querySessionCatalog(view.root, query);
    const unchanged = async () => {
      const fresh = await querySessionCatalog(view.root, query);
      assert.equal(fresh.revision, before.revision);
      assert.deepEqual(fresh.items, before.items);
      const next = await querySessionCatalog(view.root, { ...query, cursor: before.nextCursor });
      assert.equal(next.revisionChanged, false);
      assert.deepEqual(next.items.map((item) => item.id), ["child-a"]);
    };
    await unchanged();
    await updateSessionCatalogMetadata(view.root, "grandchild-one", { title: "Renamed grandchild" });
    await unchanged();
    const second = await view.create("grandchild-two", "child-z");
    await unchanged();
    await view.remove("grandchild-two", second);
    await unchanged();
    await view.create("great-grandchild", "grandchild-one");
    await unchanged();
    await view.create("unrelated-parent");
    await view.create("unrelated-child", "unrelated-parent");
    await view.create("unrelated-grandchild", "unrelated-child");
    await unchanged();
  } finally { await view.dispose(); }
});
