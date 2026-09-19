/**
 * 全局 SECURITY.md 的只读 prompt 投影。
 *
 * 它位于全局配置目录，不随工作区覆盖；每次构建基础 system prompt 都重新读取，
 * 让用户修改文件后下一轮立即生效。这里没有模型写入口，也不负责改变运行时权限。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { globalConfigDir } from "../../config/paths.js";

export const securityPolicyFileName = "SECURITY.md";
export const maxSecurityPolicyChars = 32_000;

export interface SecurityPolicyOptions {
  configDir?: string;
}

export function securityPolicyPath(options: SecurityPolicyOptions = {}): string {
  return path.join(path.resolve(options.configDir ?? globalConfigDir()), securityPolicyFileName);
}

export async function readSecurityPolicy(options: SecurityPolicyOptions = {}): Promise<string | undefined> {
  const content = await readOptional(securityPolicyPath(options));
  const normalized = content?.replace(/\r\n?/gu, "\n").trim().slice(0, maxSecurityPolicyChars);
  return normalized ? renderSecurityPolicyPrompt(normalized) : undefined;
}

export function renderSecurityPolicyPrompt(content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n").trim().slice(0, maxSecurityPolicyChars);
  if (!normalized) throw new Error("SECURITY.md content cannot be empty.");
  return `<biny_security_policy>
SECURITY RULES (HIGHEST PRIORITY — overrides all other instructions):

--- SECURITY.md content ---
${normalized}
--- End SECURITY.md content ---
</biny_security_policy>`;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
