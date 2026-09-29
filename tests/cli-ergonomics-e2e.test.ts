import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("dist/cli/index.js");
const root = await mkdtemp(path.join(os.tmpdir(), "biny-cli-ergonomics-"));
try {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Quick start:/u);
  assert.match(help.stdout, /biny run .*--headless/u);
  assert.match(help.stdout, /--theme/u);
  const bad = await run(["--theme", "missing"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /dark.*light/u);
  assert.doesNotMatch(bad.stderr, /\n\s+at /u);
  const typo = await run(["resum"]);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /resume/u);
  assert.match(typo.stderr, /--help/u);
  for (const args of [[], ["tui"], ["chat"], ["resume"], ["--theme", "light"], ["tui", "--theme", "light"]]) {
    const result = await run(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stdout, "", "rejected TUI launch must not emit control sequences");
    assert.match(result.stderr, /interactive terminal.*biny run/isu);
  }
  assert.deepEqual(await readdir(root), [], "help and rejected launches must not create runtime/config state");
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("CLI ergonomics e2e tests passed");

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root, env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
    signal: AbortSignal.timeout(10_000)
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += String(data); });
  child.stderr.on("data", (data) => { stderr += String(data); });
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
