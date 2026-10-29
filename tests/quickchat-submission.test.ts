/** Mount the production component; substitute only IPC and presentation boundaries. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const scenario of ["unknown", "known", "preparefail", "unmount", "queue", "legacy", "direct", "receipt", "early-failure", "receipt-failure"]) {
  test(`QuickChat submission ownership: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ["tests/fixtures/quickchat-submission.mjs", scenario], {
      encoding: "utf8",
      timeout: 30_000,
      env: process.env
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
