import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fetchSiteIconDataUrl, normalizeSiteUrl } from "../src/desktop/electron/main/siteIcon.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WuoAAAAASUVORK5CYII=", "base64");

test("site icon lookup normalizes user URLs and rejects non-web or credential URLs", () => {
  assert.equal(normalizeSiteUrl("example.com")?.href, "https://example.com/");
  assert.equal(normalizeSiteUrl("javascript:alert(1)"), undefined);
  assert.equal(normalizeSiteUrl("https://user:secret@example.com"), undefined);
  assert.equal(normalizeSiteUrl("localhost")?.href, "https://localhost/");
});

test("site icon lookup follows HTML icon links and returns a bounded PNG data URL", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://example.com/docs/start") {
      return new Response('<html><head><link rel="icon" sizes="64x64" href="/brand.png"></head></html>', {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    if (url === "https://example.com/brand.png") {
      return new Response(tinyPng, { headers: { "content-type": "image/png" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const icon = await fetchSiteIconDataUrl("https://example.com/docs/start", { fetcher, resolveHostname: async () => ["93.184.216.34"] });
  assert.ok(icon?.startsWith("data:image/png;base64,"));
  assert.deepEqual(requested, ["https://example.com/docs/start", "https://example.com/brand.png"]);
});

test("site icon lookup returns no icon when the supplied address is invalid", async () => {
  let requested = false;
  const fetcher: typeof fetch = async () => { requested = true; throw new Error("Unexpected request"); };
  assert.equal(await fetchSiteIconDataUrl("file:///etc/passwd", { fetcher }), undefined);
  assert.equal(requested, false);
});

test("project icons persist in desktop state and malformed image URLs are discarded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-icon-state-"));
  try {
    const filePath = path.join(root, "desktop.json");
    const iconDataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;
    await writeFile(filePath, JSON.stringify({ projects: [
      { id: "valid", path: "/tmp/valid", name: "Valid", iconDataUrl },
      { id: "invalid", path: "/tmp/invalid", name: "Invalid", iconDataUrl: "data:text/html;base64,PGh0bWw+" }
    ] }));

    const state = new DesktopStateStore(filePath);
    await state.load();
    const projects = state.projects();
    assert.equal(projects.find((project) => project.id === "valid")?.iconDataUrl, iconDataUrl);
    assert.equal(projects.find((project) => project.id === "invalid")?.iconDataUrl, undefined);
    await state.setProjectPinned("valid", true);

    const reloaded = new DesktopStateStore(filePath);
    await reloaded.load();
    assert.equal(reloaded.projects().find((project) => project.id === "valid")?.iconDataUrl, iconDataUrl);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).projects[0].pinned, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
