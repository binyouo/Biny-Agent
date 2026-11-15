/** Startup read failures must not turn valid preferences into a corrupt-file recovery. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-state-read-"));
  t.after(async () => { t.mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "desktop-state.json");
  const state = new DesktopStateStore(file);
  await state.load();
  return { root, file, state };
}

function snapshot(state: DesktopStateStore) {
  return {
    projects: state.projects(), active: state.activeProjectId(), selected: state.selectedSessionId("project-a"),
    view: state.activeView(), preferences: state.settingsPreferences(), quickChat: state.quickChatSettings(),
    sidebar: state.sidebarWidth(), bounds: state.windowBounds()
  };
}

async function seed(state: DesktopStateStore, root: string): Promise<void> {
  await state.upsertProject({ id: "project-a", path: path.join(root, "project-a"), name: "Saved project", pinned: true, iconDataUrl: undefined,
    dirty: false, missing: false, addedAt: "2026-11-13T00:00:00.000Z", lastOpenedAt: "2026-11-13T00:00:00.000Z" });
  await state.commitSelection("project-a", "session-a", "runtime");
  await state.setThemePreference("dark");
  await state.setQuickChatSettings({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false });
  await state.setSidebarWidth(310);
  await state.setWindowBounds({ x: 20, y: 30, width: 1000, height: 700 });
}

for (const code of ["EIO", "EACCES"] as const) {
  for (const loaded of [false, true]) {
    test(`${code} during ${loaded ? "reload" : "startup"} preserves bytes and state until an explicit retry`, async t => {
      const f = await fixture(t);
      await seed(f.state, f.root);
      const expected = snapshot(f.state);
      const before = await fs.readFile(f.file);
      const target = loaded ? f.state : new DesktopStateStore(f.file);
      const memoryBefore = snapshot(target);
      const failure = Object.assign(new Error(`Synthetic ${code} read failure`), { code });
      const original = fs.readFile;
      let reads = 0;
      const read = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === f.file && ++reads === 1) throw failure;
        return await original(...args);
      });
      await assert.rejects(target.load(), error => error === failure);
      assert.equal(reads, 1, "load must not silently retry");
      read.mock.restore();
      assert.deepEqual(snapshot(target), memoryBefore, "failed read must not reset an already loaded instance");
      assert.deepEqual(await fs.readFile(f.file), before, "read failure must not move or replace valid bytes");
      assert.deepEqual(await fs.readdir(f.root), ["desktop-state.json"], "I/O errors are not evidence of corruption");
      await target.load();
      assert.deepEqual(snapshot(target), expected, "ordinary explicit retry restores every saved field");
      assert.equal(target.quickChatSettings().injectScreenContext, false);
    });
  }
}

test("missing file retains first-start defaults without creating files", async t => {
  const f = await fixture(t);
  const expected = snapshot(f.state);
  await f.state.load();
  assert.deepEqual(snapshot(f.state), expected);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("missing file on a previously loaded instance retains its current state", async t => {
  const f = await fixture(t);
  await seed(f.state, f.root);
  const expected = snapshot(f.state);
  await fs.unlink(f.file);
  await f.state.load();
  assert.deepEqual(snapshot(f.state), expected);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("invalid JSON keeps the existing corrupt backup and defaults recovery", async t => {
  const f = await fixture(t);
  const defaults = snapshot(f.state);
  await seed(f.state, f.root);
  const invalid = Buffer.from('{"projects": [broken JSON\n');
  await fs.writeFile(f.file, invalid);
  await f.state.load();
  assert.deepEqual(snapshot(f.state), defaults);
  const entries = await fs.readdir(f.root);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /^desktop-state\.json\.corrupt-\d+$/u);
  assert.deepEqual(await fs.readFile(path.join(f.root, entries[0]!)), invalid);
});

test("legacy valid JSON retains projects while normalizing missing preferences", async t => {
  const f = await fixture(t);
  await seed(f.state, f.root);
  const projects = f.state.projects();
  await fs.writeFile(f.file, JSON.stringify({ version: 1, projects, activeProjectId: "project-a", selectedSessionIds: { "project-a": "session-a" }, themePreference: "dark" }));
  const restored = new DesktopStateStore(f.file);
  await restored.load();
  assert.deepEqual(restored.projects(), projects);
  assert.equal(restored.activeProjectId(), "project-a");
  assert.equal(restored.selectedSessionId("project-a"), "session-a");
  assert.equal(restored.themePreference(), "dark");
  assert.equal(restored.activeView(), "chat");
  assert.deepEqual(await fs.readdir(f.root), ["desktop-state.json"]);
});

test("a directory at the state path is not moved as corrupt data", async t => {
  const f = await fixture(t);
  const before = snapshot(f.state);
  await fs.mkdir(f.file);
  const marker = path.join(f.file, "keep.txt");
  await fs.writeFile(marker, "Keep this directory and its contents");
  await assert.rejects(f.state.load(), error => error instanceof Error && "code" in error && error.code === "EISDIR");
  assert.deepEqual(snapshot(f.state), before);
  assert.deepEqual(await fs.readdir(f.root), ["desktop-state.json"]);
  assert.equal(await fs.readFile(marker, "utf8"), "Keep this directory and its contents");
});
