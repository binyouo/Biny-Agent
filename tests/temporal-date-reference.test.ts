/** CLI 日期引用保留范围和时区，篡改、无效范围与密钥丢失必须明确失效。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseDateReference } from "../src/session/dateReference.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-date-ref-"));
const runCli = async (...args: string[]): Promise<string> => (await promisify(execFile)("pnpm", ["exec", "tsx", "src/cli/index.ts", "memory", ...args], {
  cwd: process.cwd(), env: { ...process.env, BINY_AGENT_DIR: root }, timeout: 30_000
})).stdout;
try {
  const json = JSON.parse(await runCli("date-ref", "--from", "2026-10-03", "--to", "2026-10-06", "--time-zone", "Asia/Shanghai", "--label", "国庆安排", "--json")) as {
    reference: string; range: { startDate: string; endDate: string; timeZone: string };
  };
  assert.deepEqual(json.range, { startDate: "2026-10-03", endDate: "2026-10-06", timeZone: "Asia/Shanghai" });
  assert.match(json.reference, /^@\[国庆安排\]\(biny:\/\/date\//u);
  assert.equal((await runCli("date-ref", "--from", "2026-10-03", "--to", "2026-10-06", "--time-zone", "Asia/Shanghai", "--label", "国庆安排")).trim(), json.reference);
  assert.deepEqual(parseDateReference(json.reference, root)?.range, json.range);
  const forged = json.reference.replace(/\.[a-f0-9]{64}\)/u, `.${"0".repeat(64)})`);
  assert.throws(() => parseDateReference(forged, root), /invalid|signature|reference/iu);
  assert.throws(() => parseDateReference(json.reference.replace("国庆安排", "伪造安排"), root), /signature/iu);
  await assert.rejects(runCli("date-ref", "--from", "2026-10-06", "--to", "2026-10-03", "--time-zone", "Asia/Shanghai", "--json"));
  await assert.rejects(runCli("date-ref", "--from", "2026-02-30", "--to", "2026-03-02", "--time-zone", "Asia/Shanghai", "--json"));
  await assert.rejects(runCli("date-ref", "--from", "2026-10-03", "--to", "2026-10-06", "--time-zone", "Not/AZone", "--json"));

  await rm(path.join(root, "date-reference.key"));
  assert.throws(() => parseDateReference(json.reference, root), /key|signature|reference/iu);
  console.log("temporal date reference tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
