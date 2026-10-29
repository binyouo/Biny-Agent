import { restoreJson } from "./json.js";

type JsonObject = Record<string, unknown>;
interface Field { owner: JsonObject; key: string; channel: string; json: boolean }
interface Event { lines: string[]; data?: JsonObject; pending: number; size: number }
interface Pending { text: string; event: Event; field: Field }

function obj(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function fields(data: JsonObject): Field[] {
  const out: Field[] = [];
  const add = (owner: JsonObject | undefined, key: string, channel: string, json = false): void => {
    if (owner && typeof owner[key] === "string") out.push({ owner, key, channel, json });
  };
  if (Array.isArray(data.choices)) for (const choice of data.choices) {
    const c = obj(choice), delta = obj(c?.delta), prefix = `choice:${String(c?.index ?? 0)}`;
    add(delta, "content", `${prefix}:text`);
    add(delta, "reasoning_content", `${prefix}:reasoning`);
    add(delta, "reasoning", `${prefix}:reasoning`);
    if (Array.isArray(delta?.tool_calls)) for (const call of delta.tool_calls) {
      const t = obj(call);
      add(obj(t?.function), "arguments", `${prefix}:tool:${String(t?.index ?? 0)}`, true);
    }
    add(obj(delta?.function_call), "arguments", `${prefix}:function`, true);
  }
  if (data.type === "content_block_delta") {
    const delta = obj(data.delta), prefix = `block:${String(data.index)}`;
    add(delta, "text", `${prefix}:text`);
    add(delta, "partial_json", `${prefix}:json`, true);
  }
  if (typeof data.type === "string" && data.type.startsWith("response.") && data.type.endsWith(".delta")) {
    add(data, "delta", `${data.type}:${String(data.item_id ?? data.output_index)}:${String(data.content_index ?? data.summary_index ?? 0)}`, data.type.includes("function_call_arguments"));
  }
  if (Array.isArray(data.candidates)) for (const candidate of data.candidates) {
    const c = obj(candidate), content = obj(c?.content);
    if (Array.isArray(content?.parts)) content.parts.forEach((part, i) => {
      const p = obj(part);
      if (!p?.thoughtSignature) add(p, "text", `candidate:${String(c?.index ?? 0)}:${i}:${String(p?.thought ?? false)}`);
    });
  }
  return out;
}

/** 扣留至多 64 字符的占位符候选尾部；无括号时须匹配已知类型的前缀。 */
export function pendingTailLength(text: string, kinds: readonly string[] = []): number {
  const brace = /\{{1,2}[ \t]*(?:[A-Za-z][A-Za-z0-9_]*(?:[ \t]*\}?)?)?$/u.exec(text);
  if (brace && brace[0].length <= 64) return brace[0].length;
  const tail = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*)([ \t]*\}?)$/u.exec(text);
  if (!tail || tail[0].length > 64) return 0;
  const word = tail[1]!.toUpperCase();
  if (tail[2] && !/^[A-Z][A-Z0-9_]*_[A-Z2-7]{8}$/u.test(word)) return 0;
  return kinds.some(kind => `${kind}_`.startsWith(word)
    || word.startsWith(`${kind}_`) && /^[A-Z2-7]{0,8}$/u.test(word.slice(kind.length + 1))) ? tail[0].length : 0;
}

/** SSE framing 与模型 delta 分层；互相交错的 choice、tool、content block 独立拼接。 */
export class SseRestorer {
  private buffer = "";
  private readonly queue: Event[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly wordBoundaries = new Set<string>();
  private heldSize = 0;

  constructor(private readonly restoreText: (value: string, json?: boolean) => string, private readonly kinds: readonly string[] = []) {}

  push(chunk: string, flush = false): string {
    this.buffer += chunk;
    let output = "";
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.buffer);
      if (!match) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      output += this.event(raw);
    }
    if (flush) {
      if (this.buffer) output += this.event(this.buffer);
      this.buffer = "";
      this.flushPending();
      output += this.drain();
    }
    if (this.buffer.length + this.heldSize > 2_000_000) throw new Error("Privacy response event buffer limit reached.");
    return output;
  }

  private flushPending(prefix?: string): void {
    for (const [channel, pending] of this.pending) {
      if (prefix !== undefined && !channel.startsWith(prefix)) continue;
      pending.field.owner[pending.field.key] += this.restoreDelta(pending.text, pending.field);
      pending.event.pending--;
      this.pending.delete(channel);
    }
    for (const channel of this.wordBoundaries) if (prefix === undefined || channel.startsWith(prefix)) this.wordBoundaries.delete(channel);
  }

  private restoreDelta(text: string, field: Field): string {
    // 保留上一增量的词边界，不能因分块把长标识中的后半段当成占位符。
    const prefix = this.wordBoundaries.has(field.channel) ? "0" : "";
    return this.restoreText(prefix + text, field.json).slice(prefix.length);
  }

  private event(raw: string): string {
    const lines = raw.split(/\r?\n/u);
    const payload = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
    let data: JsonObject | undefined;
    if (payload && payload !== "[DONE]") {
      try { data = obj(JSON.parse(payload)); } catch { throw new Error("Privacy cannot restore malformed SSE JSON."); }
    }
    if (payload === "[DONE]" || data?.type === "message_stop" || data?.type === "response.completed" || data?.type === "response.failed") this.flushPending();
    if (data?.type === "content_block_stop") this.flushPending(`block:${String(data.index)}:`);
    if (Array.isArray(data?.choices)) for (const c of data.choices) {
      const choice = obj(c);
      if (choice?.finish_reason) this.flushPending(`choice:${String(choice.index ?? 0)}:`);
    }
    const event: Event = { lines, data, pending: 0, size: raw.length };
    const sealedDelta = data?.type === "content_block_delta" && ["thinking_delta", "signature_delta"].includes(String(obj(data.delta)?.type));
    if (data && !sealedDelta) {
      // 先还原非 delta 字段；delta 必须走各自通道，且只能还原一次。
      const targets = fields(data);
      const originals = targets.map((field) => String(field.owner[field.key]));
      for (const field of targets) field.owner[field.key] = "";
      const restored = JSON.parse(restoreJson(JSON.stringify(data), this.restoreText)) as JsonObject;
      for (let i = 0; i < targets.length; i++) targets[i]!.owner[targets[i]!.key] = originals[i]!;
      const restoredFields = fields(restored);
      event.data = restored;
      for (let i = 0; i < restoredFields.length; i++) {
        const field = restoredFields[i]!;
        const before = this.pending.get(field.channel);
        if (before) { before.event.pending--; this.pending.delete(field.channel); }
        const value = (before?.text ?? "") + originals[i]!;
        const prefix = this.wordBoundaries.has(field.channel) ? "0" : "";
        const hold = Math.min(value.length, pendingTailLength(prefix + value, this.kinds));
        const ready = value.slice(0, value.length - hold);
        field.owner[field.key] = this.restoreDelta(ready, field);
        if (ready) {
          if (/[A-Za-z0-9_]$/u.test(ready)) this.wordBoundaries.add(field.channel);
          else this.wordBoundaries.delete(field.channel);
        }
        if (hold) {
          event.pending++;
          this.pending.set(field.channel, { text: value.slice(-hold), event, field });
        }
      }
    }
    this.queue.push(event);
    this.heldSize += raw.length;
    return this.drain();
  }

  private drain(): string {
    let output = "";
    while (this.queue.length && this.queue[0]!.pending === 0) {
      const event = this.queue.shift()!;
      this.heldSize -= event.size;
      if (!event.data) { output += event.lines.join("\n") + "\n\n"; continue; }
      let written = false;
      output += event.lines.flatMap((line) => {
        if (!line.startsWith("data:")) return [line];
        if (written) return [];
        written = true;
        return [`data: ${JSON.stringify(event.data)}`];
      }).join("\n") + "\n\n";
    }
    return output;
  }
}
