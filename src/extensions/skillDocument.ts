/** Skill 文档的公共解析层；目录管理和运行时共享格式规则，权限仍由运行时决定。 */
import { parseDocument } from "yaml";

export const maxSkillFileBytes = 512 * 1024;
export const maxSkillMetadataBytes = 64 * 1024;

export interface SkillMetadata {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  /** true 时名称和简介进入每轮可用技能列表，不依赖能力分析选中。 */
  alwaysInject?: boolean;
}

export function parseSkillDocument(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const opening = /^---[ \t]*\r?\n/u.exec(content);
  if (!opening) return { frontmatter: {}, body: content };
  const closingPattern = /^---[ \t]*\r?$/gmu;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(content);
  if (!closing) throw new Error("SKILL.md frontmatter 缺少结束分隔线。");
  // 只计入结束线的三个连字符；其后空白和换行不影响头部边界。
  if (Buffer.byteLength(content.slice(0, closing.index + 3), "utf8") > maxSkillMetadataBytes) {
    throw new Error(`SKILL.md frontmatter 的结束分隔线必须位于前 ${String(maxSkillMetadataBytes)} 字节内。`);
  }
  const document = parseDocument(content.slice(opening[0].length, closing.index), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`SKILL.md YAML 无法解析：${document.errors[0]?.message ?? "unknown error"}`);
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL.md frontmatter 必须是 YAML 对象。");
  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return { frontmatter: value as Record<string, unknown>, body: content.slice(bodyStart) };
}

export function readSkillMetadataFields(record: Record<string, unknown>): SkillMetadata {
  const text = (field: string): string | undefined => {
    const value = record[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`SKILL.md ${field} must be a string.`);
    return value.trim() || undefined;
  };
  const compatibility = text("compatibility");
  if (compatibility && compatibility.length > 500) throw new Error("SKILL.md compatibility 超过 500 个字符。");
  const rawTools = record["allowed-tools"];
  if (rawTools !== undefined && typeof rawTools !== "string" && !(Array.isArray(rawTools) && rawTools.every((tool) => typeof tool === "string"))) {
    throw new Error("SKILL.md allowed-tools 必须是字符串或字符串数组。");
  }
  const allowedTools = typeof rawTools === "string" ? rawTools.trim().split(/\s+/u).filter(Boolean) : rawTools as string[] | undefined;
  if (record.metadata !== undefined && (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata))) {
    throw new Error("SKILL.md metadata 必须是对象。");
  }
  const rawAlwaysInject = record["always-inject"];
  if (rawAlwaysInject !== undefined && typeof rawAlwaysInject !== "boolean") {
    throw new Error("SKILL.md always-inject 必须是布尔值。");
  }
  return {
    name: text("name"), description: text("description"), license: text("license"), compatibility,
    allowedTools, metadata: record.metadata as Record<string, unknown> | undefined,
    alwaysInject: rawAlwaysInject as boolean | undefined
  };
}
