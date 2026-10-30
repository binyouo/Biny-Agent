import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { exportAppearanceTheme, importAppearanceTheme } from "../src/appearance/editing.js";
import { registerThemeCommands } from "../src/cli/commands/theme.js";

const theme = { ...BUILTIN_PALETTES.win98!, displayName: "示例主题🙂" };
const json = exportAppearanceTheme(theme, theme.displayName);

test("UTF-8 BOM JSON imports the same complete theme as ordinary JSON", () => {
  assert.deepEqual(importAppearanceTheme("\uFEFF" + json), importAppearanceTheme(json));
});

test("a leading BOM before ordinary JSON whitespace and CRLF is accepted", () => {
  assert.deepEqual(importAppearanceTheme("\uFEFF \r\n\t" + json.replaceAll("\n", "\r\n")), importAppearanceTheme(json));
});

test("ordinary JSON and literal Lua remain unchanged", () => {
  assert.deepEqual(importAppearanceTheme(json), theme);
  const colors = Object.entries(theme.base_30).map(([key, value]) => key + ' = "' + value + '"').join(",");
  const lua = 'M.type = "light"; M.base_30 = {' + colors + '}; M.base_16 = {}; return M';
  const imported = importAppearanceTheme(lua);
  assert.equal(imported.type, "light");
  assert.deepEqual(imported.base_30, theme.base_30);
  assert.deepEqual(imported.base_16, {});
});

test("BOM input still uses the strict theme schema and rejects malformed JSON", () => {
  assert.throws(() => importAppearanceTheme("\uFEFF" + JSON.stringify({ ...theme, base_16: { base00: "#gggggg" } })), /base00/u);
  assert.throws(() => importAppearanceTheme("\uFEFF" + JSON.stringify({ ...theme, unexpected: true })), /unexpected/u);
  assert.throws(() => importAppearanceTheme("\uFEFF" + json.slice(0, -1)), SyntaxError);
});

test("only one initial BOM is removed, not invalid JSON whitespace or trailing bytes", () => {
  for (const input of ["\uFEFF\uFEFF" + json, " \uFEFF" + json, "\u00A0" + json, json + "\uFEFF"]) {
    assert.throws(() => importAppearanceTheme(input), SyntaxError);
  }
  assert.throws(() => importAppearanceTheme("\uFEFF" + " ".repeat(256 * 1024)), /256 KiB/u);
});

test("BOM characters inside a JSON string remain theme data", () => {
  const named = { ...theme, displayName: "左\uFEFF右" };
  assert.equal(importAppearanceTheme("\uFEFF" + JSON.stringify(named)).displayName, named.displayName);
});

test("theme validate accepts a BOM UTF-8 file without rewriting the input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-bom-validate-"));
  try {
    const input = path.join(root, "theme.json");
    const original = Buffer.from("\uFEFF" + json);
    await writeFile(input, original);
    const result = await command(["theme", "validate", input]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Valid light theme: 示例主题🙂/u);
    assert.deepEqual(await readFile(input), original);
    assert.deepEqual(await readdir(root), ["theme.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("theme import writes BOM input faithfully and preserves an existing output on retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-bom-import-"));
  try {
    const input = path.join(root, "theme.json"), output = path.join(root, "imported.json");
    await writeFile(input, "\uFEFF" + json);
    const imported = await command(["theme", "import", input, "--out", output]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(imported.stderr, "");
    const saved = await readFile(output, "utf8");
    assert.deepEqual(JSON.parse(saved), theme);
    assert.deepEqual(JSON.parse(imported.stdout), theme);
    assert.equal(saved.startsWith("\uFEFF"), false);
    const validated = await command(["theme", "validate", output, "--json"]);
    assert.equal(validated.code, 0, validated.stderr);
    assert.deepEqual(JSON.parse(validated.stdout), theme);
    const repeated = await command(["theme", "import", input, "--out", output]);
    assert.equal(repeated.code, 1);
    assert.equal(repeated.stdout, "");
    assert.match(repeated.stderr, /EEXIST/u);
    assert.equal(await readFile(output, "utf8"), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Exercise the real Commander registration, importer and filesystem operations.
// Only console output is captured; no application services or user data are loaded.
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
