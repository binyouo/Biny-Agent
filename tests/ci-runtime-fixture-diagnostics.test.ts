import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixtureScript = fileURLToPath(new URL("../scripts/dependency-patches/runtime-timing-fixtures.mjs", import.meta.url));

test("runtime timing diagnostics identify the failing fixture and preserve its error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-fixture-diagnostics-"));
  try {
    const runtimePath = path.join(directory, "controlled-runtime.mjs");
    // The existing override avoids importing Code Mode or starting its workers.
    await writeFile(runtimePath, `
let calls = 0;
export async function run() {
  calls += 1;
  if (calls === 1) {
    throw Object.assign(new Error("expected first-fixture timeout"), {
      code: "RUN_TIMEOUT", details: { timeoutMs: 100 }
    });
  }
  throw Object.assign(new Error("second-fixture-original-sentinel"), {
    name: "FixtureSentinelError", code: "FIXTURE_SENTINEL_2"
  });
}
export function createRunner() {
  throw new Error("unexpected createRunner call");
}
`, "utf8");
    const child = spawnSync(process.execPath, [fixtureScript, "--runtime", runtimePath], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024
    });
    assert.equal(child.error, undefined, "fixture child must finish before the timeout");
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /FixtureSentinelError/u);
    assert.match(child.stderr, /second-fixture-original-sentinel/u);
    assert.match(child.stderr, /FIXTURE_SENTINEL_2/u);
    assert.equal(child.stdout, "", "a failing fixture must not emit passed JSON");
    assert.doesNotMatch(child.stderr, /\[runtime-timing-fixtures\] Failed fixture: stock wall default remains bounded/u);
    // Tests-only baseline reaches this assertion with the original error intact.
    assert.match(child.stderr, /\[runtime-timing-fixtures\] Failed fixture: host await exceeds VM budget without replay/u);
    assert.equal(child.stderr.match(/\[runtime-timing-fixtures\] Failed fixture: host await exceeds VM budget without replay/gu)?.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
