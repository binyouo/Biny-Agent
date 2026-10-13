import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

type Preference = "system" | "light" | "dark";
interface Snapshot {
  themePreference: Preference;
  appearancePreference: { marker: string };
}
interface WindowBoundary {
  isDestroyed(): boolean;
  getTitle(): string;
  setBackgroundColor(color: string): void;
  setWindowButtonVisibility(visible: boolean): void;
}
interface Resolved {
  mode: "light" | "dark";
  skin: "default" | "win98";
  variables: Record<string, string>;
}
const root = process.env.BINY_WINDOW_APPEARANCE_SOURCE_ROOT ?? process.cwd();
const source = readFileSync(path.join(root, "src/desktop/electron/main/window.ts"), "utf8");
const file = ts.createSourceFile("window.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const matches = file.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "syncDesktopWindowAppearance");
assert.equal(matches.length, 1, "extract the actual exported helper exactly once");
const original = matches[0]!;
assert.ok(original.body && original.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const declaration = ts.factory.updateFunctionDeclaration(original, undefined, original.asteriskToken,
  original.name, original.typeParameters, original.parameters, original.type, original.body);
const extracted = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, file);
const compiled = ts.transpileModule(extracted, {
  fileName: "appearance-helper.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

function boundary(title: string, destroyed = false) {
  const backgrounds: string[] = [];
  const buttons: boolean[] = [];
  const live = (): void => { assert.equal(destroyed, false, "destroyed windows must not be touched"); };
  const window: WindowBoundary = {
    isDestroyed: () => destroyed,
    getTitle: () => { live(); return title; },
    setBackgroundColor: color => { live(); backgrounds.push(color); },
    setWindowButtonVisibility: visible => { live(); buttons.push(visible); }
  };
  return { window, backgrounds, buttons };
}

function fixture(platform: "darwin" | "linux" | "win32", resolved: Resolved, snapshot: Snapshot,
  systemDark: boolean, initialTheme: Preference = "light", mainPresent = true) {
  const main = boundary("Biny");
  const quick = boundary("Biny Quick Chat");
  const unrelated = boundary("Inspector");
  const destroyed = boundary("Biny Quick Chat", true);
  const writes: Preference[] = [];
  const resolutions: unknown[][] = [];
  let themeSource = initialTheme;
  const context = createContext({
    BrowserWindow: { getAllWindows: () => [main.window, quick.window, unrelated.window, destroyed.window] },
    nativeTheme: {
      get themeSource() { return themeSource; },
      set themeSource(value: Preference) { writes.push(value); themeSource = value; },
      shouldUseDarkColors: systemDark
    },
    resolveAppearance: (preference: Snapshot["appearancePreference"], mode: Preference, dark: boolean) => {
      resolutions.push([preference, mode, dark]); return resolved;
    },
    process: { platform },
    mainWindow: mainPresent ? main.window : undefined,
    snapshot
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(compiled.outputText, { filename: "actual-window-appearance-helper.js" }).runInContext(context, { timeout: 1_000 });
  const invoke = (): void => {
    new Script("syncDesktopWindowAppearance(mainWindow, snapshot)").runInContext(context, { timeout: 1_000 });
  };
  return { main, quick, unrelated, destroyed, writes, resolutions, invoke };
}

for (const platform of ["darwin", "linux", "win32"] as const) {
  test("actual appearance helper preserves " + platform + " backgrounds and window scope", () => {
    for (const [mode, palette, systemDark, themePreference] of [
      ["light", undefined, false, "system"], ["dark", undefined, true, "system"],
      ["light", undefined, true, "light"], ["dark", undefined, false, "dark"],
      ["light", "#c1d2e3", false, "light"], ["dark", "#123456", true, "dark"]
    ] as const) {
      const snapshot: Snapshot = { themePreference, appearancePreference: { marker: mode } };
      const resolved: Resolved = { mode, skin: palette ? "win98" : "default",
        variables: palette ? { "--background": palette } : {} };
      const h = fixture(platform, resolved, snapshot, systemDark);
      h.invoke();
      const expected = platform === "darwin" ? "#00000000" : palette ?? (mode === "dark" ? "#1a1a1a" : "#f5f5f5");
      assert.deepEqual(h.main.backgrounds, [expected]);
      assert.deepEqual(h.quick.backgrounds, [expected]);
      assert.deepEqual(h.unrelated.backgrounds, []);
      assert.deepEqual(h.destroyed.backgrounds, []);
      assert.deepEqual(h.main.buttons, platform === "darwin" ? [resolved.skin === "default"] : []);
      for (const window of [h.quick, h.unrelated, h.destroyed]) assert.deepEqual(window.buttons, []);
      assert.deepEqual(h.resolutions, [[snapshot.appearancePreference, snapshot.themePreference, systemDark]]);
      assert.deepEqual(h.writes, snapshot.themePreference === "light" ? [] : [snapshot.themePreference]);
      // Reapplying the same preference must still update windows, without another themeSource write.
      h.invoke();
      assert.equal(h.main.backgrounds.length, 2);
      assert.deepEqual(h.writes, snapshot.themePreference === "light" ? [] : [snapshot.themePreference]);
    }
  });
}

test("actual appearance helper updates Quick Chat without a main window", () => {
  const snapshot: Snapshot = { themePreference: "dark", appearancePreference: { marker: "no-main" } };
  const h = fixture("darwin", { mode: "dark", skin: "default", variables: {} }, snapshot, true, "dark", false);
  h.invoke();
  assert.deepEqual(h.main.backgrounds, []);
  assert.deepEqual(h.quick.backgrounds, ["#00000000"]);
  assert.deepEqual(h.main.buttons, []);
  assert.deepEqual(h.quick.buttons, []);
  assert.deepEqual(h.writes, []);
});
