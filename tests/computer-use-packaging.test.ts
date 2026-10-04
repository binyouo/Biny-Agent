import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 原生 daemon 的打包契约：二进制必须随安装包发布，且不再依赖第三方 SDK。
test("native computer-use daemon ships as an unpacked resource", async () => {
  const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  // daemon 必须以 .app 发布：屏幕录制权限按 bundle 身份授予，裸二进制拿不到画面。
  assert.match(config, /from: out\/native\/computer-use\.app/);
  assert.match(config, /to: native\/computer-use\.app/);
  assert.doesNotMatch(config, /cuaProcess/);
  assert.doesNotMatch(config, /@trycua/);
  assert.doesNotMatch(config, /@ubjs/);
  assert.match(config, /from: THIRD_PARTY_NOTICES\.txt[\s\S]*to: THIRD_PARTY_NOTICES\.txt/);
});

test("third-party cua SDK is fully removed from the dependency manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["@trycua/cua-driver"], undefined);
  assert.equal(manifest.optionalDependencies?.["@trycua/cua-driver"], undefined);
});

test("build config no longer externalizes or bundles the cua process entry", async () => {
  const config = await readFile(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(config, /@trycua/);
  assert.doesNotMatch(config, /cuaProcess/);
});
