/**
 * 为 Node 侧的模型请求提供代理感知的 fetch。
 *
 * Node 原生 fetch 不会自动读取 macOS 的系统代理设置；CLI/TUI 如果直接使用它，
 * 在 Clash Fake-IP 或需要系统代理的网络中会把请求打到不可达的虚拟地址。这里优先
 * 使用进程环境中的代理变量，没有环境变量时再读取 macOS `scutil --proxy`，其他情况
 * 保持原来的直连行为。
 */
import { execFileSync } from "node:child_process";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

const nativeFetch = globalThis.fetch;

let sharedProxyAwareFetch: typeof globalThis.fetch | undefined;

/**
 * 进程级共享的代理感知 fetch。首次调用时创建并解析一次环境/系统代理，
 * 之后复用同一份 ProxyAgent 缓存——MCP 市场、技能仓库、插件注册表等
 * 桌面服务都以它为默认 fetcher，避免 Node 原生 fetch 绕过系统代理。
 */
export function getSharedProxyAwareFetch(): typeof globalThis.fetch {
  sharedProxyAwareFetch ??= createProxyAwareFetch();
  return sharedProxyAwareFetch;
}

export interface ProxyFetchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 测试时注入 `scutil --proxy` 输出；生产环境省略后自动读取。 */
  systemProxyOutput?: string;
  baseFetch?: typeof globalThis.fetch;
  /** 仅供单元测试替换独立 undici fetch，生产环境不设置。 */
  proxyFetch?: typeof globalThis.fetch;
}

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy: string[];
  /** System proxy switches are per-scheme; environment proxies retain their fallback. */
  fallbackToOtherScheme?: boolean;
  excludeSimpleHostnames?: boolean;
}

/** 创建一份会自动遵循环境/系统代理的 fetch；显式传入的 baseFetch 用于无代理直连和宿主注入。 */
export function createProxyAwareFetch(options: ProxyFetchOptions = {}): typeof globalThis.fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  const followsGlobalFetch = options.baseFetch === undefined;
  // 测试和宿主可以替换 global fetch；不应把它们误判成需要代理的 Node 原生 fetch。
  if (!followsGlobalFetch && baseFetch !== nativeFetch && options.env === undefined && options.systemProxyOutput === undefined) return baseFetch;
  const settings = resolveProxySettings(options);
  if (!settings) {
    return followsGlobalFetch
      ? async (input, init) => await globalThis.fetch(input, init)
      : baseFetch;
  }

  const agents = new Map<string, ProxyAgent>();
  const proxyFetch = options.proxyFetch ?? (undiciFetch as unknown as typeof globalThis.fetch);
  return async (input, init) => {
    const activeBaseFetch = followsGlobalFetch ? globalThis.fetch : baseFetch;
    if (followsGlobalFetch && activeBaseFetch !== nativeFetch) return await activeBaseFetch(input, init);
    const url = requestUrl(input);
    const proxy = url ? proxyForUrl(url, settings) : undefined;
    const dispatcher = requestDispatcher(init);
    if (!proxy || dispatcher !== undefined) return await activeBaseFetch(input, init);

    let agent = agents.get(proxy);
    if (!agent) {
      try {
        agent = new ProxyAgent(proxy);
      } catch (error) {
        throw new Error("无法初始化配置的 HTTP 代理。", { cause: error });
      }
      agents.set(proxy, agent);
    }

    // Node 原生 fetch 与独立 undici 的 dispatcher 类型/实例不兼容，因此代理请求
    // 使用同一份 undici 的 fetch；无代理请求仍保留宿主传入的原始 fetch。
    return await proxyFetch(input, {
      ...init,
      dispatcher: agent
    } as RequestInit & { dispatcher: Dispatcher }) as Response;
  };
}

/** 解析环境变量，或在 macOS 上读取当前用户的系统代理设置。 */
export function resolveProxySettings(options: ProxyFetchOptions = {}): ProxySettings | undefined {
  const env = options.env ?? process.env;
  const environment = parseEnvironmentProxy(env);
  if (environment) return environment;
  if ((options.platform ?? process.platform) !== "darwin") return undefined;
  const output = options.systemProxyOutput ?? readMacSystemProxy();
  return output ? parseMacSystemProxy(output) : undefined;
}

export function parseMacSystemProxy(output: string): ProxySettings | undefined {
  const values = new Map<string, string>();
  const noProxy: string[] = [];
  let readingExceptions = false;
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ExceptionsList :")) {
      readingExceptions = true;
      continue;
    }
    if (readingExceptions) {
      const exception = /^\d+\s*:\s*(.+)$/u.exec(trimmed)?.[1]?.trim();
      if (exception) {
        noProxy.push(exception);
        continue;
      }
      if (trimmed === "}") readingExceptions = false;
    }
    const entry = /^([A-Za-z]+)\s*:\s*(.+)$/u.exec(trimmed);
    if (entry?.[1] && entry[2]) values.set(entry[1], entry[2].trim());
  }

  const httpProxy = proxyFromScutil(values, "HTTP");
  const httpsProxy = proxyFromScutil(values, "HTTPS");
  const socksProxy = proxyFromScutil(values, "SOCKS");
  if (!httpProxy && !httpsProxy && !socksProxy) return undefined;
  // undici ProxyAgent 只处理 HTTP/HTTPS CONNECT；系统开关保持逐协议生效，
  // SOCKS 仅作为存在性提示，不冒充成可用的 HTTP 代理。
  const excludeSimpleHostnames = Number(values.get("ExcludeSimpleHostnames") ?? 0);
  return { httpProxy, httpsProxy, noProxy, fallbackToOtherScheme: false,
    excludeSimpleHostnames: Number.isFinite(excludeSimpleHostnames) && excludeSimpleHostnames !== 0 };
}

function parseEnvironmentProxy(env: NodeJS.ProcessEnv): ProxySettings | undefined {
  const httpProxy = firstEnvironmentValue(env, ["HTTP_PROXY", "http_proxy"]);
  const httpsProxy = firstEnvironmentValue(env, ["HTTPS_PROXY", "https_proxy"]);
  const allProxy = firstEnvironmentValue(env, ["ALL_PROXY", "all_proxy"]);
  if (!httpProxy && !httpsProxy && !allProxy) return undefined;
  return {
    httpProxy: supportedProxyUrl(httpProxy),
    httpsProxy: supportedProxyUrl(httpsProxy),
    allProxy: supportedProxyUrl(allProxy),
    noProxy: splitNoProxy(firstEnvironmentValue(env, ["NO_PROXY", "no_proxy"]))
  };
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function proxyFromScutil(values: Map<string, string>, prefix: "HTTP" | "HTTPS" | "SOCKS"): string | undefined {
  if (values.get(`${prefix}Enable`) !== "1") return undefined;
  const host = values.get(`${prefix}Proxy`);
  const port = Number(values.get(`${prefix}Port`));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${String(port)}`;
}

function supportedProxyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function splitNoProxy(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function proxyForUrl(url: URL, settings: ProxySettings): string | undefined {
  if (settings.excludeSimpleHostnames && !/[.:]/u.test(url.hostname)) return undefined;
  if (matchesNoProxy(url, settings.noProxy)) return undefined;
  const fallback = settings.fallbackToOtherScheme !== false;
  if (url.protocol === "https:") return settings.httpsProxy ?? (fallback ? settings.httpProxy : undefined) ?? settings.allProxy;
  if (url.protocol === "http:") return settings.httpProxy ?? (fallback ? settings.httpsProxy : undefined) ?? settings.allProxy;
  return undefined;
}

function matchesNoProxy(url: URL, entries: readonly string[]): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return entries.some((rawEntry) => {
    const entry = rawEntry.toLowerCase().trim();
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry === "<local>") return !hostname.includes(".");
    const separator = entry.lastIndexOf(":");
    const hasPort = separator > -1 && !entry.endsWith("]") && /^\d+$/u.test(entry.slice(separator + 1));
    const hostPattern = hasPort ? entry.slice(0, separator) : entry;
    if (hasPort && entry.slice(separator + 1) !== port) return false;
    const normalizedPattern = hostPattern.replace(/^\*\./u, ".");
    return normalizedPattern.startsWith(".")
      ? hostname.endsWith(normalizedPattern) || hostname === normalizedPattern.slice(1)
      : hostname === normalizedPattern;
  });
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

function requestDispatcher(init: RequestInit | undefined): Dispatcher | undefined {
  const dispatcher = (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher;
  return dispatcher && typeof dispatcher === "object" ? dispatcher as Dispatcher : undefined;
}

function readMacSystemProxy(): string | undefined {
  try {
    return execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
}
