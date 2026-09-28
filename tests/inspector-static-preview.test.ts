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


test("文件交互预览复用同项目服务并解析相对资源，同时阻止隐藏文件和越界读取", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-html-preview-"));
  const root = path.join(dir, "site");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root); await mkdir(path.join(root, "pages"));
  await writeFile(path.join(root, "pages", "game.html"), '<script src="./game.js"></script>');
  await writeFile(path.join(root, "pages", "game.js"), "document.body.textContent = 'ready'");
  await writeFile(path.join(root, "pages", "other.html"), "Other page");
  await writeFile(path.join(root, ".env"), "SECRET=local");
  await writeFile(path.join(dir, "outside.html"), "outside");
  await symlink(path.join(dir, "outside.html"), path.join(root, "escape.html"));
  const preview = new StaticPreviewServer();
  try {
    const game = await preview.htmlPreviewUrl("project", root, "pages/game.html");
    assert.match(await (await fetch(game.url)).text(), /game\.js/);
    assert.match(await (await fetch(new URL("game.js", game.url))).text(), /ready/);
    const other = await preview.htmlPreviewUrl("project", root, "pages/other.html");
    assert.equal(new URL(other.url).origin, new URL(game.url).origin);
    assert.equal(await (await fetch(other.url)).text(), "Other page");
    assert.equal(preview.status("project"), undefined, "文件预览不占用运行预览服务");
    assert.equal((await fetch(new URL("/.env", game.url))).status, 403);
    await assert.rejects(preview.htmlPreviewUrl("project", root, "escape.html"), /项目目录/);
    await assert.rejects(preview.htmlPreviewUrl("project", root, "../outside.html"), /项目内/);
  } finally { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); }
});
