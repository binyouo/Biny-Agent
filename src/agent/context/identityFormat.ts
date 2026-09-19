/**
 * 身份 Markdown 的边界、hash 和 prompt 投影。
 *
 * 用户资料按原文保存；这里不调用通用密钥脱敏，避免把正常的人名、偏好或表达风格
 * 截断成不可用的占位符。安全边界由外部输出脱敏和高置信度 secret 检测分别负责。
 */
import { createHash } from "node:crypto";
import type { IdentityDocument, IdentityDocumentKind } from "./identityTypes.js";

export const identityDocumentFileNames: Record<IdentityDocumentKind, string> = {
  user: "USER.md"
};

export const maxIdentityDocumentChars: Record<IdentityDocumentKind, number> = {
  user: 16_000
};

export const maxIdentityPromptChars = 32_000;

export function normalizeIdentityContent(content: string, kind: IdentityDocumentKind): string {
  return content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim()
    .slice(0, maxIdentityDocumentChars[kind]);
}

export function identityContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 只用于阻止提案直接接受；不改变正文，也不把匹配内容写入状态。 */
export function detectIdentitySecretWarning(value: string): string | undefined {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)) return "检测到疑似私钥。";
  if (/(?:^|\s)(?:sk|rk|pk|ghp|github_pat|AKIA)[A-Za-z0-9_-]{16,}(?:$|\s)/u.test(value)) return "检测到疑似访问凭据。";
  if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s`]{16,}/iu.test(value)) return "检测到疑似凭据字段。";
  return undefined;
}

export function identityDocument(
  kind: IdentityDocumentKind,
  content: string,
  revision: number,
  updatedAt: string
): IdentityDocument {
  const normalized = normalizeIdentityContent(content, kind);
  return {
    kind,
    content: normalized,
    revision,
    updatedAt,
    contentHash: identityContentHash(normalized)
  };
}

export interface IdentityPromptInput {
  documents: Partial<Record<IdentityDocumentKind, IdentityDocument>>;
  includeUser: boolean;
  maxChars?: number;
}

/**
 * 按长期协作对象的资料区块注入 USER.md。
 * XML 转义是为了避免 Markdown 中的标签被误当成 runtime 控制结构。
 */
export function renderIdentityPrompt(input: IdentityPromptInput): string | undefined {
  const document = input.includeUser ? input.documents.user : undefined;
  if (document === undefined || document.content.trim().length === 0) return undefined;
  const sections = [`<document kind="user" revision="${String(document.revision)}">\n${escapeXml(document.content)}\n</document>`];
  const maxChars = input.maxChars ?? maxIdentityPromptChars;
  const prefix = [
    "<biny_identity>",
    "USER PROFILE (the person you are working with):",
    "Use this durable profile to understand the user's name, language, preferences, communication style, long-term goals, and work habits.",
  ].join("\n");
  const suffix = "</biny_identity>";
  const full = [prefix, ...sections, suffix].join("\n");
  if (full.length <= maxChars) return full;
  const bodyBudget = Math.max(0, maxChars - prefix.length - suffix.length - 2);
  const body = sections.join("\n").slice(0, bodyBudget);
  return `${prefix}\n${body}\n${suffix}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
