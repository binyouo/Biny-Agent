import { redactionWanted, type RedactionSettings } from "./settings.js";
import { findRuleHits } from "./rules.js";
import { defaultStore, type RedactionStore } from "./store.js";
import { placeholderPattern } from "./crypto.js";

export interface MaskHit { kind: string; placeholder: string; length: number }
export interface MaskResult { text: string; hits: MaskHit[] }
export interface MaskSegment { kind: string; original: string; masked: string; start: number; end: number }
export interface MaskTextResult extends MaskResult { segments: MaskSegment[] }
interface Span { start: number; end: number; kind: string; placeholder?: string }

function replaceSpans(text: string, spans: Span[], put: (kind: string, value: string) => string): MaskTextResult {
  const placeholders = [...text.matchAll(placeholderPattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const sorted = spans.filter((s) => !placeholders.some((p) => s.start < p.end && s.end > p.start)).sort((a, b) => a.start - b.start || b.end - a.end || Number(!!b.placeholder) - Number(!!a.placeholder));
  let out = "", last = 0;
  const hits: MaskHit[] = [], segments: MaskSegment[] = [];
  for (const span of sorted) {
    if (span.start < last) continue;
    const value = text.slice(span.start, span.end);
    const placeholder = put(span.kind, value);
    if (placeholder === value) continue;
    out += text.slice(last, span.start) + placeholder;
    last = span.end;
    hits.push({ kind: span.kind, placeholder, length: [...value].length });
    segments.push({ kind: span.kind, original: value, masked: placeholder, start: span.start, end: span.end });
  }
  return { text: out + text.slice(last), hits, segments };
}

export function maskText(text: string, settings: RedactionSettings, store: RedactionStore = defaultStore): MaskTextResult {
  if (!redactionWanted(settings)) return { text, hits: [], segments: [] };
  return replaceSpans(text, [...findRuleHits(text), ...store.find(text)], (kind, value) => store.register(kind, value));
}

/** 历史内容复用首次发送时的替换位置；字段语义不同的同文不能共享决定。 */
export function maskSentText(text: string, context: string, store: RedactionStore, discover: () => MaskTextResult): MaskTextResult {
  const prior = store.sentSpans(text, context);
  if (prior) return replaceSpans(text, prior, (kind, value) => store.register(kind, value));
  const result = discover();
  store.rememberSent(text, context, result.segments.map(({ start, end, kind }) => ({ start, end, kind })));
  return result;
}

export function restore(source: string): string { return defaultStore.restore(source); }
