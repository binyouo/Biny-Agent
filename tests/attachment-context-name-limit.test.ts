import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentFilePath, attachmentRoot, readAttachment, readAttachmentContext, saveAttachment, saveAttachmentContext } from "../src/attachments/store.js";
import { splitAttachmentReferences, withAttachmentReferences } from "../src/attachments/references.js";
import { loadRunAttachments } from "../src/cli/commands/run.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-attachment-context-limit-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => {
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  return { root, workspace };
}

async function hasUtf8NameLimit(t: TestContext, directory: string): Promise<boolean> {
  const longest = path.join(directory, "中".repeat(85));
  await fs.writeFile(longest, "boundary");
  try {
    await fs.writeFile(`${longest}a`, "over boundary");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENAMETOOLONG") return true;
    throw error;
  }
  t.skip("This filesystem does not enforce the 255-byte UTF-8 filename boundary.");
  return false;
}

test("Desktop and CLI attachments remain readable when only the optional context name exceeds NAME_MAX", async (t) => {
  const f = await fixture(t);
  if (!await hasUtf8NameLimit(t, f.workspace)) return;
  const storage = new DesktopUserDataStore(path.join(f.root, "desktop"));
  await storage.initialize();
  const state = new DesktopStateStore(path.join(f.root, "state.json"));
  await state.load();
  const projects = new DesktopProjectService(state, storage, createFileConfigStore(f.workspace, { globalDir: process.env.BINY_AGENT_DIR! }));
  const project = await projects.createProject(f.workspace);
  const names = ["中".repeat(74) + "a.png", "中".repeat(75) + ".png", "中".repeat(76) + ".png", "中".repeat(76) + "ab.png"];
  for (const name of names) {
    const source = path.join(f.workspace, name);
    await fs.writeFile(source, png);
    const desktop = await projects.saveAttachment(project, name, "image/png", await fs.readFile(source));
    const [cli] = await loadRunAttachments(f.workspace, f.workspace, [], [name]);
    assert.ok(cli);
    for (const reference of [desktop, cli]) {
      const stored = attachmentFilePath(attachmentRoot(f.workspace), reference.path!);
      assert.ok(stored);
      assert.ok(Buffer.byteLength(path.basename(stored)) <= 255);
      assert.ok(Buffer.byteLength(`${path.basename(stored)}.context`) > 255);
      await assert.rejects(fs.open(`${stored}.context`, constants.O_RDONLY | constants.O_NOFOLLOW), { code: "ENAMETOOLONG" });
      assert.deepEqual(await fs.readFile(projects.workspaceFile(project, reference.path!)), png);
      assert.equal(await projects.readInlineImage(project, reference.path!), `data:image/png;base64,${png.toString("base64")}`);
      const parsed = splitAttachmentReferences(withAttachmentReferences("synthetic attachment", [reference])).attachments[0];
      assert.ok(parsed);
      assert.equal(reference.name, name);
      assert.equal(parsed.name, name);
      assert.equal(parsed.path, reference.path);
      const restored = await readAttachment(f.workspace, parsed);
      assert.equal(restored?.data, png.toString("base64"));
      assert.equal(restored?.hiddenContext, undefined);
      assert.equal(await readAttachmentContext(attachmentRoot(f.workspace), parsed.path), undefined);
    }
    assert.deepEqual(await fs.readFile(source), png);
  }
});

test("normal context and a context filename exactly at the UTF-8 boundary remain readable", async (t) => {
  const f = await fixture(t);
  for (const name of ["short.png", "中".repeat(74) + ".png"]) {
    const reference = await saveAttachment(f.workspace, name, "image/png", png);
    const context = `synthetic context for ${name}`;
    assert.equal((await readAttachment(f.workspace, reference))?.hiddenContext, undefined);
    await saveAttachmentContext(attachmentRoot(f.workspace), reference.path, context);
    assert.equal((await readAttachment(f.workspace, reference))?.hiddenContext, context);
    assert.equal((await readAttachment(f.workspace, reference))?.data, png.toString("base64"));
    assert.equal(await readAttachmentContext(attachmentRoot(f.workspace), reference.path), context);
    if (name !== "short.png") assert.equal(Buffer.byteLength(path.basename(reference.path) + ".context"), 255);
  }
});

test("context size, regular-file, and no-follow checks remain enforced", async (t) => {
  const f = await fixture(t);
  const reference = await saveAttachment(f.workspace, "short.png", "image/png", png);
  const root = attachmentRoot(f.workspace);
  const file = `${attachmentFilePath(root, reference.path)!}.context`;
  await fs.writeFile(file, "x".repeat(128_000));
  assert.equal((await readAttachmentContext(root, reference.path))?.length, 128_000);
  await fs.writeFile(file, "x".repeat(128_001));
  await assert.rejects(readAttachmentContext(root, reference.path), /attachment_context_invalid/u);
  await fs.unlink(file);
  await fs.mkdir(file);
  await assert.rejects(readAttachmentContext(root, reference.path), /attachment_path_invalid/u);
  await fs.rmdir(file);
  const target = path.join(f.root, "synthetic-context");
  await fs.writeFile(target, "target");
  await fs.symlink(target, file);
  await assert.rejects(readAttachmentContext(root, reference.path), /attachment_path_invalid/u);
});

for (const code of ["EACCES", "EIO", "ELOOP"]) {
  test(`context open ${code} still propagates`, async (t) => {
    const f = await fixture(t);
    const reference = await saveAttachment(f.workspace, "short.png", "image/png", png);
    await saveAttachmentContext(attachmentRoot(f.workspace), reference.path, "context");
    const failure = Object.assign(new Error("injected context open failure"), { code });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      assert.equal(args[1], constants.O_RDONLY | constants.O_NOFOLLOW);
      throw failure;
    });
    await assert.rejects(readAttachmentContext(attachmentRoot(f.workspace), reference.path), error => error === failure);
  });
}

for (const stage of ["stat", "readFile", "close"] as const) {
  for (const code of ["ENAMETOOLONG", "EACCES", "EIO", "ELOOP"]) {
    test(`context ${stage} ${code} still propagates and closes the handle`, async (t) => {
      const f = await fixture(t);
      const reference = await saveAttachment(f.workspace, "short.png", "image/png", png);
      await saveAttachmentContext(attachmentRoot(f.workspace), reference.path, "context");
      const failure = Object.assign(new Error(`injected context ${stage} failure`), { code });
      let closed = 0;
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        assert.equal(args[1], constants.O_RDONLY | constants.O_NOFOLLOW);
        const handle = await open(...args);
        const stat = handle.stat.bind(handle);
        const readFile = handle.readFile.bind(handle);
        const close = handle.close.bind(handle);
        handle.stat = async (...options: Parameters<typeof handle.stat>) => {
          if (stage === "stat") throw failure;
          return await stat(...options);
        };
        handle.readFile = async (...options: Parameters<typeof handle.readFile>) => {
          if (stage === "readFile") throw failure;
          return await readFile(...options);
        };
        handle.close = async () => { closed += 1; await close(); if (stage === "close") throw failure; };
        return handle;
      });
      await assert.rejects(readAttachmentContext(attachmentRoot(f.workspace), reference.path), error => error === failure);
      assert.equal(closed, 1);
    });
  }
}

test("an overlong base attachment filename still throws ENAMETOOLONG", async (t) => {
  const f = await fixture(t);
  if (!await hasUtf8NameLimit(t, f.workspace)) return;
  await saveAttachment(f.workspace, "short.png", "image/png", png);
  const name = "中".repeat(84) + ".png";
  assert.equal(Buffer.byteLength(name), 256);
  await assert.rejects(readAttachment(f.workspace, { name, path: `@attachments/${name}`, mimeType: "image/png" }), { code: "ENAMETOOLONG" });
});
