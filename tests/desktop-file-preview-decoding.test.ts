/** Real file previews retain complete UTF-8 characters at the 512 KiB byte limit. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopProject } from "../src/desktop/protocol.js";

const limit = 512 * 1024;
let root: string;
let workspace: string;
let projects: DesktopProjectService;
let project: DesktopProject;

before(async () => {
  root = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "biny-file-preview-decoding-")));
  workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  projects = new DesktopProjectService(state, storage, createFileConfigStore(root, { globalDir: root }));
  project = await projects.createProject(workspace);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function assertPreview(name: string, bytes: Buffer, expected: string | undefined, truncated: boolean): Promise<void> {
  await writeFile(path.join(workspace, name), bytes);
  const preview = await projects.readWorkspaceFile(project, name);
  assert.equal(preview.path, name);
  assert.equal(preview.bytes, bytes.length, "metadata retains the full file byte count");
  assert.equal(preview.truncated, truncated);
  assert.equal(preview.binary, expected === undefined);
  // Check length before the whole string to keep a failed boundary assertion readable.
  assert.equal(preview.content?.length, expected?.length, "preview must not append a replacement character for a split character");
  assert.equal(preview.content, expected);
  assert.deepEqual(await readFile(path.join(workspace, name)), bytes, "preview is read-only");
}

for (const character of ["é", "中", "😀"]) {
  const width = Buffer.byteLength(character);
  for (let retained = 1; retained < width; retained++) {
    test(`omits an incomplete ${width}-byte character with ${retained} bytes before the cap`, async () => {
      const complete = "前é😀";
      const prefix = "a".repeat(limit - retained - Buffer.byteLength(complete)) + complete;
      await assertPreview(`split-${width}-${retained}.md`, Buffer.from(`${prefix}${character}after`), prefix, true);
    });
    test(`retains malformed EOF replacement for a complete file ending in ${retained}/${width} UTF-8 bytes`, async () => {
      const bytes = Buffer.concat([Buffer.alloc(limit - retained, "a"), Buffer.from(character).subarray(0, retained)]);
      await assertPreview(`eof-${width}-${retained}.txt`, bytes, `${"a".repeat(limit - retained)}�`, false);
    });
  }
  test(`retains a complete ${width}-byte character ending exactly at the cap`, async () => {
    const prefix = `${"a".repeat(limit - width)}${character}`;
    await assertPreview(`complete-${width}.txt`, Buffer.from(`${prefix}after`), prefix, true);
  });
}

test("retains a UTF-8 BOM and malformed interior bytes in a truncated preview", async () => {
  const start = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xe2, 0x28, 0xa1]);
  const prefix = Buffer.concat([start, Buffer.alloc(limit - start.length - 1, "a")]);
  await assertPreview("bom-and-malformed.md", Buffer.concat([prefix, Buffer.from("中文")]), prefix.toString("utf8"), true);
});

for (const invalid of [[0xc0], [0xf5], [0xe0, 0x80], [0xed, 0xa0], [0xf0, 0x80], [0xf4, 0x90]]) {
  test(`retains known malformed bytes at the cap: ${Buffer.from(invalid).toString("hex")}`, async () => {
    const prefix = Buffer.concat([Buffer.alloc(limit - invalid.length, "a"), Buffer.from(invalid)]);
    await assertPreview(`invalid-${Buffer.from(invalid).toString("hex")}.txt`, Buffer.concat([prefix, Buffer.from("after")]), prefix.toString("utf8"), true);
  });
}

test("retains a literal replacement character at the cap", async () => {
  const prefix = `${"a".repeat(limit - Buffer.byteLength("�"))}�`;
  await assertPreview("literal-replacement.txt", Buffer.from(`${prefix}after`), prefix, true);
});

test("preserves empty, full Unicode, BOM, ASCII limit, and binary preview behavior", async () => {
  await assertPreview("empty.txt", Buffer.alloc(0), "", false);
  const unicode = "\uFEFFé中文😀\n";
  await assertPreview("full.txt", Buffer.from(unicode), unicode, false);
  await assertPreview("ascii-limit.txt", Buffer.alloc(limit, "a"), "a".repeat(limit), false);
  await assertPreview("ascii-truncated.txt", Buffer.alloc(limit + 1, "a"), "a".repeat(limit), true);
  await assertPreview("binary.bin", Buffer.from([0, 1, 2]), undefined, false);
  await assertPreview("binary-truncated.bin", Buffer.concat([Buffer.from([0]), Buffer.alloc(limit, "a")]), undefined, true);
});

test("preserves a real malformed EOF below the cap when the file shrinks after stat", async (context) => {
  const name = "shrinking.txt";
  const filePath = path.join(workspace, name);
  const original = Buffer.from("a€b");
  const shrunk = Buffer.from([0x61, 0xe2]);
  await writeFile(filePath, original);
  const open = fs.open;
  context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === filePath) await writeFile(filePath, shrunk);
    return await open(...args);
  });
  const preview = await projects.readWorkspaceFile(project, name);
  assert.deepEqual(preview, { path: name, content: "a�", bytes: original.length, binary: false, truncated: true });
  assert.deepEqual(await readFile(filePath), shrunk);
});
