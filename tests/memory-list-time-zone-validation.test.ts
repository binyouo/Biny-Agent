/** 同批记忆的来源时区只需验证一次，分页、归档和失败边界仍从真实 SQLite 读取。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";
import type { MemoryOriginAnchor } from "../src/agent/context/memoryTypes.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-time-zones-"));
const storage = new MemoryStorage(root, { agentDir: root });
const originalFormatter = Intl.DateTimeFormat;
const counts = new Map<string, number>();
const anchors = [
  { messageId: "message-a", sentAt: "2026-09-01T01:00:00+08:00", timeZone: "Asia/Shanghai" },
  { messageId: "message-b", sentAt: "2026-09-01T01:00:00-04:00", timeZone: "America/New_York" },
  { messageId: "message-c", sentAt: "2026-09-01T01:00:00Z", timeZone: "UTC" },
  { messageId: "message-d", sentAt: "2026-09-01T01:00:00Z", timeZone: "US/Eastern" }
];
const expectedAnchors = [
  { messageId: "message-a", sentAt: "2026-08-31T17:00:00.000Z", timeZone: "Asia/Shanghai" },
  { messageId: "message-b", sentAt: "2026-09-01T05:00:00.000Z", timeZone: "America/New_York" },
  { messageId: "message-c", sentAt: "2026-09-01T01:00:00.000Z", timeZone: "UTC" },
  { messageId: "message-d", sentAt: "2026-09-01T01:00:00.000Z", timeZone: "US/Eastern" }
];
try {
  const ids: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    ids.push((await storage.writeEntry({
      content: `Source fact ${String(i)}`, originAnchors: anchors,
      threadId: i % 2 ? "thread-a" : "thread-b"
    }, { now: new Date(`2026-09-0${String(i + 1)}T00:00:00.000Z`) })).entry!.id);
  }
  const archived = await storage.archiveEntries(ids.slice(0, 3), "manual", { now: new Date("2026-09-10T00:00:00Z") });
  const database = new DatabaseSync(path.join(root, AGENT_DATABASE_FILE));
  try {
    const rawAnchors: MemoryOriginAnchor[] = [
      ...anchors,
      { messageId: "invalid-zone", sentAt: "2026-09-01T00:00:00Z", timeZone: "Not/A_Zone" },
      { messageId: "unknown-zone", sentAt: "2026-09-01T00:00:00Z", timeZone: "  " },
      { messageId: "invalid-time", sentAt: "not-a-time", timeZone: "Invalid/Not_Visited" },
      { ...anchors[0]!, timeZone: " Asia/Shanghai " }
    ];
    for (const table of ["memories", "memory_archive"]) {
      const rows = database.prepare(`SELECT id, metadata FROM ${table}`).all() as Array<{ id: string; metadata: string }>;
      for (const row of rows) database.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`).run(
        JSON.stringify({ ...JSON.parse(row.metadata) as object, originAnchors: rawAnchors }), row.id
      );
    }
  } finally { database.close(); }
  const expected = [...expectedAnchors,
    { messageId: "invalid-zone", sentAt: "2026-09-01T00:00:00.000Z", timeZone: "unknown" },
    { messageId: "unknown-zone", sentAt: "2026-09-01T00:00:00.000Z", timeZone: "unknown" }
  ];
  Intl.DateTimeFormat = new Proxy(originalFormatter, {
    construct(target, args, newTarget) {
      const zone = (args[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone;
      if (zone) counts.set(zone, (counts.get(zone) ?? 0) + 1);
      return Reflect.construct(target, args, newTarget) as Intl.DateTimeFormat;
    }
  });
  for (const options of [{}, { includeArchived: true }, { threadId: "thread-a", limit: 2, offset: 1 }]) {
    counts.clear();
    const page = await storage.listEntries(options);
    assert.equal(page.total, options.threadId ? 3 : options.includeArchived ? 8 : 5);
    assert.equal(page.entries.length, options.limit ?? page.total);
    for (const entry of page.entries) assert.deepEqual(entry.originAnchors, expected);
    for (const anchor of anchors) assert.equal(counts.get(anchor.timeZone), 1,
      "Repeated origins in one page must not construct a formatter per fact");
    assert.equal(counts.has("Invalid/Not_Visited"), false, "invalid timestamps are rejected before time-zone validation");
  }
  counts.clear();
  const archivePage = await storage.listArchivedEntries({ limit: 3 });
  assert.equal(archivePage.total, archived.archived);
  for (const entry of archivePage.entries) assert.deepEqual(entry.originAnchors, expected);
  for (const anchor of anchors) assert.equal(counts.get(anchor.timeZone), 1,
    "An archive page has its own validation scope, without reusing state from a previous read");
  counts.clear();
  assert.equal((await storage.listEntries({ limit: 0 })).entries.length, 0);
  await assert.rejects(storage.listEntries({ signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/u);
  assert.equal(counts.size, 0, "empty and cancelled reads must not validate time zones");
} finally {
  Intl.DateTimeFormat = originalFormatter;
  storage.close();
  await rm(root, { recursive: true, force: true });
}
console.log("memory list time-zone validation tests passed");
