import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = path.dirname(fileURLToPath(import.meta.url));

function fixture(context, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "biny-project-check-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [filename, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    writeFileSync(path.join(root, filename), content);
  }
  return root;
}

function check(script, root, ...args) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

const publicDocs = {
  "README.md": "# Project\n\n[Docs](docs/README.md)\n",
  "CONTRIBUTING.md": "# Contributing\n",
  "docs/README.md": "# Docs\n",
};
const localDocs = {
  ...publicDocs,
  "docs/specs/features/README.md": "# Contracts\n\n| 子系统 | 唯一契约入口 | 实现说明 |\n| --- | --- | --- |\n| 会话 | [会话](session.md) | [实现](../implementation/session.md) |\n",
  "docs/specs/features/session.md": "# Session\n\n## Failure handling\n\n[Implementation](../implementation/session.md)\n",
  "docs/specs/implementation/session.md": "# Implementation\n\n`src/session/store.ts`\n",
  "src/session/store.ts": "export const stored = true;\n",
};

test("public documentation checks do not require ignored specs; explicit local checks refuse absent specs", context => {
  const root = fixture(context, publicDocs);
  assert.equal(check("check-docs.mjs", root).status, 0);
  const result = check("check-docs.mjs", root, "--local");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /docs\/specs\/features\/README\.md/);
});

test("valid local contracts resolve reference links, anchors and source paths without inspecting examples", context => {
  const root = fixture(context, {
    ...localDocs,
    "docs/README.md": "# Docs\n\n[Failure][contract]\n\n[contract]: specs/features/session.md#failure-handling\n\n```md\n[example](not-a-file.md)\n`tests/not-a-test.ts`\n```\n",
  });
  const result = check("check-docs.mjs", root, "--local");
  assert.equal(result.status, 0, result.output);
});

for (const [name, content, expected] of [
  ["missing linked file", "[Missing](missing.md)", /missing\.md/],
  ["missing source path", "`src/session/removed.ts`", /removed\.ts/],
  ["missing anchor", "[Missing](../README.md#not-a-heading)", /not-a-heading/],
  ["broken reference link", "[Missing][target]\n\n[target]: missing-reference.md", /missing-reference\.md/],
]) {
  test(`documentation check rejects ${name}`, context => {
    const root = fixture(context, { ...publicDocs, "docs/README.md": `# Docs\n\n${content}\n` });
    const result = check("check-docs.mjs", root);
    assert.notEqual(result.status, 0);
    assert.match(result.output, expected);
  });
}

test("a subsystem cannot register two contract owners", context => {
  const root = fixture(context, {
    ...localDocs,
    "docs/specs/features/README.md": localDocs["docs/specs/features/README.md"] + "| 会话 | [其他](other.md) | [实现](../implementation/session.md) |\n",
    "docs/specs/features/other.md": "# Other\n",
  });
  const result = check("check-docs.mjs", root, "--local");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /duplicate subsystem.*会话/i);
});

for (const directory of ["features", "implementation"]) {
  test(`unregistered ${directory} pages cannot become hidden parallel authorities`, context => {
    const root = fixture(context, { ...localDocs, [`docs/specs/${directory}/orphan.md`]: "# Orphan\n" });
    const result = check("check-docs.mjs", root, "--local");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /unregistered.*orphan\.md/i);
  });
}

test("two subsystem names cannot silently share one contract owner", context => {
  const root = fixture(context, {
    ...localDocs,
    "docs/specs/features/README.md": localDocs["docs/specs/features/README.md"] + "| 运行时 | [同一入口](session.md) | [实现](../implementation/session.md) |\n",
  });
  const result = check("check-docs.mjs", root, "--local");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /duplicate contract owner.*session\.md/i);
});

test("each subsystem row has exactly one contract and cannot appoint implementation notes as its owner", context => {
  for (const [owner, expected] of [
    ["[会话](session.md) [另一个](session.md)", /exactly one contract owner/],
    ["[实现](../implementation/session.md)", /invalid contract owner/],
  ]) {
    const root = fixture(context, {
      ...localDocs,
      "docs/specs/features/README.md": localDocs["docs/specs/features/README.md"].replace("[会话](session.md)", owner),
    });
    const result = check("check-docs.mjs", root, "--local");
    assert.notEqual(result.status, 0);
    assert.match(result.output, expected);
  }
});

test("renderer projections may use pure shared modules and type-only platform declarations", context => {
  const root = fixture(context, {
    "src/desktop/renderer/view.ts": 'import type { Stats } from "node:fs"; import { project } from "../../shared/project.js"; export const view = (value: Stats) => project(value.size);',
    "src/shared/project.ts": "export const project = (value: number) => String(value);",
    "src/desktop/renderer/asset.ts": 'import source from "./pattern.js?raw"; export const asset = source;',
    "src/desktop/renderer/pattern.js": 'module.exports = "raw asset";',
    "src/session/store.ts": 'import { readFileSync } from "node:fs"; export const read = readFileSync;',
    "src/tui/components/view.ts": 'import path from "node:path"; export const name = path.basename("file");',
  });
  const result = check("check-boundaries.mjs", root);
  assert.equal(result.status, 0, result.output);
});

test("the boundary command refuses a workspace with no source entries instead of reporting success", context => {
  const root = fixture(context, {});
  const result = check("check-boundaries.mjs", root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /no boundary source entries/i);
});

for (const [name, source] of [
  ["Node filesystem", 'export { readFileSync } from "node:fs";'],
  ["unprefixed Node filesystem", 'export { readFile } from "fs/promises";'],
  ["Electron", 'export { ipcRenderer } from "electron";'],
  ["dynamic process execution", 'export const execute = () => import("node:child_process");'],
]) {
  test(`renderer boundary rejects transitive ${name} access through a shared facade`, context => {
    const root = fixture(context, {
      "src/desktop/renderer/view.ts": 'export * from "../../shared/facade.js";',
      "src/shared/facade.ts": source,
    });
    const result = check("check-boundaries.mjs", root);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /renderer.*platform/i);
    assert.match(result.output, /facade\.ts/);
  });
}

test("core runtime dependencies cannot return through a shared facade to a client", context => {
  const root = fixture(context, {
    "src/session/store.ts": 'export * from "../shared/facade.js";',
    "src/shared/facade.ts": 'export * from "../cli/command.js";',
    "src/cli/command.ts": "export const command = true;",
  });
  const result = check("check-boundaries.mjs", root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /core.*client/i);
});

test("TUI display components cannot reach persistence through a shared helper", context => {
  const root = fixture(context, {
    "src/tui/components/view.ts": 'export * from "../../shared/facade.js";',
    "src/shared/facade.ts": 'export * from "../session/store.js";',
    "src/session/store.ts": "export const write = true;",
  });
  const result = check("check-boundaries.mjs", root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /tui.*execution or persistence/i);
});
