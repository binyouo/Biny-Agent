import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { exportAppearanceTheme, importAppearanceTheme, upsertAppearanceTheme } from "../src/appearance/editing.js";
import { completeSyntaxColors } from "../src/appearance/palette.js";
import { appearancePreferenceSchema, customAppearanceThemeSchema, DEFAULT_APPEARANCE, normalizeAppearancePreference } from "../src/appearance/preferences.js";
import { resolveAppearance } from "../src/appearance/resolve.js";
import { BASE16_KEYS } from "../src/appearance/types.js";

const theme = customAppearanceThemeSchema.parse({
  ...BUILTIN_PALETTES.win98!, name: "empty-syntax", displayName: "Empty syntax", base_16: {}
});
const base30 = `{${Object.entries(theme.base_30).map(([key, value]) => `${key} = "${value}"`).join(",")}}`;
const literalLua = (body = "", bracketKeys = false): string => bracketKeys
  ? `local M = {}; M.type = "light"; M["base_30"] = ${base30}; M["base_16"] = {${body}}; return M`
  : `local M = {}; M.type = "light"; M.base_30 = ${base30}; M.base_16 = {${body}}; return M`;

test("empty Base16 JSON themes already validate and roundtrip with syntax fallbacks", () => {
  assert.deepEqual(importAppearanceTheme(exportAppearanceTheme(theme, theme.displayName)), theme);
  const preference = upsertAppearanceTheme(structuredClone(DEFAULT_APPEARANCE), theme);
  assert.equal(appearancePreferenceSchema.safeParse(preference).success, true);
  const restored = normalizeAppearancePreference(JSON.parse(JSON.stringify(preference)));
  assert.deepEqual(restored, preference);
  const appearance = resolveAppearance(restored, "light", false);
  assert.equal(appearance.themeId, "custom:empty-syntax");
  assert.deepEqual(appearance.palette?.base_16, {});
  const syntax = completeSyntaxColors(theme);
  assert.deepEqual(Object.keys(syntax), [...BASE16_KEYS]);
  assert.equal(appearance.variables["--syntax-bg"], syntax.base00);
  assert.equal(appearance.variables["--syntax-fg"], syntax.base05);
});

test("literal Lua imports preserve empty Base16 tables regardless of whitespace or table key notation", () => {
  for (const bracketKeys of [false, true]) {
    for (const body of ["", "\n ", "--[[syntax uses defaults]]", "-- syntax uses defaults\n"]) {
      const imported = importAppearanceTheme(literalLua(body, bracketKeys), theme.name);
      assert.equal(imported.type, "light");
      assert.deepEqual(imported.base_30, theme.base_30);
      assert.deepEqual(imported.base_16, {});
      assert.deepEqual(importAppearanceTheme(exportAppearanceTheme(imported, imported.displayName)), imported);
      const saved = upsertAppearanceTheme(structuredClone(DEFAULT_APPEARANCE), imported);
      const restored = normalizeAppearancePreference(JSON.parse(JSON.stringify(saved)));
      const appearance = resolveAppearance(restored, "light", false);
      assert.equal(appearance.themeId, `custom:${theme.name}`);
      assert.deepEqual(appearance.palette?.base_16, {});
      assert.equal(appearance.variables["--syntax-bg"], completeSyntaxColors(imported).base00);
    }
  }
});

test("missing and unrecognized Lua tables and invalid required colors remain rejected", () => {
  for (const syntax of ["", "M.base_16 = colors()", "M.base_16 = { nested = {} }"]) {
    assert.throws(() => importAppearanceTheme(`M.type = "light"; M.base_30 = ${base30}; ${syntax}`), /base_16/u);
  }
  assert.throws(() => importAppearanceTheme("M.base_16 = {}"), /base_30/u);
  assert.throws(() => importAppearanceTheme("M.base_30 = {}; M.base_16 = {}"));
  assert.throws(() => importAppearanceTheme(literalLua().replace(`white = "${theme.base_30.white}"`, 'white = "#invalid"')));
  assert.throws(() => importAppearanceTheme(literalLua('base00 = "#ffffff", base00 = "#000000"')), /重复/u);
  assert.throws(() => importAppearanceTheme(literalLua('unknown = "#ffffff"')));
});

test("public theme CLI validates and exports Lua themes with empty syntax palettes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-empty-syntax-"));
  try {
    const input = path.join(root, "theme.lua");
    const output = path.join(root, "theme.json");
    await writeFile(input, literalLua());
    const validated = await runCli(root, ["theme", "validate", input]);
    assert.equal(validated.code, 0, validated.stderr);
    assert.match(validated.stdout, /Valid light theme: imported-theme/u);
    const imported = await runCli(root, ["theme", "import", input, "--out", output]);
    assert.equal(imported.code, 0, imported.stderr);
    const persisted: unknown = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(persisted, JSON.parse(imported.stdout));
    const parsed = customAppearanceThemeSchema.parse(persisted);
    assert.equal(parsed.type, "light");
    assert.deepEqual(parsed.base_30, theme.base_30);
    assert.deepEqual(parsed.base_16, {});
    const revalidated = await runCli(root, ["theme", "validate", output]);
    assert.equal(revalidated.code, 0, revalidated.stderr);
    assert.match(revalidated.stdout, /Valid light theme: imported-theme/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runCli(root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
    signal: AbortSignal.timeout(15_000)
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}
