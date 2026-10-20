import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchDesktopWorkspaceFiles } from "../src/desktop/projectFiles.js";
import { readDesktopWorkspaceFileIndex } from "../src/desktop/workspaceFileIndex.js";

test("workspace file index honors project ignore rules and returns normalized paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-files-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "src", "Readme.md"), "readme");
    await writeFile(path.join(root, "node_modules", "pkg", "Readme.md"), "ignored");

    const index = await readDesktopWorkspaceFileIndex(root, ["node_modules"]);

    assert.deepEqual(index.files, [{ name: "Readme.md", path: "src/Readme.md" }]);
    assert.equal(index.incomplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file search ranks exact names, prefixes, names, then paths", () => {
  const files = [
    { name: "readme-backup.md", path: "docs/readme-backup.md" },
    { name: "readme.md", path: "nested/readme.md" },
    { name: "guide.md", path: "docs/readme/guide.md" },
    { name: "reader.md", path: "reader.md" },
    { name: "readme.md", path: "readme.md" }
  ];

  assert.deepEqual(matchDesktopWorkspaceFiles(files, "README", 4).map(file => file.path), [
    "readme.md",
    "nested/readme.md",
    "docs/readme-backup.md",
    "docs/readme/guide.md"
  ]);
  assert.deepEqual(matchDesktopWorkspaceFiles(files, "docs guide").map(file => file.path), ["docs/readme/guide.md"]);
});

test("workspace file search limits the ranked result set and treats Windows separators as paths", () => {
  const files = [
    { name: "config.ts", path: "src\\config.ts" },
    { name: "config.test.ts", path: "tests\\config.test.ts" },
    { name: "config.json", path: "config.json" }
  ];

  assert.deepEqual(matchDesktopWorkspaceFiles(files, "config", 2).map(file => file.path), ["config.json", "src/config.ts"]);
});
