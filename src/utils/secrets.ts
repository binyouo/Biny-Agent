/**
 * 敏感信息保护。
 *
 * 两件事：判断路径是否属于受保护的凭据文件（工具层据此拒绝读写），以及把文本/结构里的
 * 密钥打码后再落盘或展示。
 *
 * 策略一律「宁可多打码」：打码规则做不到零漏报，所以路径拦截和输出打码要共同生效。
 */
import path from "node:path";
import { redactSecrets } from "./redaction.js";

export { redactSecrets } from "./redaction.js";

const protectedCredentialFiles = new Set([
  "config.json",
  ".envrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc"
]);

const protectedCredentialDirectories = new Set([
  ".biny",
  ".agent",
  ".ssh",
  ".aws",
  ".azure",
  ".direnv",
  ".gnupg"
]);

/**
 * 判断是否为受保护的凭据路径。除固定文件名外，还覆盖 `.env` 系列、`config.json.*`
 * 备份，以及路径中任意一段落在 `.ssh` / `.aws` 等目录里的情况。
 */
export function isProtectedCredentialPath(value: string): boolean {
  // 统一成 posix 分隔符再判断，Windows 路径和 `./` 前缀不能绕过检查。
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  const fileName = path.posix.basename(normalized);
  return fileName === ".env"
    || fileName.startsWith(".env.")
    || fileName.startsWith("config.json.")
    || segments.some((segment) => protectedCredentialDirectories.has(segment))
    || protectedCredentialFiles.has(fileName);
}

export interface SensitiveValueRedactionOptions {
  /** MCP responses have already had connection credentials removed by the host. */
  context?: "mcp-result";
}

/**
 * 生成一份可安全落盘/展示的副本，不改动原值。
 *
 * 相比纯文本打码，这里多了字段名这层信息：`apiKey`、`authorization` 之类字段下的值即使
 * 没有任何可识别前缀，也一律替换掉。
 */
export function redactSensitiveValue(value: unknown, options: SensitiveValueRedactionOptions = {}): unknown {
  return redactSensitiveValueInternal(value, new WeakSet<object>(), options.context);
}

function redactSensitiveValueInternal(value: unknown, ancestors: WeakSet<object>, context?: "mcp-result"): unknown {
  if (typeof value === "string") return context ? value : redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
  // 工具结果可能带循环引用，用祖先集合断环；只在递归路径上记录，兄弟节点之间互不影响。
  if (ancestors.has(value)) return "[circular]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactSensitiveValueInternal(entry, ancestors, context));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      return [key, !context && isSensitiveFieldName(key) ? "[redacted]" : redactSensitiveValueInternal(entry, ancestors, context)];
    }));
  } finally {
    ancestors.delete(value);
  }
}

/** 字段名判定：先去掉分隔符再小写，这样 `api-key`、`api_key`、`ApiKey` 都能一起命中。 */
export function isSensitiveFieldName(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized === "token"
    || normalized === "secret"
    || normalized === "password"
    || normalized === "passwd"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized.endsWith("apikey")
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("password");
}
