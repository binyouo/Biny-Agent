/** 真实本地 HTTP 验证静态预览、工作区边界与停止语义。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StaticPreviewServer } from "../src/desktop/electron/main/StaticPreviewServer.js";

test("静态预览提供 HTML 和资源，拒绝目录逃逸与外部符号链接，停止后释放端口", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-static-preview-"));
  const root = path.join(dir, "site");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Local preview</title>");
  await writeFile(path.join(root, "style.css"), "body { color: red; }");
  await mkdir(path.join(root, "pages"));
  await writeFile(path.join(root, "pages", "demo.html"), "<!doctype html><title>Nested</title>");
  await writeFile(path.join(dir, "secret.txt"), "private");
  await symlink(path.join(dir, "secret.txt"), path.join(root, "escape.txt"));
  const preview = new StaticPreviewServer();
  try {
    const first = await preview.start("project", root, "index.html");
    assert.equal((await preview.start("project", root, "index.html")).url, first.url);
    const page = await fetch(first.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Local preview/);
    const asset = await fetch(new URL("style.css", first.url));
    assert.match(asset.headers.get("content-type") ?? "", /text\/css/);
    assert.equal((await fetch(new URL("escape.txt", first.url))).status, 403);
    assert.notEqual((await fetch(`${first.url}%2e%2e/secret.txt`)).status, 200);
    await preview.stop("project");
    assert.equal(preview.status("project"), undefined);
    const nested = await preview.start("project", root, "pages/demo.html");
    assert.match(nested.url, /\/pages\/demo\.html$/);
    assert.match(await (await fetch(nested.url)).text(), /Nested/);
  } finally { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});
