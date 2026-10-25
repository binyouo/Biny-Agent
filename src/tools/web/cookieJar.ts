/**
 * 共享 Cookie jar 模块。
 *
 * 桌面端内嵌浏览器登录后把 cookie 落到这个 jar，`WebSearch` 的 Google provider 和
 * `WebFetch` 再从 jar 里取出来附到请求上 —— 登录一次，agent 侧就能读到需要身份验证的内容。
 *
 * 文件格式刻意选成 Cookie-Editor 扩展的导出格式（一个平铺的 cookie 数组），这样用户可以把
 * 浏览器里的登录态直接导进来，也可以把 Biny 的导出去给浏览器用，不需要中间转换工具。
 * 未知字段按原样保留，避免来回导入导出把扩展自己的字段擦掉。
 *
 * 安全边界：jar 里存的是等同于登录凭据的东西，所以按 0600 写盘，且只有域名/路径/协议
 * 都匹配的请求才会拿到对应的 cookie（`cookieHeaderFor`）。跨域跳转必须重新匹配一次，
 * 不能把上一跳的 Cookie 头原样带过去。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Cookie-Editor 导出条目。`expirationDate` 是秒级 epoch，会话 cookie 没有这个字段。 */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
  expirationDate?: number;
  /** 为真表示只发给 `domain` 本身，不发给子域名。 */
  hostOnly?: boolean;
  session?: boolean;
  storeId?: string;
}

export interface CookieJarSummary {
  total: number;
  /** 按 cookie 数量降序的域名统计，用于设置页展示「登录了哪些站点」。 */
  domains: Array<{ domain: string; count: number }>;
  updatedAt?: string;
}

/**
 * jar 的默认位置，与桌面端 userData 下的工作区目录保持一致，这样 CLI/TUI 不需要任何配置
 * 就能读到桌面端导入的 cookie。桌面端自己会显式传入真实路径，不依赖这里的推算。
 */
export function defaultCookieJarPath(): string {
  return path.join(userDataRoot(), "workspaces", "default", "cookies.json");
}

function userDataRoot(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Biny");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Biny");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Biny");
}

/** 读取 jar；文件不存在或内容损坏都返回空数组 —— cookie 是可再获取的缓存，不值得让工具调用失败。 */
export async function readCookieJar(filePath: string): Promise<StoredCookie[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    return parseCookieJar(raw);
  } catch {
    return [];
  }
}

/** 按 0600 写盘，并用临时文件 + 改名替换，避免读到写了一半的 jar。 */
export async function writeCookieJar(filePath: string, cookies: StoredCookie[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // 临时名必须带随机成分：并发写同一个 jar 时，固定名字会让两个写操作互相截断。
  const temporaryPath = `${filePath}.${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, serializeCookieJar(cookies), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await fs.chmod(filePath, 0o600);
}

/**
 * 解析 Cookie-Editor 格式。除了平铺数组，也接受 `{ cookies: [...] }` 包装 —— 部分扩展
 * 和 Playwright 的 storageState 是这个形状，用户很容易直接拿来导入。
 */
export function parseCookieJar(raw: string): StoredCookie[] {
  const payload: unknown = JSON.parse(raw);
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.cookies) ? payload.cookies : undefined;
  if (!entries) throw new Error("Cookie 文件应是一个 cookie 数组（Cookie-Editor 导出格式）。");
  const cookies = entries.map(normalizeCookie).filter((cookie): cookie is StoredCookie => cookie !== undefined);
  if (!cookies.length) throw new Error("Cookie 文件里没有可用的 cookie。");
  return cookies;
}

export function serializeCookieJar(cookies: StoredCookie[]): string {
  return `${JSON.stringify(cookies, null, 2)}\n`;
}

export function summarizeCookieJar(cookies: StoredCookie[], updatedAt?: string): CookieJarSummary {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, "");
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return {
    total: cookies.length,
    domains: [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain)),
    updatedAt
  };
}

/**
 * 生成发往 `url` 的 Cookie 头；没有匹配的 cookie 时返回 undefined。
 *
 * 匹配规则按 RFC 6265：domain（区分 hostOnly）、path 前缀、secure 只发给 https，并丢掉
 * 已过期的条目。`now` 可注入，方便测试过期逻辑。
 */
export function cookieHeaderFor(cookies: StoredCookie[], url: URL, now: number = Date.now()): string | undefined {
  const secureRequest = url.protocol === "https:";
  const host = url.hostname.toLowerCase();
  const matched = cookies.filter((cookie) => {
    if (cookie.secure && !secureRequest) return false;
    if (cookie.expirationDate !== undefined && cookie.expirationDate * 1_000 <= now) return false;
    return domainMatches(host, cookie) && pathMatches(url.pathname, cookie.path);
  });
  if (!matched.length) return undefined;
  // 按 RFC 6265 建议将更长路径排在前面；逐条发送匹配项，保留不同路径或域名的同名 cookie。
  const ordered = [...matched].sort((left, right) => right.path.length - left.path.length);
  const parts: string[] = [];
  for (const cookie of ordered) {
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join("; ");
}

function domainMatches(host: string, cookie: StoredCookie): boolean {
  const domain = cookie.domain.toLowerCase().replace(/^\./, "");
  if (host === domain) return true;
  // 显式 hostOnly 的 cookie 不下发给子域名；`.example.com` 这种前导点则表示包含子域名。
  if (cookie.hostOnly && !cookie.domain.startsWith(".")) return false;
  return host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  const target = cookiePath || "/";
  if (target === "/") return true;
  if (requestPath === target) return true;
  return requestPath.startsWith(target.endsWith("/") ? target : `${target}/`);
}

/** 逐条校验并补齐缺省字段；缺少 name/domain 的条目直接丢弃，不让半条 cookie 污染 jar。 */
function normalizeCookie(value: unknown): StoredCookie | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const domain = typeof value.domain === "string" ? value.domain.trim() : undefined;
  if (!name || !domain) return undefined;
  const expirationDate = typeof value.expirationDate === "number" && Number.isFinite(value.expirationDate)
    ? value.expirationDate
    : undefined;
  return {
    ...value,
    name,
    value: typeof value.value === "string" ? value.value : "",
    domain,
    path: typeof value.path === "string" && value.path ? value.path : "/",
    secure: value.secure === true,
    httpOnly: value.httpOnly === true,
    sameSite: normalizeSameSite(value.sameSite),
    expirationDate,
    hostOnly: typeof value.hostOnly === "boolean" ? value.hostOnly : undefined,
    session: typeof value.session === "boolean" ? value.session : expirationDate === undefined,
    storeId: typeof value.storeId === "string" ? value.storeId : undefined
  };
}

function normalizeSameSite(value: unknown): StoredCookie["sameSite"] {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "no_restriction" || normalized === "none") return "no_restriction";
  if (normalized === "lax") return "lax";
  if (normalized === "strict") return "strict";
  if (normalized === "unspecified") return "unspecified";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
