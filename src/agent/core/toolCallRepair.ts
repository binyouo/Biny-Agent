/**
 * 工具调用自愈（对齐 Alma 的 ToolCallRepair 模式）。
 *
 * 模型发出名字或参数不合法的工具调用时，AI SDK 会先经过这里的 repairToolCall 钩子：
 * 工具名按归一化匹配修正（仅大小写/分隔符变体，语义别名会复活已移除的历史工具名，
 * 与「已移除工具名不迁移」的既有语义冲突，因此不做）、参数名按别名表纠偏、
 * 标量按属性 schema 纠偏类型。修复成功则照常执行——模型不会看到本可避免的失败，
 * 也就不会进入「报错→原样重试」循环；返回 null 表示放弃修复，回落到原有错误路径。
 * 修复后的 input 以 JSON 字符串返回，SDK 会重新解析并校验，仍不合法则维持原错误，
 * 不会无限自愈。
 */
import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from "ai";
import { isRecord } from "./vercelAgentUtils.js";

/** 归一化名称：小写并去掉非字母数字字符，容错大小写与分隔符差异。 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** 归一化后的误写参数名 → 候选规范参数名（以 Biny 工具的参数词汇表为准）。 */
const parameterAliases: Record<string, readonly string[]> = {
  file: ["path"],
  filepath: ["path"],
  filename: ["path"],
  targetfile: ["path"],
  directory: ["path"],
  dir: ["path"],
  folder: ["path"],
  targetdirectory: ["path"],
  cmd: ["command"],
  shellcommand: ["command"],
  pattern: ["query"],
  regex: ["query"],
  regexp: ["query"],
  search: ["query"],
  searchquery: ["query"],
  q: ["query"],
  uri: ["url"],
  link: ["url"],
  website: ["url"],
  body: ["content"],
  text: ["content"],
  contents: ["content"],
  oldstring: ["old_string"],
  find: ["old_string"],
  searchstring: ["old_string"],
  newstring: ["new_string"],
  replacement: ["new_string"],
  replacewith: ["new_string"],
  replaceall: ["replace_all"],
  maxcount: ["maxResults", "lineCount"],
  headlimit: ["maxResults", "lineCount"]
};

interface RepairedArguments {
  input: Record<string, unknown>;
  changed: boolean;
}

export const toolCallRepair: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, inputSchema, error }) => {
  try {
    let toolName = toolCall.toolName;
    if (NoSuchToolError.isInstance(error)) {
      const repaired = repairToolName(toolName, Object.keys(tools));
      if (repaired === undefined) return null;
      toolName = repaired;
    }
    const { input, changed } = repairToolArguments(await inputSchema({ toolName }), toolCall.input);
    const renamed = toolName !== toolCall.toolName;
    if (!renamed && !changed) return null;
    return { ...toolCall, toolName, input: JSON.stringify(input) };
  } catch {
    // 自愈自身出错时回落原错误路径，不让修复变成新的故障源。
    return null;
  }
};

function repairToolName(name: string, available: readonly string[]): string | undefined {
  if (available.includes(name)) return name;
  const byNormalized = new Map<string, string>();
  for (const candidate of available) byNormalized.set(normalizeName(candidate), candidate);
  return byNormalized.get(normalizeName(name));
}

function repairToolArguments(schema: unknown, rawInput: unknown): RepairedArguments {
  const recovered = recoverObjectInput(rawInput);
  if (recovered === null) return { input: {}, changed: false };
  const { value: input, recovered: inputRecovered } = recovered;
  const properties = isRecord(schema) && isRecord(schema.properties)
    ? schema.properties
    : undefined;
  if (properties === undefined) return { input, changed: inputRecovered };

  const canonicalByKey = new Map<string, string>();
  for (const key of Object.keys(properties)) canonicalByKey.set(normalizeName(key), key);
  const repaired: Record<string, unknown> = {};
  let changed = inputRecovered;
  for (const [key, value] of Object.entries(input)) {
    if (key in properties) {
      repaired[key] = value;
      continue;
    }
    const canonical = canonicalByKey.get(normalizeName(key))
      ?? firstDefined((parameterAliases[normalizeName(key)] ?? [])
        .map((candidate) => canonicalByKey.get(normalizeName(candidate))));
    // Biny 工具 schema 均 additionalProperties:false；无法映射或与已有键冲突的参数
    // 只能丢弃，保留会让重新校验仍然失败、自愈失去意义。
    if (canonical === undefined || canonical in repaired) {
      changed = true;
      continue;
    }
    repaired[canonical] = value;
    changed = true;
  }
  for (const key of Object.keys(repaired)) {
    const coerced = coerceValue(repaired[key], properties[key]);
    if (coerced !== repaired[key]) {
      repaired[key] = coerced;
      changed = true;
    }
  }
  return { input: repaired, changed };
}

/** repairToolCall 边界上的 input 是 provider 原始 JSON 文本；恢复成普通对象，无法恢复时返回 null。 */
function recoverObjectInput(rawInput: unknown): { value: Record<string, unknown>; recovered: boolean } | null {
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (trimmed === "") return { value: {}, recovered: true };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return { value: { ...parsed }, recovered: false };
    } catch {
      // 非 JSON 文本无法恢复为对象参数。
    }
    return null;
  }
  if (rawInput === null || rawInput === undefined) return { value: {}, recovered: false };
  if (isRecord(rawInput)) return { value: { ...rawInput }, recovered: false };
  return null;
}

const numericString = /^[+-]?(\d+\.?\d*|\.\d+)$/u;

function schemaTypes(schema: unknown): Set<string> {
  const types = new Set<string>();
  const visit = (value: unknown): void => {
    if (!isRecord(value)) return;
    if (typeof value.type === "string") types.add(value.type);
    else if (Array.isArray(value.type)) {
      for (const type of value.type) {
        if (typeof type === "string") types.add(type);
      }
    }
    for (const group of [value.anyOf, value.oneOf, value.allOf]) {
      if (Array.isArray(group)) for (const entry of group) visit(entry);
    }
  };
  visit(schema);
  return types;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "null": return value === null;
    default: return false;
  }
}

/** 按属性 schema 纠偏标量：数字/布尔/JSON 字符串与目标类型互换，枚举做大小写无关匹配。 */
function coerceValue(value: unknown, schema: unknown): unknown {
  const types = schemaTypes(schema);
  if (types.size === 0) return value;
  for (const type of types) {
    if (matchesType(value, type)) return fixEnumCase(value, schema);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if ((types.has("number") || types.has("integer")) && numericString.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric) && (types.has("number") || !types.has("integer") || Number.isInteger(numeric))) return numeric;
    }
    if (types.has("boolean")) {
      const lowered = text.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lowered)) return true;
      if (["false", "0", "no", "off"].includes(lowered)) return false;
    }
    if (types.has("array") && text.startsWith("[")) {
      const parsed = parseJsonSilently(text);
      if (Array.isArray(parsed)) return parsed;
    }
    if (types.has("object") && text.startsWith("{")) {
      const parsed = parseJsonSilently(text);
      if (isRecord(parsed)) return parsed;
    }
    return fixEnumCase(value, schema);
  }
  if (types.has("string") && (typeof value === "number" || typeof value === "boolean")) return String(value);
  return value;
}

function fixEnumCase(value: unknown, schema: unknown): unknown {
  if (typeof value !== "string" || !isRecord(schema) || !Array.isArray(schema.enum)) return value;
  if (schema.enum.includes(value)) return value;
  const matched = schema.enum.find((entry) => typeof entry === "string" && entry.toLowerCase() === value.toLowerCase());
  return matched ?? value;
}

function parseJsonSilently(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function firstDefined(values: ReadonlyArray<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}
