/** Invalid public CLI arguments must use the concise error path without creating state. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const entry = path.resolve("src/cli/index.ts");
const root = await mkdtemp(path.join(os.tmpdir(), "biny-cli-argument-errors-"));
try {
  for (const options of [[], ["--json"]]) {
    const result = spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), entry,
      "activity", "summary", "monthly", "2026-10-04", ...options
    ], {
      cwd: root,
      env: { ...process.env, BINY_AGENT_DIR: path.join(root, "agent") },
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "summary kind 只支持 daily 或 weekly。");
  }
  assert.deepEqual(await readdir(root), [], "invalid arguments must not create runtime/config state");
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("CLI argument error tests passed");
