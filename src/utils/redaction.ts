/**
 * 纯文本敏感信息打码。
 *
 * 单独放在无 Node 依赖的模块里，Renderer 也会用它处理活动摘要，避免把路径和凭据文件
 * 判断逻辑一起打进浏览器包。
 */
export function redactSecrets(value: string): string {
  // 保持原规则：最早的完整 BEGIN 匹配其后第一个完整 END，不要求标签相同。
  // 单向扫描；若没有 END，后续 BEGIN 也不可能闭合，避免逐个重扫剩余文本。
  const beginPattern = /-----BEGIN [^-\r\n]*PRIVATE KEY-----/g;
  const endPattern = /-----END [^-\r\n]*PRIVATE KEY-----/g;
  const parts: string[] = [];
  let offset = 0;
  let begin: RegExpExecArray | null;
  while ((begin = beginPattern.exec(value)) !== null) {
    endPattern.lastIndex = beginPattern.lastIndex;
    const end = endPattern.exec(value);
    if (end === null) break;
    parts.push(value.slice(offset, begin.index), "[redacted private key]");
    offset = endPattern.lastIndex;
    beginPattern.lastIndex = offset;
  }
  parts.push(value.slice(offset));
  value = parts.join("");
  return value
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted]")
    // 值排除集同时含半角与全角分隔符：activity 摘要用「；」拼接字段，若只排除半角
    // 「,;」，token=… 的贪婪匹配会一路吞掉后续中文字段（见 activity/redaction.ts）。
    .replace(/\bBearer\s+[^\s,;；，、]+/gi, "Bearer [redacted]")
    .replace(/((?:aws_secret_access_key|_authToken)\s*[:=]\s*)([^\s,;；，、]+)/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)([^\s,;；，、]+)/gi, "$1[redacted]")
    .replace(/(["'](?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password)["']\s*:\s*["'])([^"']*)(["'])/gi, "$1[redacted]$3");
}
