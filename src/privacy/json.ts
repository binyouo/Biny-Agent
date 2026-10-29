import { maskSentText, maskText, restore, type MaskHit, type MaskSegment, type MaskTextResult } from "./engine.js";
import { defaultStore, type RedactionStore } from "./store.js";
import type { RedactionSettings } from "./settings.js";

const KEPT_KEYS = new Set([
  "signature", "encrypted_content", "data", "thoughtSignature", "thought_signature", "model", "id", "type", "role",
  "name", "namespace", "server_label", "server_name", "prompt_cache_key", "media_type", "mime_type", "mimeType",
  "url", "image_url", "reasoning_effort", "effort", "stop_reason", "finish_reason", "status", "object", "event"
]);
const DEF_KEYS = new Set(["tools", "tool_choice", "functions", "function_call", "toolConfig", "tool_config", "response_format",
  "text", "reasoning", "include", "output_format", "output_config", "generationConfig", "generation_config", "stream_options"]);
const SIGNATURE_KEYS = ["signature", "thoughtSignature", "thought_signature", "encrypted_content"];
type Transform = (value: string, path: string[], key: string) => string;

/** 只替换字符串 token；其余字节（包括空白、数字精度与字段顺序）保留。 */
export function walkJsonValues(source: string, transform: Transform, observe?: (value: string, path: string[], stringValue: boolean) => void): string | undefined {
  try { JSON.parse(source); } catch { return undefined; }
  let index = 0, last = 0, out = "";
  const ws = (): void => { while (/\s/u.test(source[index] ?? "") && index < source.length) index++; };
  const stringEnd = (): number => {
    index++;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === '"') break;
    }
    return index;
  };
  const visit = (path: string[], key: string): void => {
    ws();
    if (source[index] === "{") {
      index++; ws();
      if (source[index] === "}") observe?.("{}", path, false);
      while (source[index] !== "}") {
        const start = index;
        stringEnd();
        const child = JSON.parse(source.slice(start, index)) as string;
        ws(); index++;
        visit([...path, child], child);
        ws();
        if (source[index] !== ",") break;
        index++; ws();
      }
      index++;
    } else if (source[index] === "[") {
      index++; ws();
      if (source[index] === "]") observe?.("[]", path, false);
      let child = 0;
      while (source[index] !== "]") {
        visit([...path, String(child++)], key); ws();
        if (source[index] !== ",") break;
        index++; ws();
      }
      index++;
    } else if (source[index] === '"') {
      const start = index;
      stringEnd();
      const value = JSON.parse(source.slice(start, index)) as string;
      observe?.(value, path, true);
      const next = transform(value, path, key);
      if (next !== value) { out += source.slice(last, start) + JSON.stringify(next); last = index; }
    } else {
      const start = index;
      while (index < source.length && !",]} \t\r\n".includes(source[index]!)) index++;
      observe?.(source.slice(start, index), path, false);
    }
  };
  visit([], "");
  return out + source.slice(last);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function contextAt(root: unknown, path: string[]): { args: boolean; signed: boolean; defs: boolean } {
  let node: unknown = root;
  let args = false, signed = false;
  for (let i = 0; i < path.length; i++) {
    const parent = object(node);
    const key = path[i]!;
    if (parent) {
      if ((key === "input" && ["tool_use", "server_tool_use"].includes(String(parent.type)))
        || (key === "args" && ["functionCall", "function_call"].includes(path[i - 1] ?? ""))) args = true;
      if (!args && SIGNATURE_KEYS.some((name) => typeof parent[name] === "string" && parent[name] !== "")) signed = true;
    }
    node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  return { args, signed: signed && !args, defs: !args && DEF_KEYS.has(path[0] ?? "") };
}

export interface MaskJsonSegment { path: string; original: string; masked: string; segments: MaskSegment[]; role?: string; truncated?: boolean }
export interface MaskJsonResult { text: string; hits: MaskHit[]; segments: MaskJsonSegment[] }

export function maskJson(source: string, settings: RedactionSettings, store: RedactionStore = defaultStore): MaskJsonResult {
  return store.withRequest(() => maskRequestJson(source, settings, store));
}

function maskRequestJson(source: string, settings: RedactionSettings, store: RedactionStore): MaskJsonResult {
  let root: unknown;
  try { root = JSON.parse(source); } catch {
    const result = maskText(source, settings, store);
    return { text: result.text, hits: result.hits, segments: result.segments.length ? [{ path: "", original: source, masked: result.text, segments: result.segments }] : [] };
  }
  const hits: MaskHit[] = [], segments: MaskJsonSegment[] = [];
  let discovering = true;
  const transform: Transform = (value, path, key) => {
    const context = contextAt(root, path);
    if (value.startsWith("data:") || context.signed) return value;
    if (context.defs && key !== "description") return value;
    if (!context.args && (KEPT_KEYS.has(key) || /(?:^ids?$|_ids?$|Ids?$)/u.test(key))) return value;
    // 工具参数中的键属于工具领域，不能套用 Provider 的 name/id 等保留规则。
    if (key === "arguments") {
      const nested = walkJsonValues(value, (text, nestedPath) => apply(text, [...path, ...nestedPath]));
      if (nested === undefined) throw new Error("Privacy cannot mask malformed tool arguments.");
      return nested;
    }
    return apply(value, path);
  };
  const apply = (value: string, path: string[]): string => {
    if (value.startsWith("data:")) return value;
    const key = path.at(-1) ?? "";
    const sensitive = /^(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|密码|密碼|密钥|金鑰|パスワード)$/iu.test(key);
    const kind = sensitive ? /password|passwd|密码|密碼|パスワード/iu.test(key) ? "PASSWORD" : "SECRET" : "text";
    const detect = (): MaskTextResult => {
      if (sensitive && settings.enabled && value.length >= 3 && !/^(?:\$|%|\{|<|\[|\*|data:)/u.test(value)) {
        const tag = store.register(kind, value);
        return { text: tag, hits: [{ kind, placeholder: tag, length: [...value].length }], segments: [{ kind, original: value, masked: tag, start: 0, end: value.length }] };
      }
      return maskText(value, settings, store);
    };
    const result = discovering || !settings.enabled ? detect() : maskSentText(value, kind, store, detect);
    hits.push(...result.hits);
    segments.push({ path: path.join("."), original: value, masked: result.text, segments: result.segments });
    return result.text;
  };
  // 先发现后替换，让同一请求内较早出现的无上下文原值也能被遮蔽。
  walkJsonValues(source, transform);
  discovering = false;
  hits.length = 0; segments.length = 0;
  const text = walkJsonValues(source, transform)!;
  return { text, hits, segments };
}

/** 嵌套 JSON 的工具参数须先按内层字符串转义，再按外层字符串转义。 */
export function restoreJson(source: string, restoreText: (value: string) => string = restore): string {
  let root: unknown;
  try { root = JSON.parse(source); } catch { return restoreText(source); }
  return walkJsonValues(source, (value, path, key) => {
    const context = contextAt(root, path);
    if (context.signed || (!context.args && KEPT_KEYS.has(key))) return value;
    return key === "arguments"
      ? walkJsonValues(value, (text) => restoreText(text)) ?? restoreText(value)
      : restoreText(value);
  })!;
}
export type { RedactionSettings };
