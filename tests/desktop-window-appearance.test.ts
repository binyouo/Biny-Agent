import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { buildSync } from "esbuild";
import { DEFAULT_APPEARANCE } from "../src/appearance/preferences.js";
import type { AppearanceSnapshot } from "../src/appearance/types.js";
import { AppearancePreviewCoordinator } from "../src/desktop/appearanceCoordinator.js";

function windowBoundary(title: string, destroyed = false) {
  const backgrounds: string[] = [];
  const buttons: boolean[] = [];
  return {
    backgrounds, buttons,
    isDestroyed: () => destroyed,
    getTitle: () => title,
    setBackgroundColor(value: string) { assert.equal(destroyed, false); backgrounds.push(value); },
    setWindowButtonVisibility(value: boolean) { assert.equal(destroyed, false); buttons.push(value); }
  };
}

for (const platform of ["darwin", "linux", "win32"] as const) {
  test(`${platform}: real appearance publishing preserves platform backgrounds, ownership and window selection`, () => {
    const main = windowBoundary("Biny");
    const quick = windowBoundary("Biny Quick Chat");
    const unrelated = windowBoundary("Inspector");
    const destroyed = windowBoundary("Biny Quick Chat", true);
    let systemDark = false;
    const nativeTheme = {
      themeSource: "system" as AppearanceSnapshot["themePreference"],
      get shouldUseDarkColors() { return this.themeSource === "dark" || (this.themeSource === "system" && systemDark); }
    };
    const entry = new URL("../src/desktop/electron/main/window.ts", import.meta.url);
    const compiled = buildSync({ entryPoints: [fileURLToPath(entry)], bundle: true, platform: "node", format: "cjs",
      packages: "external", write: false,
      define: { "process.platform": JSON.stringify(platform), "import.meta.url": JSON.stringify(entry.href) } }).outputFiles[0]!.text;
    const module = { exports: {} as { syncDesktopWindowAppearance(window: typeof main | undefined, snapshot: AppearanceSnapshot): void } };
    const require = createRequire(import.meta.url);
    runInNewContext(compiled, { module, exports: module.exports, URL, process, setTimeout, clearTimeout,
      require: (name: string) => name === "electron"
        ? { nativeTheme, BrowserWindow: { getAllWindows: () => [main, quick, unrelated, destroyed] } }
        : require(name) });
    let saved: AppearanceSnapshot = { themePreference: "light", appearancePreference: structuredClone(DEFAULT_APPEARANCE),
      fontPreference: { family: "system", size: 14 } };
    let activeMain: typeof main | undefined = main;
    const coordinator = new AppearancePreviewCoordinator({ read: () => saved,
      publish: snapshot => module.exports.syncDesktopWindowAppearance(activeMain, snapshot) });
    const expectBackground = (opaque: string) => {
      const expected = platform === "darwin" ? "#00000000" : opaque;
      assert.equal(main.backgrounds.at(-1), expected);
      assert.equal(quick.backgrounds.at(-1), expected);
      assert.deepEqual(unrelated.backgrounds, []);
      assert.deepEqual(destroyed.backgrounds, []);
      assert.deepEqual(quick.buttons, []);
    };
    coordinator.refresh();
    expectBackground("#f5f5f5");
    coordinator.preview(7, { ...saved, themePreference: "dark" });
    expectBackground("#1a1a1a");
    assert.equal(nativeTheme.themeSource, "dark");
    const beforeWrongOwner = main.backgrounds.length;
    coordinator.release(8);
    assert.equal(main.backgrounds.length, beforeWrongOwner);
    coordinator.release(7);
    expectBackground("#f5f5f5");
    systemDark = true;
    saved = { ...saved, themePreference: "system" };
    coordinator.committed();
    expectBackground("#1a1a1a");
    coordinator.preview(7, { ...saved, themePreference: "light", appearancePreference: { ...DEFAULT_APPEARANCE, lightTheme: "win98" } });
    expectBackground("#c0c0c0");
    if (platform === "darwin") assert.equal(main.buttons.at(-1), false);
    coordinator.release(7);
    if (platform === "darwin") assert.equal(main.buttons.at(-1), true);
    else assert.deepEqual(main.buttons, []);
    const mainUpdates = main.backgrounds.length;
    activeMain = undefined;
    coordinator.refresh();
    assert.equal(main.backgrounds.length, mainUpdates);
    assert.equal(quick.backgrounds.at(-1), platform === "darwin" ? "#00000000" : "#1a1a1a");
  });
}
