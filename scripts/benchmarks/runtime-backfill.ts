/** Run with: pnpm exec tsx scripts/benchmarks/runtime-backfill.ts */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { projectSessionsDir } from "../../src/config/paths.js";
import { RuntimeEventAuthority } from "../../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../../src/session/events.js";
import { createSessionFile, ensureAgentDirs } from "../../src/session/store.js";

const base = await fs.mkdtemp(path.join(os.tmpdir(), "biny-runtime-benchmark-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(base, "agent");
const row = `${JSON.stringify({ type: "user_message", content: "x".repeat(80) })}\n`;

async function createWorkspace(name: string): Promise<string> {
  const root = await fs.realpath(path.join(base, name));
  await ensureAgentDirs(root);
  return root;
}

async function open(root: string, backfillLegacySessions: boolean): Promise<number> {
  const start = performance.now();
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions });
  authority.close();
  return performance.now() - start;
}

try {
  await fs.mkdir(path.join(base, "large"));
  const large = await createWorkspace("large");
  const file = await createSessionFile(large, "large", Buffer.from(row.repeat(10_000)));
  const firstMs = await open(large, true);
  const warmMs: number[] = [];
  const appendMs: number[] = [];
  const parseMs: number[] = [];
  for (let i = 0; i < 4; i++) {
    warmMs.push(await open(large, true));
    await fs.appendFile(file, row);
    const parseStart = performance.now();
    await readSessionEvents(file);
    parseMs.push(performance.now() - parseStart);
    appendMs.push(await open(large, true));
  }

  await fs.mkdir(path.join(base, "many"));
  const many = await createWorkspace("many");
  const directory = projectSessionsDir(many);
  for (let i = 0; i < 500; i++) await fs.writeFile(path.join(directory, `s-${i}.jsonl`), row);
  const manyFirstMs = await open(many, true);
  const manyWarmMs: number[] = [];
  for (let i = 0; i < 4; i++) manyWarmMs.push(await open(many, true));

  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    note: "Synthetic workspace timings; startup includes filesystem validation and SQLite migration checks.",
    singleSession: { initialEvents: 10_000, firstMs, warmMs, parseOnlyMs: parseMs, appendAndReconcileMs: appendMs },
    manySessions: { sessions: 500, firstMs: manyFirstMs, warmMs: manyWarmMs }
  }, null, 2));
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(base, { recursive: true, force: true });
}
