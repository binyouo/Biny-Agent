/**
 * Session 解析缓存。
 *
 * 按真实路径及文件身份、大小、修改时间、状态变更时间缓存解析结果。
 * 指纹变化即失效；路径和文件描述符的安全校验仍由读取入口执行。
 * 列表摘要使用独立缓存，避免扫描历史淘汰活动会话的完整事件。
 *
 * 进程内单机缓存：桌面主进程、RuntimeHost 等各自进程各持一份，不跨进程共享。
 */
import type { SessionEvent } from "./recorder.js";

/** 缓存条数上限：大量小 session 时由它封顶。 */
const maxCachedSessions = 32;
/** 按源字节估算的权重上限；额外保留的验证原文另计一次，限制大 session 的缓存占用。 */
const maxCachedSourceBytes = 64 * 1024 * 1024;

/** 命中判断用的文件指纹；append-only 下 (dev, ino, size, mtimeMs, ctimeMs) 不变即内容不变。 */
export interface SessionFileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
}

interface SessionParseCacheEntry {
  fingerprint: SessionFileFingerprint;
  events: SessionEvent[];
  source?: SessionParseSource;
  /** 以源字节数计的权重，用于按内存上限淘汰。 */
  weight: number;
}

/** Only complete, validated byte snapshots may establish an append prefix. */
export interface SessionParseSource {
  bytes: Buffer;
  newlineCount: number;
}

// Map 的插入顺序即 LRU 顺序：命中时摘除重插到尾部，淘汰从头部开始。
const cache = new Map<string, SessionParseCacheEntry>();
let cachedSourceBytes = 0;

/** A stale entry is only a candidate: the reader must verify its entire prefix. */
export function previousSessionParse(filePath: string): Readonly<SessionParseCacheEntry> | undefined {
  return cache.get(filePath);
}

export function sessionFileFingerprint(stat: SessionFileFingerprint): SessionFileFingerprint {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

export function lookupSessionEvents(filePath: string, fingerprint: SessionFileFingerprint): SessionEvent[] | undefined {
  const entry = cache.get(filePath);
  if (!entry) return undefined;
  if (!sameSessionFingerprint(entry.fingerprint, fingerprint)) {
    // append-only：指纹一旦过期就永远不会再命中，顺手摘掉，避免陈旧条目白占内存。
    cache.delete(filePath);
    cachedSourceBytes -= entry.weight;
    return undefined;
  }
  // 命中：提到尾部，标记为最近使用。
  cache.delete(filePath);
  cache.set(filePath, entry);
  return entry.events;
}

function store(filePath: string, fingerprint: SessionFileFingerprint, events: SessionEvent[], source?: SessionParseSource): void {
  // Charge retained source bytes separately from the existing parsed-event weight.
  const weight = Math.max(0, fingerprint.size) + (source?.bytes.length ?? 0);
  const existing = cache.get(filePath);
  if (existing) {
    cachedSourceBytes -= existing.weight;
    cache.delete(filePath);
  }
  cache.set(filePath, { fingerprint, events, source, weight });
  cachedSourceBytes += weight;
  while (cache.size > maxCachedSessions || cachedSourceBytes > maxCachedSourceBytes) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    if (evicted) cachedSourceBytes -= evicted.weight;
    cache.delete(oldest.value);
  }
}

/**
 * 命中即返回缓存的事件数组；未命中调用 `load()` 解析并按需缓存。
 *
 * `load` 返回 `complete: false` 表示这次解析没有看全文件（例如超限只读了尾部），结果只供本次
 * 使用、不进缓存——否则"被截断的视角"会被误发给需要完整事件的读取方（如 resume 的严格校验）。
 *
 * 返回的事件数组在多个调用方之间共享，调用方不得修改它（replay/摘要都只读它）。
 */
export function cachedSessionEvents(
  filePath: string,
  fingerprint: SessionFileFingerprint,
  load: () => { events: SessionEvent[]; complete: boolean; source?: SessionParseSource }
): SessionEvent[] {
  const cached = lookupSessionEvents(filePath, fingerprint);
  if (cached) return cached;
  const { events, complete, source } = load();
  if (complete) store(filePath, fingerprint, events, source);
  return events;
}

/** 测试与手动失效用：清空整个缓存。 */
export function clearSessionParseCache(): void {
  cache.clear();
  cachedSourceBytes = 0;
}

export function sameSessionFingerprint(left: SessionFileFingerprint, right: SessionFileFingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.dev === right.dev && left.ino === right.ino;
}
