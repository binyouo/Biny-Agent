import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cachedBuild } from "./build-project.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "biny-build-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "node_modules/dependency"), { recursive: true });
  writeFileSync(path.join(root, "src/input"), "first");
  writeFileSync(path.join(root, "node_modules/dependency/index.js"), "dependency");
  const options = { root, target: "fixture", inputs: ["src"], outputs: ["dist"], toolchain: "fixture-v1", build: () => {
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      mkdirSync('dist', { recursive: true });
      writeFileSync('dist/output', readFileSync('src/input'));
    `], { cwd: root });
  } };
  return { root, options, run: overrides => cachedBuild({ ...options, ...overrides }) };
}

test("unchanged builds skip the compiler; changed inputs, dependencies, outputs and tools rebuild", async t => {
  const { root, run } = fixture(t);
  assert.equal(await run(), true);
  assert.equal(await run(), false);
  writeFileSync(path.join(root, "src/input"), "second");
  assert.equal(await run(), true);
  assert.equal(readFileSync(path.join(root, "dist/output"), "utf8"), "second");
  assert.equal(await run(), false);
  for (const file of ["src/extra", "node_modules/dependency/index.js", "dist/output"]) {
    writeFileSync(path.join(root, file), "changed");
    assert.equal(await run(), true, file);
    assert.equal(await run(), false);
  }
  rmSync(path.join(root, "src/extra"));
  assert.equal(await run(), true, "deleted inputs invalidate the cache");
  rmSync(path.join(root, "dist/output"));
  assert.equal(await run(), true, "deleted output inside an existing directory is rebuilt");
  assert.equal(await run({ toolchain: "fixture-v2" }), true);
  assert.equal(await run({ toolchain: "fixture-v2" }), false);
  assert.equal(await run({ toolchain: "fixture-v2", force: true }), true);
});

test("failed and concurrently edited builds cannot reuse an old successful stamp", async t => {
  const { root, run, options } = fixture(t);
  await run();
  await assert.rejects(run({ force: true, build: () => { throw new Error("compiler failed"); } }), /compiler failed/);
  assert.equal(await run(), true);
  await run({ force: true, build: () => {
    options.build();
    writeFileSync(path.join(root, "src/input"), "edited during compilation");
  } });
  assert.equal(await run(), true);
  assert.equal(readFileSync(path.join(root, "dist/output"), "utf8"), "edited during compilation");
});

test("missing declared outputs fail instead of caching an incomplete build", async t => {
  const { run } = fixture(t);
  await assert.rejects(run({ build: () => {} }), /omitted an output/);
  assert.equal(await run(), true);
});
