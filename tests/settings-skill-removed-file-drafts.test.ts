/** Real SkillHub UI with fake IPC only; no actual version/file writes or network. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopSkillCatalogSnapshot, DesktopSkillFilePreview } from "../src/desktop/protocol.js";
import type { ManagedSkillVersion } from "../src/extensions/skillVersions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const initialVersion: ManagedSkillVersion = {
  format: 1, id: "11111111-1111-4111-8111-111111111111", previous: "22222222-2222-4222-8222-222222222222", name: "alpha",
  revision: "a".repeat(40), digest: "a".repeat(64), installedAt: "2026-01-01T00:00:00.000Z",
  source: { owner: "example", repository: "inert", branch: "main", directory: "alpha" }
};
const nextVersion: ManagedSkillVersion = { ...initialVersion, id: initialVersion.previous!, revision: "b".repeat(40) };
function catalog(names = ["Alpha", "Beta"]): DesktopSkillCatalogSnapshot {
  const skills = names.map(name => ({ id: name, ref: `global:${name}`, name, description: "", scope: "global" as const,
    source: "biny" as const, engine: "biny" as const, linkedEngines: [], precedence: 1,
    absolutePath: `/inert/${name}`, mdPath: `/inert/${name}/SKILL.md`, frontmatter: {},
    files: ["SKILL.md", "notes.md"].map(path => ({ name: path, path, kind: "file" as const, size: 1 })) }));
  return { skills, inventory: skills, plugins: [], unmanagedSkills: [{ id: "candidate", name: "Candidate", description: "", foundIn: [], path: "/inert/candidate" }],
    managedSources: [{ id: "inert", name: "Inert", description: "", installed: false }], warnings: [], diagnostics: [] };
}

async function harness() {
  const imports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom"); const React = await import("react");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value, supports: () => false }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let snapshot = catalog(); let version = initialVersion;
  const mutation = deferred<unknown>(); const reads: string[][] = []; const writes: string[][] = []; const errors: string[] = [];
  const bodies = new Map<string, string>(); const opened: string[] = [];
  Object.assign(dom.window, { biny: {
    skillCatalog: async () => structuredClone(snapshot), skillVersion: async () => version,
    readSkillFile: async (id: string, path: string): Promise<DesktopSkillFilePreview> => {
      reads.push([id, path]);
      if (!snapshot.skills.find(skill => skill.id === id)?.files.some(file => file.path === path)) throw new Error(`missing file ${id}:${path}`);
      const content = bodies.get(`${id}:${path}`) ?? `${id}:${path} saved body`;
      return { path, content, bytes: content.length, binary: false, truncated: false };
    },
    writeSkillFile: async (id: string, path: string, content: string) => { writes.push([id, path, content]); bodies.set(`${id}:${path}`, content); },
    updateSkillVersion: async () => await mutation.promise, rollbackSkillVersion: async () => await mutation.promise,
    importSkillSource: async () => ({ id: "inert" }), installSkillSource: async () => {},
    openSkillDirectory: async (id: string) => { opened.push(id); },
    importExistingSkills: async () => [{ id: "candidate", name: "Candidate", installedPath: "/inert/installed", alreadyInstalled: false }],
    skillDiscovery: async () => ({ repositories: [], warnings: [], skills: [{ key: "fixture", name: "Discovery", description: "", directory: "fixture", repoOwner: "example", repoName: "inert", repoBranch: "main", installed: false }] }),
    installDiscoveredSkill: async () => ({ name: "Discovery" }),
  } });
  const { createRoot } = await import("react-dom/client");
  const { SkillHubView } = await import("../src/desktop/renderer/src/components/SkillHubView.js");
  const root = createRoot(document.getElementById("root")!);
  const onError = (message: string) => errors.push(message); const onOpenRuntime = () => {};
  const render = async () => { await React.act(async () => root.render(React.createElement(SkillHubView, { onError, onOpenRuntime }))); };
  const button = (label: string) => {
    const result = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
    assert.ok(result, label); return result;
  };
  return { React, errors, reads, writes, opened, render, button, text: () => document.body.textContent ?? "",
    replace(next: DesktopSkillCatalogSnapshot) { snapshot = next; },
    async click(label: string) { await React.act(async () => button(label).click()); },
    async select(name: string) {
      const card = [...document.querySelectorAll<HTMLButtonElement>(".biny-skill-card")].find(element => element.querySelector(".biny-skill-card-title")?.textContent === name);
      assert.ok(card, name); await React.act(async () => card.click());
    },
    async edit(value = "unique removed-path draft") {
      const area = document.querySelector<HTMLTextAreaElement>("textarea"); assert.ok(area);
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
        area.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await render(); assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, value, "draft is in React state");
    },
    async finish(rollback = false) { version = nextVersion; await React.act(async () => mutation.resolve(rollback ? version : { version })); },
    async close() {
      await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}
function withoutNotes() { const next = catalog(); next.skills[0]!.files = next.skills[0]!.files.filter(file => file.path !== "notes.md"); return next; }
function assertRetained(h: Awaited<ReturnType<typeof harness>>) {
  const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑 notes.md"]');
  assert.equal(area?.value, "unique removed-path draft");
  assert.equal(h.button("保存").disabled, true, "missing target must not be writable");
  assert.match(h.text(), /notes\.md.*(?:移除|不存在|删除)/u, "explain why the retained draft cannot be saved");
  assert.deepEqual(h.writes, []);
}
for (const operation of ["update", "rollback", "refresh", "import", "install", "import-existing", "discovery"] as const) {
  test(`${operation} refresh retains a removed file draft without writes or fallback reads`, async () => {
    const h = await harness();
    try {
      await h.render();
      if (operation === "update" || operation === "rollback") await h.click(operation === "update" ? "检查并更新" : "回滚上一版本");
      await h.click("notes.md"); await h.click("编辑"); await h.edit(); const reads = h.reads.length;
      h.replace(withoutNotes());
      if (operation === "update" || operation === "rollback") await h.finish(operation === "rollback");
      else if (operation === "import-existing") { await h.click("导入已有"); await h.click("导入已选 (1)"); }
      else if (operation === "discovery") { await h.click("发现技能"); await h.click("安装"); await h.click("返回技能管理"); }
      else await h.click(operation === "refresh" ? "刷新扩展列表" : operation === "import" ? "添加 Skill" : "安装");
      assertRetained(h); assert.equal(h.reads.length, reads); await h.click("保存"); assert.deepEqual(h.writes, []);
      await h.click("插件"); await h.click("技能"); assertRetained(h); assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}
for (const removal of ["file", "files", "skill", "catalog"] as const) {
  test(`explicit Cancel releases the retained ${removal} draft and adopts the current catalog`, async () => {
    const h = await harness();
    try {
      await h.render(); await h.click("notes.md"); await h.click("编辑"); await h.edit();
      const next = removal === "catalog" ? catalog([]) : removal === "skill" ? catalog(["Beta"]) : withoutNotes();
      if (removal === "files") next.skills[0]!.files = [];
      h.replace(next); await h.click("刷新扩展列表"); assertRetained(h);
      await h.click("取消"); assert.equal(document.querySelector("textarea"), null); assert.deepEqual(h.writes, []); assert.deepEqual(h.errors, []);
      if (removal === "file") assert.match(h.text(), /Alpha:SKILL\.md saved body/);
      if (removal === "skill") assert.match(h.text(), /Beta:notes\.md saved body/);
      if (removal === "catalog") assert.match(h.text(), /还没有找到技能/);
    } finally { await h.close(); }
  });
}
for (const destination of ["file", "skill"] as const) {
  test(`deliberate ${destination} navigation still discards the removed-path edit and reads the chosen target`, async () => {
    const h = await harness();
    try {
      await h.render(); await h.click("notes.md"); await h.click("编辑"); await h.edit(); h.replace(withoutNotes());
      await h.click("刷新扩展列表"); assertRetained(h);
      if (destination === "file") await h.click("SKILL.md"); else await h.select("Beta");
      assert.equal(document.querySelector("textarea"), null);
      assert.match(h.text(), destination === "file" ? /Alpha:SKILL\.md saved body/ : /Beta:SKILL\.md saved body/);
      assert.deepEqual(h.writes, []); assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}
test("a restored path keeps the draft and explicit Save writes only the original file", async () => {
  const h = await harness();
  try {
    await h.render(); await h.click("notes.md"); await h.click("编辑"); await h.edit(); h.replace(withoutNotes());
    await h.click("刷新扩展列表"); assertRetained(h); h.replace(catalog()); await h.click("刷新扩展列表");
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, "unique removed-path draft");
    assert.equal(h.button("保存").disabled, false); await h.click("保存");
    assert.deepEqual(h.writes, [["Alpha", "notes.md", "unique removed-path draft"]]); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
test("non-editing removal still falls back automatically without requesting the missing file", async () => {
  const h = await harness();
  try {
    await h.render(); await h.click("notes.md"); const count = h.reads.length; h.replace(withoutNotes()); await h.click("刷新扩展列表");
    assert.equal(document.querySelector("textarea"), null); assert.match(h.text(), /Alpha:SKILL\.md saved body/);
    assert.deepEqual(h.reads.slice(count), [["Alpha", "SKILL.md"]]); assert.deepEqual(h.writes, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const replacement of ["directory", "project", "identity", "missing"] as const) {
  test(`${replacement} target change keeps the old draft display-only until explicit selection`, async () => {
    const h = await harness();
    try {
      await h.render(); await h.click("notes.md"); await h.click("编辑"); await h.edit();
      const next = catalog();
      if (replacement === "directory") next.skills[0]!.absolutePath = "/inert/relocated/Alpha";
      if (replacement === "project") next.skills[0]!.projectRoot = "/inert/new-project";
      if (replacement === "identity") { next.skills[0]!.id = "new-project-Alpha"; next.skills[0]!.ref = "project-new:Alpha"; }
      if (replacement === "missing") next.skills.shift();
      const reads = h.reads.length; h.replace(next); await h.click("刷新扩展列表"); assertRetained(h);
      assert.equal(document.querySelector(".biny-skill-detail-path")?.getAttribute("title"), "/inert/Alpha");
      assert.equal(document.querySelector(".biny-skill-version"), null, "a removed or replaced skill has no version actions");
      assert.equal(h.button("打开目录").disabled, true); await h.click("打开目录"); assert.deepEqual(h.opened, []);
      assert.equal(h.reads.length, reads); assert.equal(h.button("SKILL.md").disabled, true);
      await h.select(replacement === "missing" ? "Beta" : "Alpha");
      assert.equal(document.querySelector("textarea"), null);
      assert.match(h.text(), replacement === "missing" ? /Beta:SKILL\.md saved body/
        : replacement === "identity" ? /new-project-Alpha:SKILL\.md saved body/ : /Alpha:SKILL\.md saved body/);
      assert.deepEqual(h.errors, []); assert.deepEqual(h.writes, []);
    } finally { await h.close(); }
  });
}
test("the exact original skill can reappear after an empty catalog without losing the draft", async () => {
  const h = await harness();
  try {
    await h.render(); await h.click("notes.md"); await h.click("编辑"); await h.edit();
    h.replace(catalog([])); await h.click("刷新扩展列表"); assertRetained(h);
    h.replace(catalog()); await h.click("刷新扩展列表");
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑 notes.md"]')?.value, "unique removed-path draft");
    assert.equal(h.button("保存").disabled, false); assert.equal(h.button("打开目录").disabled, false);
    assert.ok(document.querySelector(".biny-skill-version")); await h.click("保存");
    assert.deepEqual(h.writes, [["Alpha", "notes.md", "unique removed-path draft"]]); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
