import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { collectProjectContext } from "../src/project/ProjectContext.js";

for (const fileName of ["package.json", "tsconfig.json"] as const) {
  await test(`${fileName} null does not block ordinary workspace preparation`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-null-"));
    try {
      await writeFile(path.join(root, fileName), "null");
      await writeFile(path.join(root, "README.md"), "project description");
      await writeFile(path.join(root, "unit.ts"), "export const sample = 1;\n");
      const context = new WorkspaceContext(root, [], 1024, path.join(root, "absent-global.md"));
      const first = await context.prepareTurn("unit.ts");
      assert.equal(first.snapshot.context[fileName === "package.json" ? "packageJson" : "tsconfig"], undefined);
      assert.equal(first.snapshot.context.readme, "project description");
      assert.ok(first.repoMapCandidates.find((entry) => entry.path === "unit.ts")?.symbols.includes("sample"));

      await writeFile(path.join(root, fileName), fileName === "package.json"
        ? '{"name":"repaired-project"}'
        : '{"compilerOptions":{"strict":true}}');
      context.invalidateSnapshot();
      const next = await context.prepareTurn("unit.ts");
      if (fileName === "package.json") assert.equal(next.snapshot.context.packageJson?.name, "repaired-project");
      else assert.equal(next.snapshot.context.tsconfig?.compilerOptions.strict, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

await test("representative scalar and array summaries degrade as missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-nonrecord-"));
  try {
    for (const value of [false, 42, "text", []]) {
      await writeFile(path.join(root, "package.json"), JSON.stringify(value));
      await writeFile(path.join(root, "tsconfig.json"), JSON.stringify(value));
      const context = await collectProjectContext(root, []);
      assert.equal(context.packageJson, undefined, `package.json ${JSON.stringify(value)}`);
      assert.equal(context.tsconfig, undefined, `tsconfig.json ${JSON.stringify(value)}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test("valid object summaries retain field selection and JSONC support", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-object-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "project", version: "1.2.3", type: "module",
      scripts: { test: "test", build: "build" }, dependencies: { zed: "1", alpha: "2" }, devDependencies: { typescript: "3" }, ignored: true
    }));
    await writeFile(path.join(root, "tsconfig.json"), '{/* comment */"compilerOptions":{"strict":true},"include":["src"],"exclude":["tmp"],}');
    const context = await collectProjectContext(root, []);
    assert.deepEqual(context.packageJson, {
      name: "project", version: "1.2.3", type: "module", scripts: ["build", "test"], dependencies: ["alpha", "zed"], devDependencies: ["typescript"]
    });
    assert.deepEqual(context.tsconfig, { compilerOptions: { strict: true }, include: ["src"], exclude: ["tmp"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
