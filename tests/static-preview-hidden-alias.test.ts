/** Real loopback HTTP and filesystem aliases; no external service or user data. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StaticPreviewServer } from "../src/desktop/electron/main/StaticPreviewServer.js";

const symlinkOptions = {
  skip: process.platform === "win32" ? "Requires POSIX symlink support" : false
};
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-preview-hidden-"));
  const root = path.join(dir, ".workspace");
  await mkdir(root);
  const preview = new StaticPreviewServer();
  t.after(async () => { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(root, "index.html"), "public page");
  await writeFile(path.join(root, ".env"), "SYNTHETIC_SECRET");
  await mkdir(path.join(root, ".private"));
  await writeFile(path.join(root, ".private", "config.json"), "SYNTHETIC_CONFIG");
  await writeFile(path.join(root, ".private", "page.html"), "SYNTHETIC_PRIVATE_PAGE");
  await symlink(".env", path.join(root, "environment.txt"));
  await symlink(".private", path.join(root, "assets"), "dir");
  await symlink(".private/page.html", path.join(root, "private-page.html"));
  return { dir, root, preview };
}
for (const route of ["/.env", "/environment.txt", "/assets/config.json", "/private-page.html"]) {
  for (const method of ["GET", "HEAD"]) test(`static preview rejects ${method} ${route}`, symlinkOptions, async t => {
    const { root, preview } = await fixture(t);
    const { url } = await preview.start("project", root, "index.html");
    const response = await fetch(new URL(route, url), { method });
    const content = await response.text();
    assert.equal(response.status, 403, route);
    assert.doesNotMatch(content, /SYNTHETIC_/);
  });
}
for (const entry of ["private-page.html", "assets/page.html"]) {
  for (const mode of ["start", "htmlPreviewUrl"] as const) test(`${mode} rejects a visible entry alias to ${entry}`, symlinkOptions, async t => {
    const { root, preview } = await fixture(t);
    await assert.rejects(preview[mode]("project", root, entry), /预览入口/);
    assert.equal(preview.status("project"), undefined);
    assert.equal(preview.status("file:project"), undefined);
  });
}
test("ordinary internal aliases and a symlinked hidden project root remain usable", symlinkOptions, async t => {
  const { dir, root, preview } = await fixture(t);
  await mkdir(path.join(root, "public"));
  await writeFile(path.join(root, "public", "page.html"), "PUBLIC_ALIAS_PAGE");
  await writeFile(path.join(root, "public", "style.css"), "PUBLIC_ALIAS_CSS");
  await symlink("public", path.join(root, "visible"), "dir");
  const rootAlias = path.join(dir, "project-alias");
  await symlink(root, rootAlias, "dir");
  const { url } = await preview.htmlPreviewUrl("project", rootAlias, "visible/page.html");
  assert.equal(await (await fetch(url)).text(), "PUBLIC_ALIAS_PAGE");
  assert.equal(await (await fetch(new URL("style.css", url))).text(), "PUBLIC_ALIAS_CSS");
});
for (const entry of [".env", ".private/page.html"]) test(`direct start rejects hidden entry ${entry}`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-preview-hidden-entry-"));
  const preview = new StaticPreviewServer();
  t.after(async () => { await preview.disposeAll(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(path.join(dir, ".private"));
  await writeFile(path.join(dir, entry), "SYNTHETIC_PRIVATE_ENTRY");
  await assert.rejects(preview.start("project", dir, entry), /预览入口/);
  assert.equal(preview.status("project"), undefined);
});
