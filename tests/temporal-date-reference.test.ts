/** 日期引用从 CLI 生成后，原始消息索引仍保留其日期范围；篡改的引用不得解析。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";
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

  const sessionDir = path.join(root, "sessions", "project");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "thread-1.jsonl"), `${JSON.stringify({
    type: "user_message", messageId: "m1", content: `参考 ${json.reference} 讨论行程`,
    time: "2026-09-25T00:00:00.000Z", metadata: { sentAtTimeZone: "Asia/Shanghai" }
  })}\n`);
  const index = new TemporalMemoryIndex(root);
  await index.refreshAll();
  const hit = index.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues[0];
  assert.equal(hit?.date, "2026-10-03");
  assert.equal(hit?.endDate, "2026-10-05");
  assert.equal(hit?.messageId, "m1");
  index.close();
  const model = new TemporalMemoryIndex(root, { extractClues: async () => [] });
  await model.refreshAll();
  assert.equal(model.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues[0]?.messageId, "m1",
    "model enhancement must preserve signed date references");
  model.close();
  await rm(path.join(root, "date-reference.key"));
  const keyLost = new TemporalMemoryIndex(root);
  await keyLost.refreshAll();
  assert.equal(keyLost.queryClues({ startDate: "2026-10-05", endDate: "2026-10-06" }).clues.length, 0,
    "losing the signing key invalidates previously indexed references");
  keyLost.close();
  await writeFile(path.join(sessionDir, "thread-1.jsonl"), [
    { type: "user_message", messageId: "m1", content: `参考 ${json.reference} 讨论行程`, time: "2026-09-25T00:00:00.000Z" },
    { type: "user_message", messageId: "m3", content: "2026-11-01复盘", time: "2026-09-25T00:00:00.000Z" }
  ].map((value) => `${JSON.stringify(value)}\n`).join(""));
  const ordinary = new TemporalMemoryIndex(root);
  await ordinary.refreshAll();
  const ordinaryId = ordinary.queryClues({ startDate: "2026-11-01", endDate: "2026-11-02" }).clues[0]!.id;
  ordinary.ignoreClue(ordinaryId);
  await runCli("date-ref", "--from", "2026-10-03", "--to", "2026-10-06", "--time-zone", "Asia/Shanghai");
  await ordinary.refreshAll();
  assert.equal(ordinary.queryClues({ startDate: "2026-11-01", endDate: "2026-11-02" }).clues.length, 0,
    "creating a signing key must not reset ordinary clue ignore state");
  ordinary.close();
  const forgedInMessage = json.reference.replace("国庆安排", "2026-10-03");
  await writeFile(path.join(sessionDir, "thread-1.jsonl"), `${JSON.stringify({
    type: "user_message", messageId: "m2", content: forgedInMessage,
    time: "2026-09-25T00:00:00.000Z", metadata: { sentAtTimeZone: "Asia/Shanghai" }
  })}\n`);
  const forgedModel = new TemporalMemoryIndex(root, { extractClues: async () => [{ expression: "2026-10-03",
    date: "2026-10-03", endDate: null, time: null, offset: 2, quote: forgedInMessage }] });
  await forgedModel.refreshAll();
  assert.equal(forgedModel.queryClues({ startDate: "2026-10-03", endDate: "2026-10-04" }).clues.length, 0);
  forgedModel.close();
  console.log("temporal date reference tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
