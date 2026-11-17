/** Saving a full conversation must not destroy the old export or expose partial bytes. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import type { ExportedSessionFile } from "../src/session/transfer.js";

const save = async (target: string, content = "PRIVATE CONVERSATION\n") => DesktopProjectService.prototype.writeSessionExport.call(
  {} as DesktopProjectService, target, { content } as ExportedSessionFile
);

for (const existing of [false, true]) {
  test(`export stays private before publication: existing=${existing}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-private-"));
    const target = path.join(root, "conversation.json");
    try {
      if (existing) await fs.writeFile(target, "OLD EXPORT", { mode: 0o644 });
      const write = fs.writeFile.bind(fs);
      t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
        await write(...args);
        const writtenPath = args[0];
        const stat = typeof writtenPath === "string" ? await fs.stat(writtenPath) : await (writtenPath as import("node:fs/promises").FileHandle).stat();
        assert.equal(stat.mode & 0o077, 0, "conversation bytes must never be written into a public file");
      });
      await save(target);
      assert.equal(await fs.readFile(target, "utf8"), "PRIVATE CONVERSATION\n");
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
      assert.deepEqual(await fs.readdir(root), ["conversation.json"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const code of ["ENOSPC", "EIO"]) {
  test(`partial export write ${code} preserves existing bytes and mode`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-partial-"));
    const target = path.join(root, "conversation.json");
    try {
      await fs.writeFile(target, "OLD EXPORT", { mode: 0o640 });
      const write = fs.writeFile.bind(fs);
      t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
        // Real truncation and partial disk write, with only the OS failure controlled.
        await write(args[0], "PRIVATE", args[2]);
        throw Object.assign(new Error(code), { code });
      });
      await assert.rejects(save(target), { code });
      assert.equal(await fs.readFile(target, "utf8"), "OLD EXPORT");
      assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
      assert.deepEqual(await fs.readdir(root), ["conversation.json"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const existing of [false, true]) {
  test(`publication failure leaves original target untouched: existing=${existing}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-publish-"));
    const target = path.join(root, "conversation.json");
    try {
      if (existing) await fs.writeFile(target, "OLD EXPORT", { mode: 0o640 });
      t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
      await assert.rejects(save(target), { code: "EACCES" });
      if (existing) {
        assert.equal(await fs.readFile(target, "utf8"), "OLD EXPORT");
        assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
      } else await assert.rejects(fs.stat(target), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(root), existing ? ["conversation.json"] : []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const kind of ["symlink", "hardlink"] as const) {
  test(`export replaces selected ${kind} entry without modifying another path`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-link-"));
    const target = path.join(root, "conversation.json");
    const original = path.join(root, "other.json");
    try {
      await fs.writeFile(original, "OTHER FILE", { mode: 0o644 });
      if (kind === "symlink") await fs.symlink(original, target);
      else await fs.link(original, target);
      await save(target);
      assert.equal(await fs.readFile(original, "utf8"), "OTHER FILE");
      assert.equal((await fs.stat(original)).mode & 0o777, 0o644);
      assert.equal(await fs.readFile(target, "utf8"), "PRIVATE CONVERSATION\n");
      assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("concurrent saves publish only complete files and remove all staging files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-concurrent-"));
  const target = path.join(root, "conversation.json");
  try {
    await fs.writeFile(target, "OLD EXPORT");
    const rename = fs.rename.bind(fs);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      assert.equal(await fs.readFile(target, "utf8"), "OLD EXPORT");
      assert.ok(["FIRST EXPORT\n", "SECOND EXPORT\n"].includes(await fs.readFile(args[0], "utf8")));
      if (++arrivals === 2) release();
      await barrier;
      await rename(...args);
    });
    await Promise.all([save(target, "FIRST EXPORT\n"), save(target, "SECOND EXPORT\n")]);
    assert.ok(["FIRST EXPORT\n", "SECOND EXPORT\n"].includes(await fs.readFile(target, "utf8")));
    assert.deepEqual(await fs.readdir(root), ["conversation.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("failed exclusive staging open does not delete somebody else's file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-collision-"));
  const target = path.join(root, "conversation.json");
  try {
    const open = fs.open.bind(fs);
    let collision: string | undefined;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      collision = String(args[0]);
      const file = await open(...args);
      await file.writeFile("OTHER FILE");
      await file.close();
      return await open(...args);
    });
    await assert.rejects(save(target), { code: "EEXIST" });
    assert.ok(collision);
    assert.equal(await fs.readFile(collision, "utf8"), "OTHER FILE");
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const failure of ["chmod", "sync", "close"] as const) {
  test(`staging ${failure} failure preserves old export`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-staging-"));
    const target = path.join(root, "conversation.json");
    try {
      await fs.writeFile(target, "OLD EXPORT", { mode: 0o640 });
      const open = fs.open.bind(fs);
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args);
        const close = file.close.bind(file);
        t.mock.method(file, failure, async () => {
          if (failure === "close") await close();
          throw Object.assign(new Error(failure), { code: "EIO" });
        });
        return file;
      });
      await assert.rejects(save(target), { code: "EIO" });
      assert.equal(await fs.readFile(target, "utf8"), "OLD EXPORT");
      assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
      assert.deepEqual(await fs.readdir(root), ["conversation.json"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("restrictive umask does not remove owner access from the finished export", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-umask-"));
  const target = path.join(root, "conversation.json");
  const previous = process.umask(0o777);
  try {
    await save(target);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(target, "utf8"), "PRIVATE CONVERSATION\n");
  } finally {
    process.umask(previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const cleanupFails of [false, true]) {
  test(`first export partial failure is never published: cleanupFails=${cleanupFails}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-initial-"));
    const target = path.join(root, "conversation.json");
    try {
      const write = fs.writeFile.bind(fs);
      t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
        await write(args[0], "PRIVATE", args[2]);
        throw Object.assign(new Error("write failed"), { code: "ENOSPC" });
      });
      if (cleanupFails) t.mock.method(fs, "unlink", async () => { throw Object.assign(new Error("cleanup failed"), { code: "EACCES" }); });
      await assert.rejects(save(target), { code: "ENOSPC" });
      await assert.rejects(fs.stat(target), { code: "ENOENT" });
      const remaining = await fs.readdir(root);
      assert.equal(remaining.length, cleanupFails ? 1 : 0);
      if (cleanupFails) {
        assert.match(remaining[0]!, /^\.biny-export-.*\.tmp$/);
        assert.equal((await fs.stat(path.join(root, remaining[0]!))).mode & 0o777, 0o600);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
