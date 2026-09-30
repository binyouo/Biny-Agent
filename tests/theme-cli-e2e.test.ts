import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILTIN_PALETTES } from "../src/appearance/catalog.js";
import { exportAppearanceTheme } from "../src/appearance/editing.js";

const cli = path.resolve("dist/cli/index.js");
const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-cli-"));
try {
  const listed = await run(["theme", "list", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).themes.length, 74);
  const shown = await run(["theme", "show", "win98", "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).skin, "win98");
  assert.equal(JSON.parse(shown.stdout).variables["--background"], BUILTIN_PALETTES.win98!.base_30.black);
  assert.deepEqual(await readdir(root), []);
  const file = path.join(root, "theme.json");
  await writeFile(file, exportAppearanceTheme(BUILTIN_PALETTES.tokyonight!, "Example"));
  const validated = await run(["theme", "validate", file]);
  assert.equal(validated.code, 0, validated.stderr);
  assert.match(validated.stdout, /Valid dark theme: Example/u);
  const output = path.join(root, "imported.json");
  const imported = await run(["theme", "import", file, "--out", output]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), JSON.parse(imported.stdout));
  for (const name of ["unknown-theme", "constructor", "__proto__"]) {
    const invalid = await run(["theme", "show", name, "--json"]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Unknown theme/u);
    assert.doesNotMatch(invalid.stderr, /\n\s+at /u);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("Theme CLI e2e tests passed");

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") }, signal: AbortSignal.timeout(10_000) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  child.stdin.end();
  return await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr })); });
}
