import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { exportAppearanceTheme, importAppearanceTheme, upsertAppearanceTheme } from "../src/appearance/editing.js";
import { DEFAULT_APPEARANCE } from "../src/appearance/preferences.js";
import { resolveAppearance } from "../src/appearance/resolve.js";
import { registerThemeCommands } from "../src/cli/commands/theme.js";

function lua(typeAssignment: string, mode: "light" | "dark" = "light"): string {
  const palette = BUILTIN_PALETTES[mode === "light" ? "win98" : "tokyonight"]!;
  const colors = Object.entries(palette.base_30).map(([key, value]) => key + ' = "' + value + '"').join(",");
  return 'local M = {}; ' + typeAssignment + '; M["base_30"] = {' + colors + '}; M["base_16"] = {}; return M';
}

for (const [label, key] of [
  ["dot", "M.type"],
  ["bare", "type"],
  ["double quoted bracket", 'M["type"]'],
  ["single quoted bracket", "M['type']"],
  ["spaced bracket", 'M [ "type" ]']
] as const) {
  for (const mode of ["light", "dark"] as const) {
    test(`${label} ${mode} theme stays in its matching appearance mode`, () => {
      const imported = importAppearanceTheme(lua(key + " = '" + mode + "'", mode), "literal-key");
      assert.equal(imported.type, mode);
      const preference = upsertAppearanceTheme({ ...DEFAULT_APPEARANCE, darkTheme: "tokyonight", lightTheme: "win98" }, imported);
      const selected = mode === "light" ? "lightTheme" : "darkTheme";
      const other = mode === "light" ? "darkTheme" : "lightTheme";
      assert.equal(preference[selected], "custom:literal-key");
      assert.equal(preference[other], mode === "light" ? "tokyonight" : "win98");
      const appearance = resolveAppearance(preference, mode, false);
      assert.equal(appearance.themeId, "custom:literal-key");
      assert.equal(appearance.palette?.type, mode);
      assert.deepEqual(appearance.palette?.base_30, imported.base_30);
      assert.deepEqual(importAppearanceTheme(exportAppearanceTheme(imported, imported.displayName)), imported);
    });
  }
}

test("missing type retains the existing dark default and unrelated names do not select a mode", () => {
  for (const assignment of ["", 'M.prototype = "light"', 'M["not_type"] = "light"']) {
    assert.equal(importAppearanceTheme(lua(assignment)).type, "dark");
  }
});

test("comments containing bracket type assignments do not override the live declaration", () => {
  const source = lua('-- M["type"] = "dark"\n--[[ M[\'type\'] = \'dark\' ]]\nM["type"] = "light"');
  assert.equal(importAppearanceTheme(source).type, "light");
});

for (const key of ['M["type"]', "M['type']"]) {
  test(`theme validate/import preserves light mode for ${key}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-lua-type-"));
    try {
      const input = path.join(root, "light.lua"), output = path.join(root, "imported.json");
      const original = lua(key + ' = "light"');
      await writeFile(input, original);
      const validated = await command(["theme", "validate", input]);
      assert.equal(validated.code, 0, validated.stderr);
      assert.match(validated.stdout, /Valid light theme: imported-theme/u);
      const imported = await command(["theme", "import", input, "--out", output]);
      assert.equal(imported.code, 0, imported.stderr);
      const saved = await readFile(output, "utf8");
      assert.equal(JSON.parse(saved).type, "light");
      assert.deepEqual(JSON.parse(saved), JSON.parse(imported.stdout));
      assert.equal(importAppearanceTheme(saved).type, "light");
      assert.equal(await readFile(input, "utf8"), original);
      const repeated = await command(["theme", "import", input, "--out", output]);
      assert.equal(repeated.code, 1);
      assert.equal(repeated.stdout, "");
      assert.match(repeated.stderr, /EEXIST/u);
      assert.equal(await readFile(output, "utf8"), saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

// Real command registration and filesystem; only console output is captured.
async function command(args: string[]) {
  const previousCode = process.exitCode;
  const previousLog = console.log, previousError = console.error;
  const stdout: string[] = [], stderr: string[] = [];
  process.exitCode = 0;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try {
    const program = new Command().exitOverride();
    registerThemeCommands(program);
    await program.parseAsync(args, { from: "user" });
    return { code: process.exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exitCode = previousCode;
  }
}
