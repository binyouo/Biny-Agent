import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentFilePath, attachmentRoot, createAttachmentImportBatch, readAttachment, readAttachmentBytes, sanitizeAttachmentName, saveAttachment, saveAttachmentContext, type AttachmentReference } from "../src/attachments/store.js";
import { loadRunAttachments } from "../src/cli/commands/run.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const timestamp = 1_800_000_000_000;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-attachment-write-limit-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.mock.method(Date, "now", () => timestamp);
  return { root, workspace };
}

async function verify(workspace: string, reference: AttachmentReference, name: string, extension = path.extname(name)) {
  assert.equal(reference.name, sanitizeAttachmentName(name));
  assert.equal(reference.size, png.length);
  const leaf = path.basename(reference.path);
  assert.ok(Buffer.byteLength(leaf + ".context") <= 255, "the complete sidecar basename must fit NAME_MAX");
  assert.equal(path.extname(leaf), extension);
  assert.doesNotMatch(leaf, /\uFFFD|\.\./u);
  assert.deepEqual(await readAttachmentBytes(workspace, reference.path), png);
  const file = attachmentFilePath(attachmentRoot(workspace), reference.path);
  assert.ok(file);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600 & ~process.umask());
  await saveAttachmentContext(attachmentRoot(workspace), reference.path, "synthetic context");
  const restored = await readAttachment(workspace, reference);
  assert.equal(restored?.name, reference.name);
  assert.equal(restored?.data, png.toString("base64"));
  assert.equal(restored?.hiddenContext, "synthetic context");
}

for (const imported of [false, true]) {
  for (const [label, name] of [
    ["exact sidecar boundary", "中".repeat(74) + ".png"],
    ["sidecar-only overflow", "中".repeat(74) + "a.png"],
    ["valid source exceeding storage boundary", "中".repeat(77) + ".png"],
    ["long display name", "中".repeat(170) + ".png"],
    ["extensionless name", "中".repeat(170)],
    ["dot at truncation boundary", "中".repeat(73) + "a." + "中".repeat(10) + ".png"],
    ["unchanged short name", "report.png"]
  ]) {
    test(`${imported ? "import batch" : "ordinary save"} fits ${label} without changing display metadata`, async (t) => {
      const f = await fixture(t);
      assert.ok(name);
      const batch = imported ? await createAttachmentImportBatch(f.workspace) : undefined;
      const reference = batch ? await batch.save(name, "image/png", png) : await saveAttachment(f.workspace, name, "image/png", png);
      batch?.commit();
      await verify(f.workspace, reference, name);
      if (label === "exact sidecar boundary") assert.equal(Buffer.byteLength(path.basename(reference.path) + ".context"), 255);
      if (label === "unchanged short name") assert.match(reference.path, new RegExp(`${timestamp}-[a-f0-9]{6}-report\\.png$`, "u"));
    });
  }

  test(`${imported ? "import batch" : "ordinary save"} bounds an oversized extension without splitting Unicode characters`, async (t) => {
    const f = await fixture(t);
    const name = "x." + "中".repeat(170);
    const batch = imported ? await createAttachmentImportBatch(f.workspace) : undefined;
    const reference = batch ? await batch.save(name, "image/png", png) : await saveAttachment(f.workspace, name, "image/png", png);
    batch?.commit();
    await verify(f.workspace, reference, name, "." + "中".repeat(74));
  });

  test(`${imported ? "import batch" : "ordinary save"} budgets the actual prefix and retries collisions without overwriting`, async (t) => {
    const f = await fixture(t);
    const batch = imported ? await createAttachmentImportBatch(f.workspace) : undefined;
    t.mock.method(Date, "now", () => 1_800_000_000_000_000);
    const hexes = ["000001", "000001", "000002"];
    let calls = 0;
    t.mock.method(crypto, "randomBytes", (size: number) => {
      assert.equal(size, 3);
      const hex = hexes[calls++];
      assert.ok(hex, "unexpected extra retry");
      return Buffer.from(hex, "hex");
    });
    syncBuiltinESMExports();
    const name = "中".repeat(77) + ".png";
    const save = () => batch ? batch.save(name, "image/png", png) : saveAttachment(f.workspace, name, "image/png", png);
    const first = await save();
    const second = await save();
    assert.equal(calls, 3);
    assert.notEqual(first.path, second.path);
    assert.match(first.path, /1800000000000000-000001-/u);
    assert.match(second.path, /1800000000000000-000002-/u);
    for (const reference of [first, second]) {
      assert.equal(reference.name, name);
      assert.ok(Buffer.byteLength(path.basename(reference.path) + ".context") <= 255);
      assert.equal(path.extname(reference.path), ".png");
      assert.deepEqual(await readAttachmentBytes(f.workspace, reference.path), png);
    }
    if (batch) {
      assert.deepEqual(await batch.rollback(), []);
      assert.equal(await readAttachmentBytes(f.workspace, first.path), undefined);
      assert.equal(await readAttachmentBytes(f.workspace, second.path), undefined);
    } else {
      await verify(f.workspace, first, name);
      await verify(f.workspace, second, name);
    }
  });
}

for (const entry of ["Desktop", "CLI"] as const) {
  test(`${entry} accepts a real valid 235-byte source filename and preserves its image bytes`, async (t) => {
    const f = await fixture(t);
    const name = "中".repeat(77) + ".png";
    assert.equal(Buffer.byteLength(name), 235);
    const source = path.join(f.workspace, name);
    await fs.writeFile(source, png);
    let reference: AttachmentReference;
    if (entry === "Desktop") {
      const storage = new DesktopUserDataStore(path.join(f.root, "desktop"));
      await storage.initialize();
      const state = new DesktopStateStore(path.join(f.root, "state.json"));
      await state.load();
      const projects = new DesktopProjectService(state, storage, createFileConfigStore(f.workspace, { globalDir: process.env.BINY_AGENT_DIR! }));
      const project = await projects.createProject(f.workspace);
      reference = await projects.saveAttachment(project, name, "image/png", await fs.readFile(source), "desktop context");
      assert.equal((await readAttachment(f.workspace, reference))?.hiddenContext, "desktop context");
      assert.equal(await projects.readInlineImage(project, reference.path), `data:image/png;base64,${png.toString("base64")}`);
      assert.deepEqual(await fs.readFile(projects.workspaceFile(project, reference.path)), png);
      assert.ok(Buffer.byteLength(path.basename(reference.path) + ".context") <= 255);
    } else {
      const [loaded] = await loadRunAttachments(f.workspace, f.workspace, [], [name]);
      assert.ok(loaded?.path);
      reference = { ...loaded, path: loaded.path };
      assert.equal(loaded.data, png.toString("base64"));
      await verify(f.workspace, reference, name);
    }
    assert.equal(reference.name, name);
    assert.deepEqual(await readAttachmentBytes(f.workspace, reference.path), png);
    assert.deepEqual(await fs.readFile(source), png);
  });
}
