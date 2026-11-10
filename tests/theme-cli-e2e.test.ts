import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("dist/cli/index.js");
const root = await mkdtemp(path.join(os.tmpdir(), "biny-theme-cli-"));
try {
  for (const action of ["list", "show", "validate", "import"]) {
    const result = await run(["theme", action]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command 'theme'/u);
  }
  for (const action of ["get", "set"]) {
    const args = ["config", action, "appearancePreference.darkTheme"];
    if (action === "set") args.push("tokyonight");
    const result = await run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown setting path|unknown|Unknown/u);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("Removed theme commands e2e tests passed");

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") }, signal: AbortSignal.timeout(10_000) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  child.stdin.end();
  return await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr })); });
}
