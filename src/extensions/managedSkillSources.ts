/** 受管 Skill 的安装目录与本地文档校验。 */
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";
import { parseSkillDocument, readSkillMetadataFields } from "./skillDocument.js";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function defaultManagedSkillRoot(homeDir?: string): string {
  const configRoot = homeDir === undefined ? globalConfigDir() : globalConfigDir({ env: {}, homeDir });
  return path.join(configRoot, "skills");
}

export function parseManagedSkillMetadata(content: string, expectedId: string): {
  id: string;
  name: string;
  description: string;
} {
  const { frontmatter } = parseSkillDocument(content);
  const name = requiredString(frontmatter.name, "name");
  const description = requiredString(frontmatter.description, "description");
  if (!skillNamePattern.test(name) || name.length > 64) {
    throw new Error(`Skill name 无效：${name}。应使用 1-64 位小写字母、数字和单连字符。`);
  }
  if (expectedId !== name) throw new Error(`Skill name ${name} 必须与目录名 ${expectedId} 一致。`);
  if (description.length > 1_024) throw new Error("Skill description 不能超过 1024 个字符。");
  readSkillMetadataFields(frontmatter);
  return { id: name, name, description };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md frontmatter 必须包含 ${field}。`);
  return value.trim();
}
