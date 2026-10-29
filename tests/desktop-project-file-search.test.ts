import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchDesktopWorkspaceFiles } from "../src/desktop/projectFiles.js";
import { resolveWorkspacePath } from "../src/workspace/resolvePath.js";
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

test("workspace file search limits the ranked result set with producer-normalized Windows paths", () => {
  const files = [
    { name: "config.ts", path: "src/config.ts" },
    { name: "config.test.ts", path: "tests/config.test.ts" },
    { name: "config.json", path: "config.json" }
  ];

  assert.deepEqual(matchDesktopWorkspaceFiles(files, "config", 2).map(file => file.path), ["config.json", "src/config.ts"]);
});


test("workspace search preserves literal backslashes and distinct POSIX file identities", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-file-identity-"));
  try {
    await mkdir(path.join(root, "report"));
    await writeFile(path.join(root, "report\\draft.md"), "literal backslash");
    await writeFile(path.join(root, "report", "draft.md"), "nested file");
    const index = await readDesktopWorkspaceFileIndex(root, []);
    const results = matchDesktopWorkspaceFiles(index.files, "draft");
    assert.equal(results.length, 2);
    assert.equal(new Set(results.map(file => file.path)).size, 2, "search row IDs must stay distinct");
    const literal = results.find(file => file.name === "report\\draft.md")!;
    assert.equal(literal.path, "report\\draft.md");
    assert.equal(await readFile(resolveWorkspacePath(root, literal.path, []), "utf8"), "literal backslash");
    assert.deepEqual(matchDesktopWorkspaceFiles(index.files, "report\\draft"), [literal]);
    assert.deepEqual(matchDesktopWorkspaceFiles(index.files, "report/draft").map(file => file.path), ["report/draft.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
