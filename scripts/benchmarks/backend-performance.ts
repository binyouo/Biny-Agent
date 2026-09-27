/** Run with: pnpm exec tsx scripts/benchmarks/backend-performance.ts */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RuntimeEventAuthority } from "../../src/runtime/RuntimeAuthority.js";
import { buildSessionTree, type SessionCatalogItem, type SessionTreeNode } from "../../src/session/catalog.js";
import { listSessionSummaries } from "../../src/session/events.js";
import { createSessionFile, ensureAgentDirs } from "../../src/session/store.js";

function median(run: () => void, repetitions = 15): number {
  for (let i = 0; i < 3; i++) run();
  const times: number[] = [];
  for (let i = 0; i < repetitions; i++) { const start = performance.now(); run(); times.push(performance.now() - start); }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

// 保留旧的路径集合复制算法作为隔离基线；这里只比较已按序的单链遍历。
function recursiveChain(items: SessionCatalogItem[]): SessionTreeNode {
  const build = (index: number, ancestors: ReadonlySet<string>): SessionTreeNode => {
    const item = items[index]!;
    const next = new Set(ancestors).add(item.id);
    return { session: item, children: index + 1 < items.length && !next.has(items[index + 1]!.id) ? [build(index + 1, next)] : [] };
  };
  return build(0, new Set());
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "biny-backend-benchmark-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(base, "agent");
const root = path.join(base, "workspace");
await fs.mkdir(root);
let authority: RuntimeEventAuthority | undefined;
try {
  await ensureAgentDirs(root);
  const row = `${JSON.stringify({ type: "user_message", content: "x".repeat(1024) })}\n`;
  for (let i = 0; i < 64; i++) await createSessionFile(root, `history-${i}`, Buffer.from(row.repeat(500)));
  const coldStart = performance.now();
  const cold = await listSessionSummaries(root);
  const coldMs = performance.now() - coldStart;
  const warmTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    assert.deepEqual(await listSessionSummaries(root), cold);
    warmTimes.push(performance.now() - start);
  }

  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const db = authority.databaseHandle();
  const indexSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runtime_events_toolcall_idx'").get() as { sql: string }).sql;
  db.exec("DROP INDEX runtime_events_toolcall_idx");
  const insert = db.prepare(`INSERT INTO runtime_events (event_id, workspace_id, session_id, invocation_id, run_id, turn_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, 's', 'i', 'r', 't', ?, 'session.tool_call', ?, '2026-01-01')`);
  db.exec("BEGIN");
  for (let i = 0; i < 120000; i++) insert.run(String(i), authority.workspaceId, i + 1, JSON.stringify({ toolCallId: `tool-${i}` }));
  db.exec("COMMIT");
  const sizes = [1, 8, 32];
  const writeBatch = (): void => {
    db.exec("BEGIN");
    for (let i = 120000; i < 121000; i++) insert.run(String(i), authority!.workspaceId, i + 1, JSON.stringify({ toolCallId: `tool-${i}` }));
    db.exec("ROLLBACK");
  };
  const unindexedWriteMs = median(writeBatch);
  const before = sizes.map(count => {
    const ids = Array.from({ length: count }, (_, i) => `tool-${i * 101}`);
    const query = db.prepare(`SELECT * FROM runtime_events WHERE workspace_id = ?
      AND event_type IN ('session.tool_call', 'session.tool_execution', 'session.tool_result')
      AND json_extract(payload_json, '$.toolCallId') IN (${ids.map(() => "?").join(",")}) ORDER BY sequence`);
    const run = (): unknown[] => query.all(authority!.workspaceId, ...ids).map(row => JSON.parse(String(row.payload_json)) as unknown);
    return { count, ids, expected: run(), ms: median(() => { run(); }) };
  });
  const sizeBefore = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
  const migrationStart = performance.now();
  db.exec(indexSql);
  const migrationMs = performance.now() - migrationStart;
  const indexBytes = (Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) - sizeBefore)
    * Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
  const queries = before.map(({ count, ids, expected, ms }) => {
    assert.deepEqual(authority!.readToolEvents(ids).map(event => event.payload), expected);
    return { ids: count, unindexedMedianMs: ms, indexedMedianMs: median(() => { authority!.readToolEvents(ids); }) };
  });
  const items: SessionCatalogItem[] = Array.from({ length: 2000 }, (_, i) => ({
    id: String(i), fileName: `${i}.jsonl`, rootSessionId: "0", parentSessionId: i ? String(i - 1) : undefined,
    hasChildren: i < 1999,
    summary: { fileName: `${i}.jsonl`, firstUserMessage: "", lastAssistantMessage: "", createdAt: "2026-01-01", updatedAt: "2026-01-01", eventCount: 1 }
  }));
  console.log(JSON.stringify({
    node: process.version, platform: `${process.platform}-${process.arch}`,
    note: "Synthetic local measurements; not Desktop latency. Tree baseline omits adjacency construction and sorting; current measurement includes them.",
    summaries: { sessions: 64, eventsPerSession: 500, coldMs, warmMedianMs: warmTimes.sort((a, b) => a - b)[2] },
    sql: { rows: 120000, queries, migrationMs, indexBytes, writes: { batchRows: 1000, unindexedMedianMs: unindexedWriteMs, indexedMedianMs: median(writeBatch), note: "transaction rolled back; excludes commit fsync" } },
    tree: { nodes: 2000, recursiveSetCopyMedianMs: median(() => { recursiveChain(items); }), iterativeMedianMs: median(() => { buildSessionTree(items); }) }
  }, null, 2));
} finally {
  authority?.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(base, { recursive: true, force: true });
}
