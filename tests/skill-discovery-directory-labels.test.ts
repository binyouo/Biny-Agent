/** Rendered metadata contract only; no user events or native UI acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopDiscoverableSkill, DesktopSkillsShDiscoverableSkill } from "../src/desktop/protocol.js";

await test("discovery cards distinguish exact root and child paths without renaming skills", async () => {
  const React = await import("react");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const repository = { owner: "fixture-owner", name: "fixture-repository", branch: "main", enabled: true };
  const skills = [
    { name: "root-skill", directory: "." },
    { name: "child-skill", directory: repository.name }
  ].map((skill) => ({
    ...skill, key: `${repository.owner}/${repository.name}:${skill.directory}`, description: "Fixture discovery metadata",
    repoOwner: repository.owner, repoName: repository.name, repoBranch: repository.branch, installed: false
  } satisfies DesktopDiscoverableSkill));
  Object.assign(dom.window, { biny: { skillDiscovery: async () => ({ repositories: [repository], skills, warnings: [] }) } });
  const errors: string[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { SkillDiscoveryView } = await import("../src/desktop/renderer/src/components/SkillDiscoveryView.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => root.render(React.createElement(SkillDiscoveryView, {
      onBack() {}, onError: (error) => errors.push(error), onInstalled: async () => {}
    })));
    const cards = [...dom.window.document.querySelectorAll(".biny-discovery-card")];
    assert.equal(cards.length, 2);
    const rootCard = cards.find((card) => card.querySelector("h2")?.textContent === "root-skill");
    const childCard = cards.find((card) => card.querySelector("h2")?.textContent === "child-skill");
    assert.ok(rootCard);
    assert.ok(childCard);
    assert.match(rootCard.querySelector(".biny-discovery-card-repo")?.textContent ?? "", /仓库根目录（\.）/u);
    assert.equal(childCard.querySelector(".biny-discovery-card-repo")?.firstChild?.textContent, repository.name);
    assert.equal(rootCard.querySelector(".biny-discovery-install")?.getAttribute("aria-label"), "安装 root-skill（仓库根目录：.）");
    assert.equal(childCard.querySelector(".biny-discovery-install")?.getAttribute("aria-label"), `安装 child-skill（${repository.name}）`);
    assert.deepEqual(errors, []);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

for (const source of ["repository", "skills.sh"] as const) {
  for (const state of ["installed", "installing"] as const) {
    await test(`${source} card accessible name reflects ${state} status and exact source`, async () => {
      const React = await import("react");
      const { JSDOM } = await import("jsdom");
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { DiscoveryCard, SkillsShCard } = await import("../src/desktop/renderer/src/components/SkillDiscoveryView.js");
      const savedReact = Object.getOwnPropertyDescriptor(globalThis, "React");
      Object.defineProperty(globalThis, "React", { configurable: true, value: React });
      let dom: InstanceType<typeof JSDOM> | undefined;
      try {
        const skill = {
          key: "fixture-owner/fixture-repository:.", name: "root-skill", directory: ".",
          repoOwner: "fixture-owner", repoName: "fixture-repository", repoBranch: "main", installed: state === "installed"
        };
        const actions = { installing: state === "installing", onInstall() {}, onView() {} };
        const node = source === "repository"
          ? React.createElement(DiscoveryCard, { ...actions, skill: { ...skill, description: "Fixture" } satisfies DesktopDiscoverableSkill })
          : React.createElement(SkillsShCard, { ...actions, skill: { ...skill, installs: 1 } satisfies DesktopSkillsShDiscoverableSkill });
        dom = new JSDOM(renderToStaticMarkup(node));
        const button = dom.window.document.querySelector<HTMLButtonElement>(".biny-discovery-install");
        assert.ok(button);
        assert.equal(button.getAttribute("aria-label"), `${state === "installed" ? "已安装" : "安装中"} root-skill（仓库根目录：.）`);
        assert.equal(button.disabled, true);
        assert.equal(button.textContent, state === "installed" ? "已安装" : "安装中…");
      } finally {
        dom?.window.close();
        if (savedReact) Object.defineProperty(globalThis, "React", savedReact);
        else Reflect.deleteProperty(globalThis, "React");
      }
    });
  }
}
