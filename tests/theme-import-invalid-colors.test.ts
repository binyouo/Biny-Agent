import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { importAppearanceTheme } from "../src/appearance/editing.js";

const base30 = `{${Object.entries(BUILTIN_PALETTES.win98!.base_30).map(([key, value]) => `${key} = "${value}"`).join(",")}}`;
const luaTheme = (syntax: string): string => `local M = {}; M.type = "light"; M.base_30 = ${base30}; M.base_16 = {${syntax}}; return M`;

for (const action of ["validate", "import"]) test(`theme ${action} rejects explicit invalid Lua syntax colors instead of saving them as absent`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-invalid-colors-"));
  try {
    const input = path.join(root, "theme.lua");
    const output = path.join(root, "theme.json");
    await writeFile(input, luaTheme('base00 = "#gggggg", base05 = "#ffffff"'));
    const result = await runCli(root, ["theme", action, input, "--out", output]);
    assert.equal(result.code, 1, `${action} must reject the invalid color; stdout: ${result.stdout}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /base00/u);
    assert.doesNotMatch(result.stderr, /\n\s+at /u);
    assert.deepEqual(await readdir(root), ["theme.lua"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON and Lua reject the same explicit invalid color literals without silently dropping optional fields", () => {
  for (const value of ["", "#fff", "#12345678", "#gggggg", "red", " #123456", "#123456 ", "#123456suffix"]) {
    const json = JSON.stringify({ ...BUILTIN_PALETTES.win98!, displayName: "Example", base_16: { base00: value } });
    assert.throws(() => importAppearanceTheme(json), /base00/u);
    for (const field of ["base00", '["base00"]', "['base00']"]) {
      for (const quote of ['"', "'"]) {
        assert.throws(() => importAppearanceTheme(luaTheme(`${field} = ${quote}${value}${quote}`)), /base00/u);
      }
    }
  }
  for (const literal of ['"red\'blue"', "'red\"blue'"]) {
    assert.throws(() => importAppearanceTheme(luaTheme(`base00 = ${literal}`)), /base00/u);
  }
  assert.throws(() => importAppearanceTheme(luaTheme('base00 = "#gggggg", base00 = "#123456"')), /重复/u);
  assert.throws(() => importAppearanceTheme(luaTheme('base00 = "#123456", base00 = "#gggggg"')), /重复/u);
});

test("valid partial Lua syntax colors survive CLI export and JSON reload, and existing output is preserved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-valid-colors-"));
  try {
    const input = path.join(root, "theme.lua");
    const output = path.join(root, "theme.json");
    await writeFile(input, luaTheme('["base00"] = "#AABBCC", -- optional syntax colors may be absent\n [\'base05\'] = \'#123456\''));
    const imported = await runCli(root, ["theme", "import", input, "--out", output]);
    assert.equal(imported.code, 0, imported.stderr);
    const saved = await readFile(output, "utf8");
    assert.deepEqual(JSON.parse(saved), JSON.parse(imported.stdout));
    const theme = importAppearanceTheme(saved);
    assert.equal(theme.type, "light");
    assert.deepEqual(theme.base_30, BUILTIN_PALETTES.win98!.base_30);
    assert.deepEqual(theme.base_16, { base00: "#AABBCC", base05: "#123456" });
    const validated = await runCli(root, ["theme", "validate", output, "--json"]);
    assert.equal(validated.code, 0, validated.stderr);
    assert.deepEqual(JSON.parse(validated.stdout), JSON.parse(saved));
    const repeated = await runCli(root, ["theme", "import", input, "--out", output]);
    assert.equal(repeated.code, 1);
    assert.equal(repeated.stdout, "");
    assert.match(repeated.stderr, /EEXIST/u);
    assert.equal(await readFile(output, "utf8"), saved);
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
