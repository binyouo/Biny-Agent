import { randomUUID } from "node:crypto";
import type { MaskJsonSegment } from "./json.js";

export interface MaskRecordSummary {
  id: string;
  time: string;
  provider: string;
  model: string;
  sessionId?: string;
  operation: string;
  count: number;
  uniqueValues: number;
  requestBytes?: number;
  kinds: Record<string, number>;
}
export interface MaskRecord extends MaskRecordSummary {
  preview: MaskJsonSegment[];
  truncated: boolean;
}
export interface MaskingOverview {
  records: MaskRecordSummary[];
  summary: { total: number; requests: number; byKind: Record<string, number>; byProvider: Record<string, number> };
}

// 详情包含原文，只在请求所属进程内存中保留；列表不传输正文。
let records: Array<{ record: MaskRecord; size: number }> = [];
export function recordMask(input: {
  provider: string; model: string; sessionId?: string; operation?: string; segments: readonly MaskJsonSegment[];
  preview?: readonly MaskJsonSegment[]; requestBytes?: number;
}): MaskRecord | undefined {
  const kinds: Record<string, number> = {};
  let count = 0;
  for (const group of input.segments) for (const segment of group.segments) {
    count++; kinds[segment.kind] = (kinds[segment.kind] ?? 0) + 1;
  }
  // 未命中任何敏感内容的请求同样值得观测：只要还有可阅读的请求正文就保留记录，只是计数为 0。
  const groups = input.preview ?? input.segments;
  if (!count && !groups.some((group) => group.original)) return undefined;
  let budget = 1_000_000, truncated = false;
  const retained = new Map<number, MaskJsonSegment>();
  // 预算不足时优先保留命中段，最终仍按原请求顺序展示。
  const order = groups.map((group, index) => ({ group, index })).sort((a, b) => Number(b.group.segments.length > 0) - Number(a.group.segments.length > 0));
  for (const { group, index } of order) {
    if (budget <= 0 || retained.size >= 2000) { truncated = true; break; }
    const complete = { ...group, segments: group.segments.map(segment => ({ ...segment })) };
    const completeSize = JSON.stringify(complete).length;
    if (completeSize <= budget) {
      retained.set(index, complete);
      budget -= completeSize;
      continue;
    }
    const limit = Math.floor(budget / 4);
    const original = group.original.slice(0, limit), masked = group.masked.slice(0, limit);
    const segments = group.segments.filter((s) => s.end <= original.length && masked.includes(s.masked)).map((s) => ({ ...s }));
    const incomplete = original.length !== group.original.length || masked.length !== group.masked.length || segments.length !== group.segments.length;
    const entry = { path: group.path, role: group.role, original, masked, segments, truncated: incomplete };
    budget -= JSON.stringify(entry).length;
    retained.set(index, entry);
    truncated ||= incomplete;
  }
  const preview = [...retained].sort(([a], [b]) => a - b).map(([, group]) => group);
  const record: MaskRecord = {
    id: randomUUID(), time: new Date().toISOString(), provider: input.provider, model: input.model,
    sessionId: input.sessionId, operation: input.operation ?? "agent", count, kinds, preview, truncated,
    uniqueValues: new Set(input.segments.flatMap(group => group.segments.map(segment => segment.masked))).size,
    requestBytes: input.requestBytes
  };
  // 同时计入摘要、字段路径与命中片段，避免小正文或长元数据绕过预算。
  records.unshift({ record, size: JSON.stringify(record).length * 2 });
  let total = 0;
  records = records.filter((entry) => { total += entry.size; return total <= 8_000_000; });
  return record;
}

function selected(sessionIds?: readonly string[]): MaskRecord[] {
  return records.map(({ record }) => record).filter((r) => sessionIds === undefined || (r.sessionId !== undefined && sessionIds.includes(r.sessionId)));
}
export function maskingOverview(sessionIds?: readonly string[]): MaskingOverview {
  const current = selected(sessionIds);
  const byKind: Record<string, number> = {}, byProvider: Record<string, number> = {};
  let total = 0;
  for (const record of current) {
    total += record.count;
    for (const [kind, count] of Object.entries(record.kinds)) byKind[kind] = (byKind[kind] ?? 0) + count;
    byProvider[record.provider] = (byProvider[record.provider] ?? 0) + record.count;
  }
  return {
    records: current.map(({ preview: _preview, truncated: _truncated, ...summary }) => ({ ...summary, kinds: { ...summary.kinds } })),
    summary: { total, requests: current.length, byKind, byProvider }
  };
}
export function maskingDetail(id: string, sessionIds?: readonly string[]): MaskRecord | undefined {
  return structuredClone(selected(sessionIds).find((r) => r.id === id));
}
export function clearMaskRecords(sessionIds?: readonly string[]): void {
  const ids = new Set(selected(sessionIds).map((r) => r.id));
  records = records.filter(({ record }) => !ids.has(record.id));
}
export function resetMaskRecordsForTest(): void { records = []; }
