import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "yaml";
import { getLoadablePath } from "sqlite-vec";

test("desktop packaging unpacks the platform SQLite vector extension", async () => {
  const config = parse(await readFile(new URL("../config/electron-builder.yml", import.meta.url), "utf8")) as { asarUnpack: string[] };
  const relative = `node_modules/${path.basename(path.dirname(getLoadablePath()))}/${path.basename(getLoadablePath())}`;
  assert.ok(config.asarUnpack.some(pattern => path.matchesGlob(relative, pattern)), `${relative} must be outside the archive`);
});

for (const packaged of [true, false]) test(`vector projection loads a real extension in ${packaged ? "packaged Electron" : "a CLI directory named app.asar"}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-vec-package-"));
  try {
    const resources = path.join(root, "Resources");
    const relative = path.join("node_modules", "sqlite-vec-fixture", path.basename(getLoadablePath()));
    const resolved = path.join(resources, "app.asar", relative);
    const physical = path.join(resources, packaged ? "app.asar.unpacked" : "app.asar", relative);
    await mkdir(path.dirname(physical), { recursive: true });
    await copyFile(getLoadablePath(), physical);
    if (packaged) await writeFile(path.join(resources, "app.asar"), "archive fixture");
    const entry = path.join(root, "check.mjs");
    await build({
      stdin: { contents: `
        import assert from 'node:assert/strict';
        import { DatabaseSync } from 'node:sqlite';
        import { mkdirSync } from 'node:fs';
        import { MemoryVectorIndex } from ${JSON.stringify(fileURLToPath(new URL("../src/agent/context/MemoryVectorIndex.ts", import.meta.url)))};
        ${packaged ? `Object.defineProperty(process.versions, 'electron', { value: 'fixture' });` : ""}
        Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resources)} });
        const data = ${JSON.stringify(path.join(root, "data"))};
        mkdirSync(data);
        const db = new DatabaseSync(data + '/agent.sqlite');
        db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO memories VALUES ('first', 1), ('second', 1)");
        db.close();
        const index = new MemoryVectorIndex(data);
        try {
          index.replaceAll('fixture', 2, [
            { entryId: 'first', revision: 1, embedding: [1, 0] },
            { entryId: 'second', revision: 1, embedding: [0, 1] }
          ]);
          assert.deepEqual(index.search(new Float32Array([1, 0]), { modelFingerprint: 'fixture', minimumSimilarity: 0.9 }), [{ entryId: 'first', similarity: 1 }]);
          assert.equal(index.status().active.vectorCount, 2);
        } finally { index.close(); }
      `, resolveDir: process.cwd() },
      outfile: entry, bundle: true, platform: "node", format: "esm", packages: "external",
      plugins: [{ name: "extension-location", setup(builder) {
        builder.onResolve({ filter: /^sqlite-vec$/ }, () => ({ path: "sqlite-vec", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export const getLoadablePath = () => ${JSON.stringify(resolved)}; export const load = db => db.loadExtension(getLoadablePath());` }));
      } }]
    });
    execFileSync(process.execPath, [entry], { timeout: 10_000, stdio: "pipe" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
