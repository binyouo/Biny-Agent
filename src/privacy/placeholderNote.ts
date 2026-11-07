import { placeholderPattern } from "./crypto.js";
import { walkJsonValues, type MaskJsonResult } from "./json.js";

export type PrivacyProtocol = "chat" | "anthropic" | "responses" | "gemini";
export interface PlaceholderNoteContext { protocol?: PrivacyProtocol; providerType?: string }

const NOTE = "Privacy placeholders written as {{TYPE_<hash>}} stand for values kept on this computer. "
  + "Copy each placeholder unchanged in replies and tool arguments; the local runtime restores its value before tool execution. "
  + "Do not infer the hidden value, substitute examples, or ask the user to reveal it.";

type ObjectValue = Record<string, unknown>;
interface Edit { path: string[]; update: (raw: string) => string; shift?: { array: string; index: number }; stringInput?: boolean }

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function contains(value: unknown, predicate: (text: string) => boolean): boolean {
  if (typeof value === "string") return predicate(value);
  if (value && typeof value === "object") return Object.values(value).some(child => contains(child, predicate));
  return false;
}

function append(path: string[], value: unknown, part: ObjectValue): Edit | undefined {
  if (typeof value === "string") return { path, update: raw => JSON.stringify(`${JSON.parse(raw)}\n\n${NOTE}`) };
  if (Array.isArray(value)) return { path, update: raw => raw.slice(0, -1) + (value.length ? "," : "") + JSON.stringify(part) + "]" };
  return undefined;
}

function addField(path: string[], name: string, value: unknown): Edit {
  return { path, update: raw => raw.slice(0, -1) + (Object.keys(JSON.parse(raw)).length ? "," : "") + JSON.stringify(name) + ":" + JSON.stringify(value) + "}" };
}

function instructionEdit(root: ObjectValue, protocol: PrivacyProtocol, has: (value: unknown) => boolean): Edit | undefined {
  const textPart = { type: "text", text: NOTE };
  if (protocol === "responses") {
    const input = root.input;
    const message = { role: "developer", content: [{ type: "input_text", text: NOTE }] };
    if (typeof input === "string" && has(input)) return { path: ["input"], update: raw => `[${JSON.stringify(message)},{"role":"user","content":${raw}}]`, stringInput: true };
    if (!Array.isArray(input)) return undefined;
    let index = has(root.instructions) || has(root.tools) ? -1 : input.findIndex(has);
    if (index < 0 && !has(root.instructions) && !has(root.tools)) return undefined;
    if (index < 0) return { path: ["input"], update: raw => "[" + JSON.stringify(message) + (input.length ? "," : "") + raw.slice(1), shift: { array: "input", index: 0 } };
    // 一批并行工具结果必须相邻，说明放在整批结果之后。
    while (String(object(input[index + 1])?.type).endsWith("_call_output")) index++;
    return { path: ["input", String(index)], update: raw => raw + "," + JSON.stringify(message), shift: { array: "input", index: index + 1 } };
  }

  if (protocol === "anthropic" && (has(root.system) || has(root.tools))) {
    return append(["system"], root.system, textPart) ?? addField([], "system", NOTE);
  }
  if (protocol === "gemini" && (has(root.systemInstruction) || has(root.system_instruction) || has(root.tools))) {
    const key = object(root.systemInstruction) ? "systemInstruction" : "system_instruction";
    const system = object(root[key]);
    return system ? append([key, "parts"], system.parts, { text: NOTE }) : addField([], "systemInstruction", { parts: [{ text: NOTE }] });
  }

  const key = protocol === "gemini" ? "contents" : "messages";
  const messages = root[key];
  if (!Array.isArray(messages)) return undefined;
  let index = messages.findIndex(has);
  if (protocol === "chat" && (has(root.tools) || ["system", "developer"].includes(String(object(messages[index])?.role)))) {
    index = messages.findIndex(message => ["system", "developer"].includes(String(object(message)?.role)));
    if (index < 0) return { path: [key], update: raw => "[" + JSON.stringify({ role: "system", content: NOTE }) + (messages.length ? "," : "") + raw.slice(1), shift: { array: key, index: 0 } };
  }
  if (index < 0) return undefined;
  const message = object(messages[index]);
  // 合法消息才有说明落点；不把任意 JSON 数据解释成对话。
  if (!message || typeof message.role !== "string") return undefined;
  const contentKey = protocol === "gemini" ? "parts" : "content";
  const content = message[contentKey];
  const edit = append([key, String(index), contentKey], content, protocol === "gemini" ? { text: NOTE } : textPart);
  if (edit || protocol !== "chat") return edit;
  return contentKey in message ? { path: [key, String(index), contentKey], update: () => JSON.stringify(NOTE) }
    : addField([key, String(index)], contentKey, NOTE);
}

/** 只在出站副本加入说明；以首次占位符为落点，保留更早历史的缓存前缀。 */
export function withPlaceholderNote(source: string, result: MaskJsonResult, values: ReadonlyMap<string, string>, context: PlaceholderNoteContext): { source: string; result: MaskJsonResult } {
  const unchanged = { source, result };
  if (!values.size || context.providerType === "claude-subscription" || context.providerType === "openai-codex") return unchanged;
  const root = object(JSON.parse(result.text));
  const protocol = context.protocol ?? "chat";
  if (!root || protocol === "responses" && root.previous_response_id || contains(root, text => text.includes(NOTE))) return unchanged;
  const has = (value: unknown): boolean => contains(value, text => [...text.matchAll(placeholderPattern)].some(match => values.has(match[0])));
  if (!has(root)) return unchanged;
  const edit = instructionEdit(root, protocol, has);
  if (!edit) return unchanged;
  const apply = (body: string): string => {
    let start = -1, end = -1;
    walkJsonValues(body, text => text, undefined, (path, a, b) => {
      if (path.length === edit.path.length && path.every((key, i) => key === edit.path[i])) { start = a; end = b; }
    });
    return start < 0 ? body : body.slice(0, start) + edit.update(body.slice(start, end)) + body.slice(end);
  };
  const shift = edit.shift;
  const segments = result.segments.map(group => {
    if (edit.stringInput && group.path === "input") return { ...group, path: "input.1.content" };
    const path = group.path.split(".");
    if (shift && path[0] === shift.array && /^\d+$/u.test(path[1] ?? "") && Number(path[1]) >= shift.index) path[1] = String(Number(path[1]) + 1);
    return { ...group, path: path.join(".") };
  });
  return { source: apply(source), result: { ...result, text: apply(result.text), segments } };
}
