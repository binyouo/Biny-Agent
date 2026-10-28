import { createHash } from "node:crypto";
import { placeholderTag } from "./crypto.js";
import { restorePlaceholders } from "./placeholders.js";

export interface KnownHit { start: number; end: number; kind: string; placeholder: string }
type SentSpan = Pick<KnownHit, "start" | "end" | "kind">;

interface StoreLimits { values: number; characters: number; sentEntries: number; sentSpans: number }
const defaultLimits: StoreLimits = { values: 50_000, characters: 8_000_000, sentEntries: 65_536, sentSpans: 200_000 };

/** 会话内有界保留原值与已发送文本的替换位置；请求自行捕获还原快照。 */
export class RedactionStore {
  private readonly values = new Map<string, { kind: string; value: string }>();
  private readonly known = new Map<string, Array<{ placeholder: string; kind: string; value: string }>>();
  private size = 0;
  private readonly sent = new Map<string, SentSpan[]>();
  private sentSize = 0;
  private retained?: Set<string>;

  constructor(private readonly scope = "", private readonly limits: StoreLimits = defaultLimits) {}

  register(kind: string, value: string): string {
    const placeholder = placeholderTag(kind, value, this.scope);
    const existing = this.values.get(placeholder);
    if (existing && existing.value !== value) throw new Error("Privacy placeholder collision.");
    if (existing) { this.values.delete(placeholder); this.values.set(placeholder, existing); }
    if (!existing) {
      if (value.length > this.limits.characters) throw new Error("Privacy value exceeds the session memory limit.");
      while (this.values.size >= this.limits.values || this.size + value.length > this.limits.characters) {
        let oldTag: string | undefined;
        for (const tag of this.values.keys()) { if (!this.retained?.has(tag)) { oldTag = tag; break; } }
        if (oldTag === undefined) throw new Error("Privacy request value limit reached.");
        const old = this.values.get(oldTag)!;
        this.values.delete(oldTag);
        this.size -= old.value.length;
        const prefix = old.value.slice(0, 4);
        const entries = this.known.get(prefix)?.filter(entry => entry.placeholder !== oldTag);
        if (entries?.length) this.known.set(prefix, entries);
        else this.known.delete(prefix);
      }
      this.values.set(placeholder, { kind, value });
      this.size += value.length;
      if (value.length >= 4) {
        const prefix = value.slice(0, 4);
        const entries = this.known.get(prefix) ?? [];
        entries.push({ placeholder, kind, value });
        entries.sort((a, b) => b.value.length - a.value.length);
        this.known.set(prefix, entries);
      }
    }
    this.retained?.add(placeholder);
    return placeholder;
  }

  /** 两次扫描结束前不能淘汰本次使用的值，避免发现后又遗忘造成漏遮。 */
  withRequest<T>(run: () => T): T {
    this.retained = new Set();
    try { return run(); } finally { this.retained = undefined; }
  }

  find(text: string): KnownHit[] {
    const hits: KnownHit[] = [];
    for (let i = 0; i + 4 <= text.length; i++) {
      const entry = this.known.get(text.slice(i, i + 4))?.find((candidate) => text.startsWith(candidate.value, i)
        && standsAlone(candidate.kind, text, i, i + candidate.value.length));
      if (!entry) continue;
      hits.push({ start: i, end: i + entry.value.length, kind: entry.kind, placeholder: entry.placeholder });
      i += entry.value.length - 1;
    }
    return hits;
  }

  snapshot(): Map<string, string> { return new Map([...this.values].map(([tag, entry]) => [tag, entry.value])); }
  restore(text: string): string { return restorePlaceholders(text, this.snapshot()); }
  sentSpans(text: string, context: string): SentSpan[] | undefined {
    const key = this.sentKey(text, context), spans = this.sent.get(key);
    if (spans) { this.sent.delete(key); this.sent.set(key, spans); }
    return spans;
  }
  rememberSent(text: string, context: string, spans: SentSpan[]): void {
    if (spans.length > this.limits.sentSpans) return;
    const key = this.sentKey(text, context);
    this.sentSize -= this.sent.get(key)?.length ?? 0;
    this.sent.delete(key);
    this.sent.set(key, spans);
    this.sentSize += spans.length;
    while (this.sent.size > this.limits.sentEntries || this.sentSize > this.limits.sentSpans) {
      const [oldKey, old] = this.sent.entries().next().value!;
      this.sent.delete(oldKey);
      this.sentSize -= old.length;
    }
  }
  private sentKey(text: string, context: string): string { return createHash("sha256").update(context).update("\0").update(text).digest("hex"); }
  get count(): number { return this.values.size; }
  clear(): void { this.values.clear(); this.known.clear(); this.sent.clear(); this.size = 0; this.sentSize = 0; }
}

function standsAlone(kind: string, text: string, start: number, end: number): boolean {
  const adjacent = `${text[start - 1] ?? ""}${text[end] ?? ""}`;
  if (kind === "PHONE" || kind === "BANK_CARD") return !/\d/u.test(adjacent);
  if (kind === "ID_CARD") return !/[A-Za-z0-9]/u.test(adjacent);
  return true;
}

export const defaultStore = new RedactionStore();
export function resetStoreForTest(): void { defaultStore.clear(); }
export function registeredCount(): number { return defaultStore.count; }
