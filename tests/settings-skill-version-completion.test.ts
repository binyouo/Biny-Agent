/** Backend version operations are deferred IPC fakes; no actual skills are changed. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopSkillCatalogSnapshot, DesktopSkillFilePreview } from "../src/desktop/protocol.js";
import type { ManagedSkillVersion } from "../src/extensions/skillVersions.js";
import type { SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const initialVersion: ManagedSkillVersion = {
  format: 1, id: "11111111-1111-4111-8111-111111111111", previous: "22222222-2222-4222-8222-222222222222", name: "alpha",
  revision: "a".repeat(40), digest: "a".repeat(64), installedAt: "2026-01-01T00:00:00.000Z",
  source: { owner: "example", repository: "inert", branch: "main", directory: "alpha" }
};
const nextVersion: ManagedSkillVersion = { ...initialVersion, id: initialVersion.previous!, revision: "b".repeat(40) };
function catalog(names = ["Alpha"]): DesktopSkillCatalogSnapshot {
  const skills = names.map(name => ({ id: name, ref: `global:${name}`, name, description: "", scope: "global" as const,
    source: "biny" as const, engine: "biny" as const, linkedEngines: [], precedence: 1,
    absolutePath: `/inert/${name}`, mdPath: `/inert/${name}/SKILL.md`, frontmatter: {},
    files: [{ name: "SKILL.md", path: "SKILL.md", kind: "file" as const, size: 1 }] }));
  return { skills, inventory: skills, plugins: [], unmanagedSkills: [], managedSources: [], warnings: [], diagnostics: [] };
}
const preview = (content: string): DesktopSkillFilePreview => ({ path: "SKILL.md", content, bytes: content.length, binary: false, truncated: false });

async function harness(api: Record<string, unknown> = {}) {
  const imports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
  } });
  const { JSDOM } = await import("jsdom"); const React = await import("react");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const catalogs: Array<string | undefined> = []; const reads: string[] = []; const mutations: Array<[string, string]> = [];
  const mutation = deferred<unknown>(); let version = initialVersion;
  Object.assign(dom.window, { biny: {
    skillCatalog: async (project?: string) => { catalogs.push(project); return catalog(); },
    skillVersion: async () => version,
    readSkillFile: async (id: string) => { reads.push(id); return preview(version.id === initialVersion.id ? "before-version-change" : "after-version-change"); },
    updateSkillVersion: async (id: string, expected: string) => { mutations.push([id, expected]); return await mutation.promise; },
    rollbackSkillVersion: async (id: string, expected: string) => { mutations.push([id, expected]); return await mutation.promise; },
    ...api
  } });
  const { createRoot } = await import("react-dom/client");
  const { SettingsExtensionsView } = await import("../src/desktop/renderer/src/components/settings/SettingsExtensionsView.js");
  const { SettingsDraftContext } = await import("../src/desktop/renderer/src/components/settings/SettingsDraftContext.js");
  const { SkillHubView } = await import("../src/desktop/renderer/src/components/SkillHubView.js");
  const root = createRoot(document.getElementById("root")!); const errors: string[] = [];
  const onError = (message: string) => errors.push(message); const onOpenRuntime = () => {};
  return { React, errors, catalogs, reads, mutations, text: () => document.body.textContent ?? "",
    async render(view: "settings" | "hub" = "settings", projectId = "project") {
      const node = view === "hub" ? React.createElement(SkillHubView, { onError, onOpenRuntime })
        : React.createElement(SettingsDraftContext.Provider, { value: {} as SettingsDraftContextValue },
          React.createElement(SettingsExtensionsView, { kind: "skills", projectId, onError }));
      await React.act(async () => root.render(node));
    },
    async toggle(name = "Alpha") {
      const card = [...document.querySelectorAll(".settings-skill-card")].find(element => element.querySelector("h4")?.textContent === name);
      const button = card?.querySelector<HTMLButtonElement>(".settings-skill-content-toggle"); assert.ok(button, name);
      await React.act(async () => button.click());
    },
    async click(label: string) {
      const button = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label); assert.ok(button, label);
      await React.act(async () => button.click());
    },
    async finish(rollback = false) {
      version = nextVersion;
      await React.act(async () => mutation.resolve(rollback ? version : { version }));
    },
    async fail() { await React.act(async () => mutation.reject(new Error("fixture version failure"))); },
    async leave() { await React.act(async () => root.render(null)); },
    async close() {
      await React.act(() => root.unmount()); dom.window.close(); imports.deregister();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

for (const rollback of [false, true]) {
  test(`settings invalidates cached content when ${rollback ? "rollback" : "update"} completes after collapse`, async () => {
    const h = await harness();
    try {
      await h.render(); await h.toggle(); assert.match(h.text(), /before-version-change/);
      await h.click(rollback ? "回滚上一版本" : "检查并更新"); await h.toggle(); await h.finish(rollback);
      await h.toggle(); assert.match(h.text(), /after-version-change/); assert.doesNotMatch(h.text(), /before-version-change/);
      assert.deepEqual(h.mutations, [["Alpha", initialVersion.id]]); assert.equal(h.catalogs.length, 2); assert.equal(h.reads.length, 2);
    } finally { await h.close(); }
  });
}

test("completion from replaced controls invalidates the surviving settings parent's preview", async () => {
  const h = await harness();
  try {
    await h.render(); await h.toggle(); await h.click("检查并更新"); await h.toggle(); await h.toggle();
    assert.match(h.text(), /before-version-change/);
    await h.finish(); await h.toggle();
    assert.match(h.text(), /after-version-change/); assert.doesNotMatch(h.text(), /before-version-change/);
    assert.equal(h.catalogs.length, 2);
  } finally { await h.close(); }
});

test("a completed old-project mutation cannot collapse or reload a new settings parent", async () => {
  const h = await harness();
  try {
    await h.render("settings", "old"); await h.toggle(); await h.click("检查并更新");
    await h.render("settings", "new"); await h.toggle();
    await h.finish();
    assert.deepEqual(h.catalogs, ["old", "new"]); assert.deepEqual(h.errors, []);
    assert.ok(document.querySelector('[aria-expanded="true"]'));
    assert.match(h.text(), /before-version-change/);
  } finally { await h.close(); }
});

for (const view of ["settings", "hub"] as const) {
  for (const failure of [false, true]) {
    test(`${view} parent disposal suppresses detached mutation ${failure ? "errors" : "reloads"}`, async () => {
      const h = await harness();
      try {
        await h.render(view); if (view === "settings") await h.toggle();
        await h.click("检查并更新"); await h.leave();
        if (failure) await h.fail(); else await h.finish();
        assert.equal(h.catalogs.length, 1); assert.deepEqual(h.errors, []);
      } finally { await h.close(); }
    });
  }
}

test("detached failure keeps a valid completed cache and does not report to the surviving parent", async () => {
  const h = await harness();
  try {
    await h.render(); await h.toggle(); await h.click("检查并更新"); await h.toggle(); await h.fail(); await h.toggle();
    assert.equal(h.catalogs.length, 1); assert.equal(h.reads.length, 1); assert.deepEqual(h.errors, []);
    assert.match(h.text(), /before-version-change/);
  } finally { await h.close(); }
});

test("current controls still report a mutation error and release their busy state", async () => {
  const h = await harness();
  try {
    await h.render(); await h.toggle(); await h.click("检查并更新"); await h.fail();
    assert.deepEqual(h.errors, ["fixture version failure"]); assert.equal(h.catalogs.length, 1);
    const button = [...document.querySelectorAll("button")].find(element => element.textContent === "检查并更新");
    assert.ok(button); assert.equal(button.disabled, false);
  } finally { await h.close(); }
});

for (const rollback of [false, true]) {
  test(`hub refreshes after detached ${rollback ? "rollback" : "update"} while its parent survives`, async () => {
    const h = await harness();
    try {
      await h.render("hub"); assert.match(h.text(), /before-version-change/);
      await h.click(rollback ? "回滚上一版本" : "检查并更新"); await h.click("插件"); await h.finish(rollback); await h.click("技能");
      assert.match(h.text(), /after-version-change/); assert.doesNotMatch(h.text(), /before-version-change/);
      assert.equal(h.catalogs.length, 2); assert.deepEqual(h.mutations, [["Alpha", initialVersion.id]]);
    } finally { await h.close(); }
  });
}

test("hub disposal suppresses a catalog error started by a current successful mutation", async () => {
  const pendingCatalog = deferred<DesktopSkillCatalogSnapshot>(); let calls = 0;
  const h = await harness({ skillCatalog: () => ++calls === 1 ? Promise.resolve(catalog()) : pendingCatalog.promise });
  try {
    await h.render("hub"); await h.click("检查并更新"); await h.finish(); assert.equal(calls, 2);
    await h.leave(); await h.React.act(async () => pendingCatalog.reject(new Error("detached catalog failed")));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("returning to the same project creates a new parent that ignores the original mutation callback", async () => {
  const h = await harness();
  try {
    await h.render("settings", "old"); await h.toggle(); await h.click("检查并更新");
    await h.render("settings", "other"); await h.render("settings", "old"); await h.toggle(); await h.finish();
    assert.deepEqual(h.catalogs, ["old", "other", "old"]); assert.deepEqual(h.errors, []);
    assert.ok(document.querySelector('[aria-expanded="true"]'));
  } finally { await h.close(); }
});

test("a detached skill's successful mutation refreshes the hub without replacing its newer selection", async () => {
  let catalogs = 0;
  const h = await harness({ skillCatalog: async () => { catalogs++; return catalog(["Alpha", "Beta"]); } });
  try {
    await h.render("hub"); await h.click("检查并更新");
    const beta = [...document.querySelectorAll<HTMLButtonElement>(".biny-skill-card")]
      .find(button => button.querySelector(".biny-skill-card-title")?.textContent === "Beta");
    assert.ok(beta); await h.React.act(async () => beta.click());
    await h.finish();
    assert.ok(document.querySelector('[aria-label="Beta 详情"]'));
    assert.deepEqual(h.mutations, [["Alpha", initialVersion.id]]); assert.equal(catalogs, 2);
  } finally { await h.close(); }
});

async function selectHubSkill(h: Awaited<ReturnType<typeof harness>>, name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".biny-skill-card")]
    .find(element => element.querySelector(".biny-skill-card-title")?.textContent === name);
  assert.ok(button); await h.React.act(async () => button.click());
}
async function editDraft(h: Awaited<ReturnType<typeof harness>>, value: string) {
  const area = document.querySelector<HTMLTextAreaElement>("textarea"); assert.ok(area);
  await h.React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await h.render("hub");
  assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, value, "draft is held in React state");
}

for (const rollback of [false, true]) {
  test(`remounted hub controls use the committed ${rollback ? "rollback" : "update"} version for their next request`, async () => {
    const h = await harness();
    try {
      await h.render("hub"); await h.click(rollback ? "回滚上一版本" : "检查并更新");
      await h.click("插件"); await h.click("技能"); await h.finish(rollback);
      assert.match(h.text(), /after-version-change/);
      assert.match(document.querySelector(".biny-skill-version")?.textContent ?? "", /bbbbbbbbbbbb/);
      await h.click("检查并更新"); assert.deepEqual(h.mutations[1], ["Alpha", nextVersion.id]);
    } finally { await h.close(); }
  });
}

for (const oldFirst of [false, true]) {
  test(`a superseded version lookup cannot restore the old token when it resolves ${oldFirst ? "before" : "after"} the new lookup`, async () => {
    const old = deferred<ManagedSkillVersion>(); const current = deferred<ManagedSkillVersion>(); let lookups = 0;
    const h = await harness({ skillVersion: () => {
      lookups++;
      return lookups === 1 ? Promise.resolve(initialVersion) : lookups === 2 ? old.promise
        : lookups === 3 ? current.promise : Promise.resolve(nextVersion);
    } });
    try {
      await h.render("hub"); await h.click("检查并更新"); await h.click("插件"); await h.click("技能");
      await h.finish(); assert.equal(lookups, 3);
      assert.equal(document.querySelector(".biny-skill-version"), null, "stale version actions remain unavailable while refresh is pending");
      if (oldFirst) {
        await h.React.act(async () => old.resolve(initialVersion));
        assert.equal(document.querySelector(".biny-skill-version"), null);
        await h.React.act(async () => current.resolve(nextVersion));
      } else {
        await h.React.act(async () => current.resolve(nextVersion));
        await h.React.act(async () => old.resolve(initialVersion));
      }
      assert.match(document.querySelector(".biny-skill-version")?.textContent ?? "", /bbbbbbbbbbbb/);
      await h.click("检查并更新"); assert.deepEqual(h.mutations[1], ["Alpha", nextVersion.id]);
    } finally { await h.close(); }
  });
}

for (const finishWith of ["save", "cancel"] as const) {
  test(`unrelated mutation completion preserves Beta's draft until its explicit ${finishWith}`, async () => {
    let betaContent = "Beta saved body"; const writes: string[][] = []; const reads: string[] = [];
    const h = await harness({ skillCatalog: async () => catalog(["Alpha", "Beta"]),
      readSkillFile: async (id: string) => { reads.push(id); return preview(id === "Beta" ? betaContent : "Alpha body"); },
      writeSkillFile: async (id: string, file: string, content: string) => { writes.push([id, file, content]); betaContent = content; } });
    try {
      await h.render("hub"); await h.click("检查并更新"); await selectHubSkill(h, "Beta"); await h.click("编辑");
      await editDraft(h, "unique Beta unsaved draft"); const readCount = reads.length;
      await h.finish();
      assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, "unique Beta unsaved draft");
      assert.equal(reads.length, readCount, "unrelated catalog entry refresh must not reread the current file");
      await selectHubSkill(h, "Beta");
      assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, "unique Beta unsaved draft", "same selection is a no-op");
      await h.click(finishWith === "save" ? "保存" : "取消");
      assert.equal(document.querySelector("textarea"), null);
      if (finishWith === "save") { assert.deepEqual(writes, [["Beta", "SKILL.md", "unique Beta unsaved draft"]]); assert.match(h.text(), /unique Beta unsaved draft/); }
      else { assert.deepEqual(writes, []); assert.match(h.text(), /Beta saved body/); assert.doesNotMatch(h.text(), /unique Beta unsaved draft/); }
      assert.deepEqual(h.mutations, [["Alpha", initialVersion.id]]);
    } finally { await h.close(); }
  });
}

test("the changed skill's active draft survives completion until the user cancels editing", async () => {
  const h = await harness();
  try {
    await h.render("hub"); await h.click("检查并更新"); await h.click("编辑"); await editDraft(h, "Alpha in-progress draft");
    await h.finish(); assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, "Alpha in-progress draft");
    await h.click("取消"); assert.match(h.text(), /after-version-change/); assert.doesNotMatch(h.text(), /Alpha in-progress draft/);
    assert.match(document.querySelector(".biny-skill-version")?.textContent ?? "", /bbbbbbbbbbbb/);
  } finally { await h.close(); }
});

test("explicit skill and file navigation still exits editing and loads the chosen file", async () => {
  const snapshot = catalog(["Alpha", "Beta"]);
  snapshot.skills[1]!.files.push({ name: "notes.md", path: "notes.md", kind: "file", size: 1 });
  const h = await harness({ skillCatalog: async () => snapshot, readSkillFile: async (id: string, file: string) => preview(`${id}:${file}`) });
  try {
    await h.render("hub"); await selectHubSkill(h, "Beta"); await h.click("编辑"); await editDraft(h, "discard on file navigation");
    await h.click("notes.md"); assert.equal(document.querySelector("textarea"), null); assert.match(h.text(), /Beta:notes.md/);
    await h.click("编辑"); await editDraft(h, "discard on skill navigation"); await selectHubSkill(h, "Alpha");
    assert.equal(document.querySelector("textarea"), null); assert.match(h.text(), /Alpha:SKILL.md/);
  } finally { await h.close(); }
});

test("detached Alpha completion preserves Beta's pending settings preview and invalidates only Alpha", async () => {
  const beta = deferred<DesktopSkillFilePreview>(); const reads: string[] = [];
  const h = await harness({ skillCatalog: async () => catalog(["Alpha", "Beta"]),
    readSkillFile: (id: string) => { reads.push(id); return id === "Beta" ? beta.promise : Promise.resolve(preview(`Alpha-${reads.length}`)); } });
  try {
    await h.render(); await h.toggle("Alpha"); await h.click("检查并更新"); await h.toggle("Beta"); await h.finish();
    assert.ok(document.querySelector('[aria-label="Beta 内容"]')); assert.match(h.text(), /正在读取内容/);
    await h.React.act(async () => beta.resolve(preview("Beta current preview"))); assert.match(h.text(), /Beta current preview/);
    await h.toggle("Beta"); await h.toggle("Beta"); assert.deepEqual(reads, ["Alpha", "Beta"]);
    await h.toggle("Alpha"); assert.deepEqual(reads, ["Alpha", "Beta", "Alpha"]);
  } finally { await h.close(); }
});

test("edit waits for the selected file read and unrelated completion cannot strand that read", async () => {
  const beta = deferred<DesktopSkillFilePreview>();
  const h = await harness({ skillCatalog: async () => catalog(["Alpha", "Beta"]),
    readSkillFile: async (id: string) => id === "Beta" ? await beta.promise : preview("Alpha body") });
  try {
    await h.render("hub"); await h.click("检查并更新"); await selectHubSkill(h, "Beta");
    const edit = () => [...document.querySelectorAll("button")].find(button => button.textContent === "编辑");
    assert.equal(edit()?.disabled, true); await h.click("编辑"); assert.equal(document.querySelector("textarea"), null);
    await h.finish(); await h.React.act(async () => beta.resolve(preview("Beta loaded body")));
    assert.equal(edit()?.disabled, false); await h.click("编辑");
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, "Beta loaded body");
  } finally { await h.close(); }
});

async function overlappingVersions(names = ["Alpha", "Beta"]) {
  const revisions = new Map<string, number>();
  const mutationCalls: Array<[string, string]> = [];
  const pendingMutations = new Map<string, Array<ReturnType<typeof deferred<unknown>>>>();
  const pendingCatalogs: Array<{ request: ReturnType<typeof deferred<DesktopSkillCatalogSnapshot>>; snapshot: DesktopSkillCatalogSnapshot }> = [];
  const fileReads: string[] = []; let catalogCalls = 0;
  const versionFor = (id: string): ManagedSkillVersion => {
    const revision = revisions.get(id) ?? 0; const digit = String(revision + 1);
    return { ...initialVersion, name: id.toLowerCase(), revision: String.fromCharCode(97 + revision).repeat(40),
      id: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}` };
  };
  const snapshot = () => {
    const value = catalog(names);
    for (const skill of value.skills) skill.description = `${skill.id} metadata revision ${revisions.get(skill.id) ?? 0}`;
    return value;
  };
  const h = await harness({ skillCatalog: () => {
    if (++catalogCalls === 1) return Promise.resolve(snapshot());
    const request = deferred<DesktopSkillCatalogSnapshot>(); pendingCatalogs.push({ request, snapshot: snapshot() }); return request.promise;
  }, skillVersion: async (id: string) => versionFor(id),
  readSkillFile: async (id: string) => { fileReads.push(id); return preview(`${id} stable file`); },
  updateSkillVersion: (id: string, expected: string) => {
    mutationCalls.push([id, expected]); assert.equal(expected, versionFor(id).id);
    const request = deferred<unknown>(); const pending = pendingMutations.get(id) ?? [];
    pending.push(request); pendingMutations.set(id, pending); return request.promise;
  } });
  return { h, pendingCatalogs, mutationCalls, fileReads, versionFor,
    async begin(id: string) { await selectHubSkill(h, id); await h.click("检查并更新"); },
    async complete(id: string, index = 0) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      const request = pendingMutations.get(id)?.[index]; assert.ok(request);
      await h.React.act(async () => request.resolve({ version: versionFor(id) }));
    },
    async adopt(index: number) { const entry = pendingCatalogs[index]; assert.ok(entry); await h.React.act(async () => entry.request.resolve(entry.snapshot)); },
    async reject(index: number) { const entry = pendingCatalogs[index]; assert.ok(entry); await h.React.act(async () => entry.request.reject(new Error("latest catalog failed"))); },
    externalChange(id: string) { revisions.set(id, (revisions.get(id) ?? 0) + 1); }
  };
}

for (const sameSkill of [false, true]) {
  for (const newestFirst of [false, true]) {
    test(`${sameSkill ? "repeated same-skill" : "different-skill"} successes survive ${newestFirst ? "newest-first" : "oldest-first"} catalog settlement`, async () => {
      const f = await overlappingVersions(); const { h } = f;
      try {
        await h.render("hub"); await f.begin("Alpha"); if (!sameSkill) await f.begin("Beta");
        await f.complete("Alpha"); assert.equal(f.pendingCatalogs.length, 1);
        if (sameSkill) await f.begin("Alpha");
        await f.complete(sameSkill ? "Alpha" : "Beta", sameSkill ? 1 : 0); assert.equal(f.pendingCatalogs.length, 2);
        await f.adopt(newestFirst ? 1 : 0); await f.adopt(newestFirst ? 0 : 1);
        assert.match(h.text(), new RegExp(`Alpha metadata revision ${sameSkill ? 2 : 1}`));
        assert.match(h.text(), new RegExp(`Beta metadata revision ${sameSkill ? 0 : 1}`));
        if (sameSkill) assert.equal(f.mutationCalls[1]?.[1], nextVersion.id);
      } finally { await h.close(); }
    });
  }
}

test("failed latest catalog adoption retains earlier affected IDs for the next successful mutation refresh", async () => {
  const f = await overlappingVersions(["Alpha", "Beta", "Gamma"]); const { h } = f;
  try {
    await h.render("hub"); await f.begin("Alpha"); await f.begin("Beta"); await f.begin("Gamma");
    await f.complete("Alpha"); await f.complete("Beta"); assert.equal(f.pendingCatalogs.length, 2);
    await f.reject(1); await f.adopt(0); assert.deepEqual(h.errors, ["latest catalog failed"]);
    await f.complete("Gamma"); assert.equal(f.pendingCatalogs.length, 3); await f.adopt(2);
    for (const id of ["Alpha", "Beta", "Gamma"]) assert.match(h.text(), new RegExp(`${id} metadata revision 1`));
  } finally { await h.close(); }
});

test("a superseded explicit full refresh is still adopted with the next mutation result", async () => {
  const f = await overlappingVersions(); const { h } = f;
  try {
    await h.render("hub"); await f.begin("Alpha"); f.externalChange("Beta");
    const refresh = document.querySelector<HTMLButtonElement>('[aria-label="刷新扩展列表"]'); assert.ok(refresh);
    await h.React.act(async () => refresh.click()); assert.equal(f.pendingCatalogs.length, 1);
    await f.complete("Alpha"); assert.equal(f.pendingCatalogs.length, 2); await f.adopt(1); await f.adopt(0);
    assert.match(h.text(), /Alpha metadata revision 1/); assert.match(h.text(), /Beta metadata revision 1/);
  } finally { await h.close(); }
});

test("coalesced affected-skill adoption preserves another skill's active draft and selection", async () => {
  const f = await overlappingVersions(["Alpha", "Beta", "Gamma"]); const { h } = f;
  try {
    await h.render("hub"); await f.begin("Alpha"); await f.begin("Beta"); await selectHubSkill(h, "Gamma");
    await h.click("编辑"); await editDraft(h, "Gamma remains unsaved"); const reads = f.fileReads.length;
    await f.complete("Alpha"); await f.complete("Beta"); await f.adopt(1); await f.adopt(0);
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, "Gamma remains unsaved");
    assert.ok(document.querySelector('[aria-label="Gamma 详情"]')); assert.equal(f.fileReads.length, reads);
    assert.match(h.text(), /Alpha metadata revision 1/); assert.match(h.text(), /Beta metadata revision 1/);
  } finally { await h.close(); }
});

test("a disposed hub's pending changed IDs cannot affect a newly mounted selection", async () => {
  const f = await overlappingVersions(); const { h } = f;
  try {
    await h.render("hub"); await f.begin("Alpha"); await f.complete("Alpha");
    await h.leave(); await h.render("hub"); assert.equal(f.pendingCatalogs.length, 2);
    await f.adopt(1); await selectHubSkill(h, "Beta"); await f.adopt(0);
    assert.ok(document.querySelector('[aria-label="Beta 详情"]')); assert.deepEqual(h.errors, []);
    assert.match(h.text(), /Alpha metadata revision 1/);
  } finally { await h.close(); }
});
