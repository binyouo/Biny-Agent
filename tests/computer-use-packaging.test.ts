import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolveCuaWorkerEntry } from "../src/computer/workerEntry.js";

test("packaged native worker resolves from the physical ASAR-unpacked tree", async () => {
  const packed = new URL("file:///Applications/Biny%20Cua%20QA.app/Contents/Resources/app.asar/out/main/cuaWorker.js");
  assert.equal(resolveCuaWorkerEntry(packed).href, "file:///Applications/Biny%20Cua%20QA.app/Contents/Resources/app.asar.unpacked/out/main/cuaWorker.js");
  const development = new URL("file:///tmp/biny/out/main/cuaWorker.js");
  assert.equal(resolveCuaWorkerEntry(development).href, development.href);
  const alreadyUnpacked = new URL("file:///tmp/app.asar.unpacked/out/main/cuaWorker.js");
  assert.equal(resolveCuaWorkerEntry(alreadyUnpacked).href, alreadyUnpacked.href);
  const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(config, /asarUnpack:[\s\S]*out\/main\/cuaWorker\.js/);
  assert.match(config, /out\/main\/chunks\/\*\*\/\*/);
  assert.match(config, /node_modules\/zod\/\*\*\/\*/);
  assert.match(config, /node-runtime-NOTICE\.md/);
  assert.match(config, /- '\*\.txt'/);
  assert.match(config, /from: THIRD_PARTY_NOTICES\.txt[\s\S]*to: THIRD_PARTY_NOTICES\.txt/);
  assert.match(await readFile(new URL("../native/cua-driver/MPL-2.0.txt", import.meta.url), "utf8"), /^Mozilla Public License Version 2\.0/m);
});

test("desktop SDK is required so failed installation cannot silently omit the worker dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["@trycua/cua-driver"], "0.30.4");
  assert.equal(manifest.optionalDependencies["@trycua/cua-driver"], undefined);
});
