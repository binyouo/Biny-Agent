import assert from "node:assert/strict";
import { test } from "node:test";

test("settings navigation uses distinct implemented icons and matches the Appshots badge", async () => {
  const { readFile } = await import("node:fs/promises");
  const overlay = await readFile(new URL("../src/desktop/renderer/src/components/settings/SettingsOverlay.tsx", import.meta.url), "utf8");
  const nav = [...overlay.matchAll(/icon: "([a-z-]+)", tab: "([^"]+)"/gu)].map(m => ({ icon: m[1], tab: m[2] }));
  assert.equal(nav.length, 17, "导航项数量变了，先确认不是漏读");
  const icons = nav.map(n => n.icon);
  const dupes = icons.filter((v, i) => icons.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `导航图标重复：${dupes.join(", ")}`);
  // 保留导航目的地的图标语义；现有页面徽标与导航一致。
  const byTab = new Map(nav.map(n => [n.tab, n.icon]));
  assert.equal(byTab.get("导入"), "download");
  assert.equal(byTab.get("Computer Use"), "cpu");
  assert.equal(byTab.get("Appshots"), "camera");
  const as = await readFile(new URL("../src/desktop/renderer/src/components/settings/SettingsAppshots.tsx", import.meta.url), "utf8");
  assert.match(as, /appshot-hero-badge"><Icon name="camera"/u, "Appshots hero 图标应与导航一致");
  // 图标必须真的在 Icon.tsx 里存在，否则渲染成空白
  const iconSrc = await readFile(new URL("../src/desktop/renderer/src/components/Icon.tsx", import.meta.url), "utf8");
  for (const name of icons) {
    assert.match(iconSrc, new RegExp(`^\\s*\\| "${name}"$`, "mu"), `Icon "${name}" 未在 Icon.tsx 中声明`);
    assert.match(iconSrc, new RegExp(`case "${name}":`, "u"), `Icon "${name}" 没有实现`);
  }
});
